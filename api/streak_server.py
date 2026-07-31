#!/usr/bin/env python3
"""Leitor IA - Streak API.
Wrapper simples que pega o user_id da sessão Supabase e chama RPC get_reading_streak.
Roda na porta 9132.
"""
import json
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

def get_user_streak(user_id: str):
    """Chama RPC get_reading_streak no Supabase."""
    payload = json.dumps({'p_user_id': user_id}).encode()
    req = Request(
        f'{SUPABASE_URL}/rest/v1/rpc/get_reading_streak',
        data=payload,
        headers={
            'apikey': SUPABASE_ENV.get('SUPABASE_SERVICE_ROLE', ''),
            'Authorization': f'Bearer {SUPABASE_ENV.get("SUPABASE_SERVICE_ROLE", "")}',
            'Content-Type': 'application/json',
        },
        method='POST',
    )
    with urlopen(req, timeout=15) as r:
        return json.loads(r.read())

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
            self.send_json(200, {'status': 'ok', 'service': 'streak-api', 'port': 9132})
        else:
            self.send_json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/streak':
            return self.send_json(404, {'error': 'not found'})
        try:
            n = int(self.headers.get('Content-Length', '0'))
            data = json.loads(self.rfile.read(n)) if n else {}
            user_id = data.get('user_id') or ''
            if not user_id:
                return self.send_json(400, {'error': 'user_id obrigatório'})
            result = get_user_streak(user_id)
            # result é uma lista com 1 row — pega a primeira
            row = result[0] if result else {}
            self.send_json(200, {
                'current_streak': row.get('current_streak', 0),
                'best_streak': row.get('best_streak', 0),
                'last_read_date': row.get('last_read_date'),
                'days_with_progress': row.get('days_with_progress', 0),
            })
        except Exception as e:
            self.send_json(500, {'error': str(e)[:500]})

if __name__ == '__main__':
    print('Leitor IA Streak API: porta 9132', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 9132), Handler).serve_forever()