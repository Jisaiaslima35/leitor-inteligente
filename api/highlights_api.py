#!/usr/bin/env python3
"""Leitor IA - Highlights API.

Grifos e anotações do leitor sobre o PDF. Sublinha trecho + nota opcional.
Aproveita textLayer do pdfjs-dist: start_idx/end_idx = índices de palavras
no textContent da página (mais zoom-safe que bbox).

Rotas:
- GET  /health                              → 200
- GET  /highlights?book_slug=X&page=N       → lista grifos do user nessa página
- GET  /highlights/all?book_slug=X          → TODOS os grifos do livro (lista consolidada)
- POST /highlights                          → body {book_slug, page_number, start_idx, end_idx, selected_text, color}
                                              → INSERT, retorna {id, created_at}
- PATCH /highlights/{id}                    → body {note_text?, color?}
                                              → UPDATE (bumped updated_at)
- DELETE /highlights/{id}                   → remove

Porta: 9143 (não toca server.py:9130 / signed-url:9133 / quiz:3021 / checklist:9142).
"""
from __future__ import annotations

import base64
import json
import urllib.parse
from datetime import datetime, timezone
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

PORT = 9143
ALLOWED_COLORS = {'yellow', 'green', 'blue', 'pink'}


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
        sub = payload.get('sub')
        # Validação rápida: sub DEVE ser UUID (formato canônico Supabase Auth).
        # Se não for, o token é falso/inválido e mandar pro Supabase só
        # desperdiça 1 round-trip com erro confuso.
        if not sub or not isinstance(sub, str) or len(sub) != 36 or sub.count('-') != 4:
            return None
        return sub
    except Exception:
        return None


def parse_highlight_id(path: str) -> str | None:
    """Extrai UUID do /highlights/{id}."""
    parts = path.strip('/').split('/')
    if len(parts) >= 2 and parts[0] == 'highlights' and parts[1]:
        return parts[1]
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        # Log compacto pra cada request — ajuda debugar fluxo.
        try:
            print(f'[REQ] {self.command} {self.path} from {self.client_address[0]}', flush=True)
        except Exception:
            pass

    def send_json(self, code: int, obj):
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
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
        self.end_headers()

    def _require_user(self) -> tuple[bool, str | None]:
        auth = self.headers.get('Authorization', '')
        user_id = resolve_user_id(auth)
        if not user_id:
            self.send_json(401, {'ok': False, 'error': 'Não autorizado'})
            return False, None
        return True, user_id

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/health':
            return self.send_json(200, {
                'ok': True,
                'service': 'highlights-api',
                'port': PORT,
                'ts': datetime.now(timezone.utc).isoformat(),
            })

        if parsed.path == '/highlights' or parsed.path == '/highlights/all':
            ok, user_id = self._require_user()
            if not ok:
                return

            qs = urllib.parse.parse_qs(parsed.query)
            book_slug = (qs.get('book_slug') or [''])[0].strip()
            if not book_slug:
                return self.send_json(400, {'ok': False, 'error': 'book_slug obrigatório'})

            # /highlights (com ?page=N) filtra por página; /highlights/all retorna tudo do livro
            path = (
                f'/rest/v1/highlights'
                f'?user_id=eq.{user_id}'
                f'&book_slug=eq.{urllib.parse.quote(book_slug, safe="")}'
                f'&order=page_number.asc,start_idx.asc'
                f'&select=id,page_number,start_idx,end_idx,selected_text,color,note_text,created_at,updated_at'
            )
            if parsed.path == '/highlights':
                page_str = (qs.get('page') or [''])[0].strip()
                if not page_str:
                    return self.send_json(400, {'ok': False, 'error': 'page obrigatório em /highlights'})
                try:
                    page_num = int(page_str)
                except ValueError:
                    return self.send_json(400, {'ok': False, 'error': 'page inválido'})
                path += f'&page_number=eq.{page_num}'

            status, body = _supabase_request('GET', path)
            if status != 200:
                return self.send_json(502, {'ok': False, 'error': f'Supabase HTTP {status}', 'detail': body[:200]})
            items = json.loads(body) if body else []
            return self.send_json(200, {'ok': True, 'items': items, 'count': len(items)})

        return self.send_json(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        if self.path != '/highlights':
            return self.send_json(404, {'ok': False, 'error': 'not found'})

        ok, user_id = self._require_user()
        if not ok:
            return

        n = int(self.headers.get('Content-Length', '0'))
        try:
            data = json.loads(self.rfile.read(n)) if n else {}
        except Exception:
            return self.send_json(400, {'ok': False, 'error': 'JSON inválido'})

        book_slug = (data.get('book_slug') or '').strip()
        page_number = data.get('page_number')
        start_idx = data.get('start_idx')
        end_idx = data.get('end_idx')
        selected_text = (data.get('selected_text') or '').strip()
        color = (data.get('color') or 'yellow').strip()

        # 04/09/2026: sanitizar caracteres de controle que o Postgres/TEXTO
        # rejeita (NUL  principalmente — pdfjs às vezes injeta bytes NUL
        # quando o PDF tem fontes com encoding quebrado). Mantém \t \n \r.
        if selected_text:
            cleaned = ''.join(
                c for c in selected_text
                if c == '\t' or c == '\n' or c == '\r' or c >= ' '
            )
            if cleaned != selected_text:
                print(f'[HIGHLIGHTS POST] sanitizado NUL/controles '
                      f'(removidos {len(selected_text) - len(cleaned)} chars)', flush=True)
            selected_text = cleaned

        if not book_slug:
            return self.send_json(400, {'ok': False, 'error': 'book_slug obrigatório'})
        if not isinstance(page_number, int) or page_number < 1:
            return self.send_json(400, {'ok': False, 'error': 'page_number inválido'})
        if not isinstance(start_idx, int) or start_idx < 0:
            return self.send_json(400, {'ok': False, 'error': 'start_idx inválido'})
        if not isinstance(end_idx, int) or end_idx < start_idx:
            return self.send_json(400, {'ok': False, 'error': 'end_idx deve ser >= start_idx'})
        if not selected_text:
            return self.send_json(400, {'ok': False, 'error': 'selected_text vazio'})
        if color not in ALLOWED_COLORS:
            return self.send_json(400, {'ok': False, 'error': f'color deve ser um de {sorted(ALLOWED_COLORS)}'})

        payload = {
            'user_id': user_id,
            'book_slug': book_slug,
            'page_number': page_number,
            'start_idx': start_idx,
            'end_idx': end_idx,
            'selected_text': selected_text[:4000],  # cap pra não estourar
            'color': color,
            'note_text': None,
        }

        # DEBUG 04/09/2026: capturar o que tá indo pro Supabase (causa do 502)
        print(f'[HIGHLIGHTS POST] user_id={user_id!r} slug={book_slug!r} page={page_number} '
              f'idx=[{start_idx},{end_idx}] color={color} text_len={len(selected_text[:4000])}', flush=True)
        print(f'[HIGHLIGHTS POST] payload={payload}', flush=True)

        status, body = _supabase_request(
            'POST',
            '/rest/v1/highlights',
            body=payload,
            prefer='return=representation',
        )
        if status not in (200, 201):
            print(f'[HIGHLIGHTS POST] Supabase erro {status}: {body[:500]}', flush=True)
            # Repassar status apropriado em vez do catch-all 502 confuso
            if status in (401, 403):
                return self.send_json(401, {'ok': False, 'error': 'Sessão inválida ou sem permissão', 'detail': body[:300]})
            if status in (400, 422):
                return self.send_json(400, {'ok': False, 'error': f'Supabase rejeitou o payload (HTTP {status})', 'detail': body[:500]})
            # 5xx do Supabase → upstream error
            return self.send_json(502, {'ok': False, 'error': f'Supabase HTTP {status}', 'detail': body[:300]})

        inserted = json.loads(body)[0] if body else {}
        print(f'[HIGHLIGHTS POST] OK id={inserted.get("id")}', flush=True)
        return self.send_json(200, {
            'ok': True,
            'id': inserted.get('id'),
            'created_at': inserted.get('created_at'),
        })

    def do_PATCH(self):
        hid = parse_highlight_id(self.path)
        if not hid:
            return self.send_json(404, {'ok': False, 'error': 'id obrigatório'})

        ok, user_id = self._require_user()
        if not ok:
            return

        n = int(self.headers.get('Content-Length', '0'))
        try:
            data = json.loads(self.rfile.read(n)) if n else {}
        except Exception:
            return self.send_json(400, {'ok': False, 'error': 'JSON inválido'})

        patch = {}
        if 'note_text' in data:
            patch['note_text'] = (data.get('note_text') or '').strip() or None
        if 'color' in data:
            c = (data.get('color') or '').strip()
            if c not in ALLOWED_COLORS:
                return self.send_json(400, {'ok': False, 'error': f'color inválido'})
            patch['color'] = c
        if not patch:
            return self.send_json(400, {'ok': False, 'error': 'nenhum campo pra atualizar'})

        patch['updated_at'] = datetime.now(timezone.utc).isoformat()

        # Filtra por id + user_id (segurança: user não apaga grifo dos outros)
        path = (
            f'/rest/v1/highlights'
            f'?id=eq.{hid}&user_id=eq.{user_id}'
        )
        status, body = _supabase_request('PATCH', path, body=patch, prefer='return=representation')
        if status not in (200, 201):
            return self.send_json(502, {'ok': False, 'error': f'Supabase HTTP {status}', 'detail': body[:300]})
        rows = json.loads(body) if body else []
        if not rows:
            return self.send_json(404, {'ok': False, 'error': 'grifo não encontrado'})
        return self.send_json(200, {'ok': True, 'updated': rows[0]})

    def do_DELETE(self):
        hid = parse_highlight_id(self.path)
        if not hid:
            return self.send_json(404, {'ok': False, 'error': 'id obrigatório'})

        ok, user_id = self._require_user()
        if not ok:
            return

        path = f'/rest/v1/highlights?id=eq.{hid}&user_id=eq.{user_id}'
        status, body = _supabase_request('DELETE', path)
        if status not in (200, 204):
            return self.send_json(502, {'ok': False, 'error': f'Supabase HTTP {status}', 'detail': body[:300]})
        return self.send_json(200, {'ok': True, 'deleted_id': hid})


if __name__ == '__main__':
    print(f'Highlights API: porta {PORT}, supabase={SUPABASE_URL[:40]}', flush=True)
    if not SUPABASE_SR:
        print('AVISO: SUPABASE_SERVICE_ROLE vazia — endpoints vão falhar 500', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
