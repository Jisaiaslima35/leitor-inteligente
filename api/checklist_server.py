#!/usr/bin/env python3
"""Leitor IA - Checklist API.

Marca/desmarca itens do checklist por capítulo/página do Modo Mentor.
Tabela: chapter_progress (user_id, book_slug, chapter_id, item_id, completed_at)
PK composta → UPSERT idempotente, suporta cliques rápidos sem duplicar linha.

Rotas:
- GET  /health                       → 200 sempre
- POST /checklist/toggle             → body: {book_slug, chapter_id, item_id, completed}
                                     → header: Authorization: Bearer <jwt>
                                     → UPSERT (se completed=true) ou DELETE (se false)
- GET  /checklist/progress?book_slug=X&chapter_id=Y
                                     → header: Authorization: Bearer <jwt>
                                     → lista itens concluídos pelo user nesse capítulo

Porta: 9142 (não toca server.py:9130 / signed-url-api:9133 / quiz:3021).
Docker-proxy antigo ocupa 9140/9141 → evitar essas portas.
"""
from __future__ import annotations

import base64
import json
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

# --- Config: carrega do cofre ---
SUPABASE_ENV = {}
for line in Path('/root/.hermes/secrets/leitor-supabase.env').read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        SUPABASE_ENV[line.split('=', 1)[0]] = line.split('=', 1)[1]

SUPABASE_URL = SUPABASE_ENV.get('SUPABASE_URL', '').rstrip('/')
SUPABASE_SR = SUPABASE_ENV.get('SUPABASE_SERVICE_ROLE', '')

PORT = 9142


def _supabase_request(method: str, path: str, body: dict | None = None,
                       prefer: str | None = None) -> tuple[int, str]:
    """Wrapper único pra Supabase REST. Retorna (status, body_text)."""
    h = {
        'apikey': SUPABASE_SR,
        'Authorization': f'Bearer {SUPABASE_SR}',
        'Content-Type': 'application/json',
    }
    if prefer:
        h['Prefer'] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = Request(f'{SUPABASE_URL}{path}', data=data, headers=h, method=method)
    try:
        with urlopen(req, timeout=10) as r:
            return r.status, r.read().decode('utf-8')
    except Exception as e:
        if hasattr(e, 'code'):
            try:
                return e.code, e.read().decode('utf-8')
            except Exception:
                return 500, str(e)[:300]
        return 502, str(e)[:300]


def resolve_user_id(auth_header: str) -> str | None:
    """Decodifica user_id do JWT Supabase (anon JWT é só base64)."""
    if not auth_header or not auth_header.startswith('Bearer '):
        return None
    token = auth_header[7:].strip()
    parts = token.split('.')
    if len(parts) != 3:
        return None
    try:
        payload_b64 = parts[1] + '=' * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        return payload.get('sub')
    except Exception:
        return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, code: int, obj: dict):
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
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/health':
            return self.send_json(200, {
                'ok': True,
                'service': 'checklist-api',
                'port': PORT,
                'ts': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
            })

        if parsed.path == '/checklist/progress':
            auth = self.headers.get('Authorization', '')
            user_id = resolve_user_id(auth)
            if not user_id:
                return self.send_json(401, {'ok': False, 'error': 'Não autorizado'})

            qs = urllib.parse.parse_qs(parsed.query)
            book_slug = (qs.get('book_slug') or [''])[0].strip()
            chapter_id = (qs.get('chapter_id') or [''])[0].strip()
            if not book_slug or not chapter_id:
                return self.send_json(400, {'ok': False, 'error': 'book_slug e chapter_id obrigatórios'})

            path = (f'/rest/v1/chapter_progress'
                    f'?user_id=eq.{user_id}'
                    f'&book_slug=eq.{urllib.parse.quote(book_slug, safe="")}'
                    f'&chapter_id=eq.{urllib.parse.quote(chapter_id, safe="")}'
                    f'&select=item_id,completed_at')
            status, body = _supabase_request('GET', path)
            if status != 200:
                return self.send_json(502, {'ok': False, 'error': f'Supabase HTTP {status}', 'detail': body[:200]})

            items = json.loads(body) if body else []
            return self.send_json(200, {
                'ok': True,
                'items': items,
                'completed_count': len(items),
            })

        return self.send_json(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        if self.path != '/checklist/toggle':
            return self.send_json(404, {'ok': False, 'error': 'not found'})

        auth = self.headers.get('Authorization', '')
        user_id = resolve_user_id(auth)
        if not user_id:
            return self.send_json(401, {'ok': False, 'error': 'Não autorizado'})

        n = int(self.headers.get('Content-Length', '0'))
        try:
            data = json.loads(self.rfile.read(n)) if n else {}
        except Exception:
            return self.send_json(400, {'ok': False, 'error': 'JSON inválido'})

        book_slug = (data.get('book_slug') or '').strip()
        chapter_id = (data.get('chapter_id') or '').strip()
        item_id = (data.get('item_id') or '').strip()
        completed = bool(data.get('completed', True))

        if not book_slug or not chapter_id or not item_id:
            return self.send_json(400, {'ok': False, 'error': 'book_slug, chapter_id e item_id obrigatórios'})

        if completed:
            # UPSERT — composite PK garante idempotência
            payload = {
                'user_id': user_id,
                'book_slug': book_slug,
                'chapter_id': chapter_id,
                'item_id': item_id,
                # completed_at tem DEFAULT NOW() — não precisa setar
            }
            # Precisa passar ?columns pra PostgREST entender o payload com todas as PK
            status, body = _supabase_request(
                'POST',
                '/rest/v1/chapter_progress',
                body=payload,
                prefer='resolution=ignore-duplicates,return=minimal',
            )
            if status not in (200, 201):
                return self.send_json(502, {'ok': False, 'error': f'Supabase HTTP {status}', 'detail': body[:200]})
            return self.send_json(200, {'ok': True, 'action': 'completed', 'item_id': item_id})
        else:
            # DELETE — remove a linha
            qs = (f'?user_id=eq.{user_id}'
                  f'&book_slug=eq.{urllib.parse.quote(book_slug, safe="")}'
                  f'&chapter_id=eq.{urllib.parse.quote(chapter_id, safe="")}'
                  f'&item_id=eq.{urllib.parse.quote(item_id, safe="")}')
            status, body = _supabase_request('DELETE', f'/rest/v1/chapter_progress{qs}')
            if status not in (200, 204):
                return self.send_json(502, {'ok': False, 'error': f'Supabase HTTP {status}', 'detail': body[:200]})
            return self.send_json(200, {'ok': True, 'action': 'uncompleted', 'item_id': item_id})


if __name__ == '__main__':
    print(f'Checklist API: porta {PORT}, supabase={SUPABASE_URL[:40]}', flush=True)
    if not SUPABASE_SR:
        print('AVISO: SUPABASE_SERVICE_ROLE vazia — endpoints vão falhar 500', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
