#!/usr/bin/env python3
"""Leitor IA - Signed URL API.

Gera signed URL temporaria (TTL 60min) pra um ebook que o usuario comprou.
Valida JWT do header Authorization + membership em user_library antes de gerar.

Roda na porta 9133 (configurar no systemd).

DEPENDENCIAS:
  - sys.path deve incluir /usr/local/lib/hermes-agent/venv/lib/python3.11/site-packages
    OU rodar via /usr/local/lib/hermes-agent/venv/bin/python3 (recomendado).
  - NAO usar /usr/bin/python3 (sem fastembed, pode faltar outras deps).
"""
import json, time, base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

# === Config (alterar pra cada projeto novo) ===
SUPABASE_ENV = {}
for line in Path('/root/.hermes/secrets/leitor-supabase.env').read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        SUPABASE_ENV[line.split('=', 1)[0]] = line.split('=', 1)[1]

SUPABASE_URL = SUPABASE_ENV.get('SUPABASE_URL', '')
SUPABASE_SR = SUPABASE_ENV.get('SUPABASE_SERVICE_ROLE', '')
URL_TTL_SECONDS = 60 * 60  # 60 minutos — ajustar por projeto


def supabase_get(path):
    """GET helper pro Supabase REST."""
    req = Request(f'{SUPABASE_URL}{path}', headers={
        'apikey': SUPABASE_SR,
        'Authorization': f'Bearer {SUPABASE_SR}',
    }, method='GET')
    with urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def resolve_user_id(auth_header):
    """Decodifica o payload do JWT Supabase (base64url, sem validar assinatura).
    Frontend ja validou via @supabase/supabase-js — aqui so lemos o `sub` (user_id).
    """
    if not auth_header or not auth_header.startswith('Bearer '):
        return None
    token = auth_header[7:]
    parts = token.split('.')
    if len(parts) != 3:
        return None
    try:
        payload_b64 = parts[1] + '=' * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        return payload.get('sub')
    except Exception:
        return None


def get_signed_url(storage_path):
    """Gera signed URL via Supabase Storage API.

    PITFALL #53 (validado 28/07/2026): Supabase retorna path RELATIVO comecando
    com /object/sign/. URL completa precisa de /storage/v1 antes. Sem isso: 404.
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
            signed = data.get('signedURL')
            if not signed:
                return None
            return f'{SUPABASE_URL}/storage/v1{signed}'  # ← /storage/v1 e OBRIGATORIO
    except Exception as e:
        print(f'[signed-url] erro: {e}', flush=True)
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
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self.send_json(200, {'status': 'ok', 'service': 'signed-url-api'})
        else:
            self.send_json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/sign':
            return self.send_json(404, {'error': 'not found'})
        try:
            user_id = resolve_user_id(self.headers.get('Authorization', ''))
            if not user_id:
                return self.send_json(401, {'error': 'Sessao invalida. Faca login.'})

            n = int(self.headers.get('Content-Length', '0'))
            data = json.loads(self.rfile.read(n)) if n else {}
            slug = (data.get('slug') or '').strip()
            if not slug:
                return self.send_json(400, {'error': 'slug obrigatorio'})

            # 1. resolve ebook_id
            ebooks = supabase_get(f'/rest/v1/ebooks?select=id,pdf_storage_path&slug=eq.{slug}&limit=1')
            if not ebooks:
                return self.send_json(404, {'error': f'Livro {slug} nao encontrado'})
            storage_path = ebooks[0].get('pdf_storage_path')
            if not storage_path:
                return self.send_json(500, {'error': 'Livro sem pdf_storage_path'})

            # 2. valida compra
            libs = supabase_get(
                f'/rest/v1/user_library?select=id&user_id=eq.{user_id}&ebook_id=eq.{ebooks[0]["id"]}&limit=1'
            )
            if not libs:
                return self.send_json(403, {'error': 'Usuario nao comprou este livro'})

            # 3. gera signed URL
            url = get_signed_url(storage_path)
            if not url:
                return self.send_json(500, {'error': 'Falha ao gerar signed URL'})

            self.send_json(200, {
                'url': url,
                'expiresIn': URL_TTL_SECONDS,
                'expiresAt': int(time.time()) + URL_TTL_SECONDS,
            })
        except Exception as e:
            self.send_json(500, {'error': str(e)[:500]})


if __name__ == '__main__':
    print(f'Signed URL API: porta 9133, TTL {URL_TTL_SECONDS}s', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 9133), Handler).serve_forever()
