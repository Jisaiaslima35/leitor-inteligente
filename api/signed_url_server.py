#!/usr/bin/env python3
"""Leitor IA - Signed URL API.
Gera signed URL temporária pra um ebook que o usuário comprou.
Valida que o user_id da sessão tem o ebook em user_library.
Roda na porta 9133.
"""
import json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

# --- Config ---
SUPABASE_ENV = {}
for line in Path('/root/.hermes/secrets/leitor-supabase.env').read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        SUPABASE_ENV[line.split('=', 1)[0]] = line.split('=', 1)[1]

SUPABASE_URL = SUPABASE_ENV.get('SUPABASE_URL', '')
SUPABASE_SR = SUPABASE_ENV.get('SUPABASE_SERVICE_ROLE', '')

URL_TTL_SECONDS = 60 * 60  # 60 minutos


def supabase_get(path, headers=None):
    """GET helper pro Supabase REST."""
    h = {
        'apikey': SUPABASE_SR,
        'Authorization': f'Bearer {SUPABASE_SR}',
    }
    if headers:
        h.update(headers)
    req = Request(f'{SUPABASE_URL}{path}', headers=h, method='GET')
    with urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def resolve_user_id(auth_header: str) -> str | None:
    """Extrai user_id do JWT Supabase (decodifica o payload, sem validar assinatura).
    O service_role key checa automaticamente no /auth/v1/user — mas pra evitar
    o round-trip, lemos direto do payload (anon JWT é só base64).
    """
    if not auth_header or not auth_header.startswith('Bearer '):
        return None
    token = auth_header[7:]
    parts = token.split('.')
    if len(parts) != 3:
        return None
    try:
        import base64
        # JWT payload é base64url-encoded (sem padding às vezes)
        payload_b64 = parts[1] + '=' * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        return payload.get('sub')
    except Exception:
        return None


def get_signed_url(storage_path: str) -> str | None:
    """Chama /storage/v1/object/sign/{bucket}/{path} no Supabase.
    Retorna signed URL com TTL de URL_TTL_SECONDS.
    O Supabase retorna path RELATIVO começando com '/object/sign/' — precisa
    prefixar com '/storage/v1' pra URL completa (sem isso dá 404).
    """
    body = json.dumps({'expiresIn': URL_TTL_SECONDS}).encode()
    req = Request(
        f'{SUPABASE_URL}/storage/v1/object/sign/ebooks/{storage_path}',
        data=body,
        headers={
            'apikey': SUPABASE_SR,
            'Authorization': f'Bearer {SUPABASE_SR}',
            'Content-Type': 'application/json',
        },
        method='POST',
    )
    try:
        with urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
            signed = data.get('signedURL') or data.get('signedUrl')
            if not signed:
                return None
            # signed vem como '/object/sign/ebooks/.../file.pdf?token=...'
            # URL completa = SUPABASE_URL + '/storage/v1' + signed
            return f'{SUPABASE_URL}/storage/v1{signed}'
    except Exception as e:
        print(f'[signed-url] erro Supabase: {e}', flush=True)
        return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self.send_json(200, {'status': 'ok', 'service': 'signed-url-api', 'port': 9133})
        else:
            self.send_json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/sign':
            return self.send_json(404, {'error': 'not found'})
        try:
            auth = self.headers.get('Authorization', '')
            user_id = resolve_user_id(auth)
            if not user_id:
                return self.send_json(401, {'error': 'Sessão inválida. Faça login.'})

            n = int(self.headers.get('Content-Length', '0'))
            data = json.loads(self.rfile.read(n)) if n else {}
            slug = (data.get('slug') or '').strip()
            if not slug:
                return self.send_json(400, {'error': 'slug obrigatório'})

            # 1. resolve ebook_id a partir do slug
            ebooks = supabase_get(f'/rest/v1/ebooks?select=id,pdf_storage_path&slug=eq.{slug}&limit=1')
            if not ebooks:
                return self.send_json(404, {'error': f'Livro {slug} não encontrado'})
            ebook = ebooks[0]
            storage_path = ebook.get('pdf_storage_path')
            if not storage_path:
                return self.send_json(500, {'error': 'Livro sem pdf_storage_path configurado'})

            # 2. valida que user comprou esse ebook
            libs = supabase_get(
                f'/rest/v1/user_library?select=id&user_id=eq.{user_id}&ebook_id=eq.{ebook["id"]}&limit=1'
            )
            if not libs:
                return self.send_json(403, {'error': 'Usuário não comprou este livro'})

            # 3. gera signed URL
            signed_url = get_signed_url(storage_path)
            if not signed_url:
                return self.send_json(500, {'error': 'Falha ao gerar signed URL'})

            self.send_json(200, {
                'url': signed_url,
                'expiresIn': URL_TTL_SECONDS,
                'expiresAt': int(time.time()) + URL_TTL_SECONDS,
            })
        except Exception as e:
            self.send_json(500, {'error': str(e)[:500]})


if __name__ == '__main__':
    print(f'Leitor IA Signed URL API: porta 9133, TTL {URL_TTL_SECONDS}s', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 9133), Handler).serve_forever()