#!/usr/bin/env python3
# terminal_server.py — WebSocket gateway pro Piston /api/v2/connect.
# ISAÍAS 24/08/2026: terminal interativo da Sala Dev.
#
# Arquitetura (Isaías decidiu após análise no Telegram):
#
#   Navegador ──WS──> terminal_server.py:2005 ──WS──> Piston 127.0.0.1:2000
#                          │                                (interno, nunca
#                          │                                 exposto)
#                          │
#                          └─ valida: JWT Supabase + categoria programacao
#                                    + tamanho código ≤ 5000 chars
#                                    + rate limit 1 conexão nova/2s/IP
#
# NÃO USA FLASK/DEV_SERVER. Servidor Python puro asyncio + lib `websockets`
# 10.4 (já instalada no venv). Roda em porta própria (default 2005). Nginx faz
# proxy reverso com headers WebSocket.
#
# INTOCADO: dev_server.py continua rodando /exec HTTP como antes. Se
# terminal_server falhar/crashar, o /exec HTTP mantém a Sala Dev funcional.
#
# Protocolo Piston /api/v2/connect (extraído do repo engineer-man/piston):
#   Browser → Server:
#     {"type":"init","language":"python","version":"3.11.0",
#      "files":[{"content":"..."}],"run_timeout":5000}
#     {"type":"data","stream":"stdin","data":"linha\n"}
#     {"type":"signal","signal":"SIGKILL"}
#   Server → Browser:
#     {"type":"runtime","language":"...","version":"..."}
#     {"type":"stage","stage":"run"}
#     {"type":"data","stream":"stdout","data":"..."}   ← ou stderr
#     {"type":"exit","stage":"run","code":0,"signal":null}
#     {"type":"error","message":"..."}                   ← fecha conexão
#
# Limites:
#   - código máx 5000 chars (igual /exec)
#   - rate limit 1 nova conexão/2s por IP
#   - idle timeout 2 min sem stdin (aluno abandonou)
#   - ping/pong a cada 30s pra detectar socket zumbi
#   - log por conexão em /var/log/leitor-terminal/terminal.log

import asyncio
import base64
import json
import logging
import os
import sys
import time
import threading
from collections import defaultdict
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

import websockets
from websockets.exceptions import ConnectionClosed

# ─── Configuração ────────────────────────────────────────────────────────
TERMINAL_PORT = int(os.environ.get('TERMINAL_PORT', '2005'))
TERMINAL_HOST = os.environ.get('TERMINAL_HOST', '127.0.0.1')
PISTON_WS_URL = os.environ.get('PISTON_WS_URL', 'ws://127.0.0.1:2000/api/v2/connect')
PISTON_HTTP_URL = os.environ.get('PISTON_URL', 'http://127.0.0.1:2000/api/v2')
MAX_CODE_CHARS = 5000
PISTON_TIMEOUT_MS = 300_000      # 5min — sessão interativa, aluno lê/digita
PISTON_COMPILE_TIMEOUT_MS = 10_000  # 10s — compila rápidos (C/Rust)
RATE_LIMIT_INTERVAL_S = 2.0
IDLE_TIMEOUT_S = 120             # 2min — aluno abandonou → fecha
PING_INTERVAL_S = 30
LOG_DIR = '/var/log/leitor-terminal'

# Mesmo map de linguagem que dev_server.py — duplicado aqui pq dev_server é
# threadpool e WS não compartilha estado facilmente. Se divergir, o pior que
# acontece é erro "linguagem não suportada" na execução.
LANG_MAP = {
    'python':     ('python', '3.11.0'),
    'python3':    ('python', '3.11.0'),
    'javascript': ('javascript', '20.11.1'),
    'js':         ('javascript', '20.11.1'),
    'node':       ('javascript', '20.11.1'),
    'php':        ('php', '8.2.3'),
}

# ─── Supabase (carrega de /root/.hermes/secrets/leitor-supabase.env) ─────
SUPABASE_ENV = {}
_secrets_path = Path('/root/.hermes/secrets/leitor-supabase.env')
if _secrets_path.exists():
    for line in _secrets_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            SUPABASE_ENV[line.split('=', 1)[0]] = line.split('=', 1)[1]
SUPABASE_URL = SUPABASE_ENV.get('SUPABASE_URL', '')
SUPABASE_SR = SUPABASE_ENV.get('SUPABASE_SERVICE_ROLE', '')

# ─── Rate limit (thread-safety pro loop asyncio) ────────────────────────
_rate_lock = threading.Lock()
_last_conn_ts = defaultdict(float)


def rate_limit_ok(ip: str) -> bool:
    """True se pode aceitar nova conexão deste IP. 1 a cada 2s."""
    with _rate_lock:
        now = time.time()
        last = _last_conn_ts[ip]
        if now - last < RATE_LIMIT_INTERVAL_S:
            return False
        _last_conn_ts[ip] = now
        return True


# ─── Logging ─────────────────────────────────────────────────────────────
# Padrão: /var/log/leitor-terminal/terminal.log
# Fallback (sem permissão em /var/log): ./api/terminal.log no próprio projeto.
try:
    os.makedirs(LOG_DIR, exist_ok=True)
    log_path = os.path.join(LOG_DIR, 'terminal.log')
except (PermissionError, OSError):
    LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'logs')
    os.makedirs(LOG_DIR, exist_ok=True)
    log_path = os.path.join(LOG_DIR, 'terminal.log')

log = logging.getLogger('terminal')
log.setLevel(logging.INFO)
_h = logging.FileHandler(log_path)
_h.setFormatter(logging.Formatter(
    '%(asctime)s %(levelname)-5s %(message)s'
))
log.addHandler(_h)
# também joga pra stderr pra journalctl ver
_sh = logging.StreamHandler(sys.stderr)
_sh.setFormatter(logging.Formatter('%(levelname)s %(message)s'))
log.addHandler(_sh)


# ─── Validação JWT Supabase ─────────────────────────────────────────────
def extract_user_id_from_jwt(token: str) -> str | None:
    """Decodifica payload do JWT Supabase (sem validar assinatura — o proxy
    reverso do Nginx + CORS + service_role auth abaixo confirmam origem).
    Retorna o `sub` (user UUID) ou None se inválido."""
    if not token or token.count('.') != 2:
        return None
    try:
        payload_b64 = token.split('.')[1]
        payload_b64 += '=' * (-len(payload_b64) % 4)  # padding
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        sub = payload.get('sub')
        # Supabase tokens têm exp em segundos epoch
        if payload.get('exp', 0) < time.time() - 60:
            return None
        return sub if sub else None
    except Exception:
        return None


async def get_book_categoria(slug: str) -> str | None:
    """Busca categoria do ebook no Supabase via service_role."""
    if not SUPABASE_URL or not SUPABASE_SR or not slug:
        return None
    def _do():
        try:
            req = Request(
                f'{SUPABASE_URL}/rest/v1/ebooks?slug=eq.{slug}&select=categoria',
                headers={
                    'apikey': SUPABASE_SR,
                    'Authorization': f'Bearer {SUPABASE_SR}',
                },
            )
            with urlopen(req, timeout=10) as r:
                rows = json.loads(r.read())
                return rows[0]['categoria'] if rows else None
        except (HTTPError, URLError, KeyError, IndexError, ValueError) as e:
            log.warning(f'supabase categoria lookup falhou slug={slug}: {e}')
            return None
    return await asyncio.get_event_loop().run_in_executor(None, _do)


# ─── Handler de uma conexão ─────────────────────────────────────────────
async def handle_browser(ws):
    """Uma sessão WS: browser <-> terminal_server <-> Piston."""
    ip = ws.remote_address[0] if ws.remote_address else 'unknown'
    user_id = '-'
    book_slug = '-'
    log.info(f'OPEN {ip}')

    piston_ws = None
    to_browser_from_piston = None
    to_piston_from_browser = None

    try:
        # 1) Espera msg `init` num prazo razoável
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
        except asyncio.TimeoutError:
            await ws.close(code=4408, reason='init timeout')
            log.warning(f'INIT timeout {ip}')
            return
        try:
            msg = json.loads(raw)
        except (ValueError, TypeError):
            await ws.close(code=4400, reason='json inválido')
            log.warning(f'JSON inválido {ip}: {raw[:100]!r}')
            return
        if msg.get('type') != 'init':
            await ws.close(code=4400, reason='primeira msg deve ser init')
            log.warning(f'primeira msg != init {ip}: {msg.get("type")}')
            return

        # 2) Rate limit por IP
        if not rate_limit_ok(ip):
            await ws.close(code=4429, reason='rate limit')
            log.info(f'RATE_LIMIT {ip}')
            return

        # 3) Valida JWT e extrai user_id
        token = msg.get('token', '')
        user_id = extract_user_id_from_jwt(token) or '-'
        if user_id == '-':
            await ws.close(code=4401, reason='token inválido/expirado')
            log.info(f'JWT_INVALID {ip}')
            return

        # 4) Valida categoria do livro == 'programacao'
        book_slug = msg.get('slug', '').strip()[:120]
        if not book_slug:
            await ws.close(code=4400, reason='slug faltando')
            return
        categoria = await get_book_categoria(book_slug)
        if categoria != 'programacao':
            await ws.close(code=4403, reason=f'categoria={categoria}')
            log.info(f'CATEGORIA_BLOQUEADA {ip} user={user_id[:8]} slug={book_slug} cat={categoria}')
            return

        # 5) Valida linguagem e tamanho do código
        lang_key = msg.get('language', '').lower().strip()
        if lang_key not in LANG_MAP:
            await ws.close(code=4400, reason=f'linguagem {lang_key!r} não suportada')
            return
        lang, version = LANG_MAP[lang_key]
        code = msg.get('code', '')
        if not isinstance(code, str) or len(code) > MAX_CODE_CHARS:
            await ws.close(code=4413, reason=f'código > {MAX_CODE_CHARS} chars')
            return

        # 6) Conecta no Piston WS (INTERNO, 127.0.0.1:2000)
        try:
            piston_ws = await asyncio.wait_for(
                websockets.connect(PISTON_WS_URL, max_size=2**20, ping_interval=None),
                timeout=5.0,
            )
        except (asyncio.TimeoutError, OSError) as e:
            await ws.close(code=4503, reason=f'piston down: {e}')
            log.error(f'PISTON_DOWN {ip}: {e}')
            return

        # 7) Manda init pro Piston
        piston_init = {
            'type': 'init',
            'language': lang,
            'version': version,
            'files': [{'content': code}],
            'run_timeout': PISTON_TIMEOUT_MS,
            'compile_timeout': PISTON_COMPILE_TIMEOUT_MS,
        }
        await piston_ws.send(json.dumps(piston_init))
        log.info(
            f'RUN {ip} user={user_id[:8]} slug={book_slug} lang={lang} '
            f'code_len={len(code)}'
        )

        # 8) Relay bidirecional
        to_browser_from_piston = asyncio.create_task(
            relay_piston_to_browser(piston_ws, ws)
        )
        to_piston_from_browser = asyncio.create_task(
            relay_browser_to_piston(ws, piston_ws)
        )
        done, pending = await asyncio.wait(
            [to_browser_from_piston, to_piston_from_browser],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in pending:
            t.cancel()
            try:
                await t
            except (asyncio.CancelledError, ConnectionClosed):
                pass

    except ConnectionClosed:
        pass
    except Exception as e:
        log.exception(f'ERRO inesperado {ip}: {e}')
        try:
            await ws.close(code=1011, reason=str(e)[:120])
        except Exception:
            pass
    finally:
        if piston_ws is not None:
            try:
                await piston_ws.close()
            except Exception:
                pass
        log.info(f'CLOSE {ip} user={user_id[:8]} slug={book_slug}')


async def relay_piston_to_browser(piston_ws, browser_ws):
    """Piston → navegador. Encaminha stdout/stderr/runtime/stage/exit."""
    try:
        async for raw in piston_ws:
            # Piston manda JSON; repassamos igual pro front.
            # Front parseia e sabe o que fazer com cada type.
            try:
                msg = json.loads(raw)
                msg_type = msg.get('type', '')
                # Detecta exit pra log
                if msg_type == 'exit':
                    log.info(
                        f'PISTON_EXIT code={msg.get("code")} signal={msg.get("signal")}'
                    )
            except (ValueError, TypeError):
                # Não-JSON do Piston? Repassa como data mesmo assim
                pass
            await browser_ws.send(raw)
    except ConnectionClosed:
        try:
            await browser_ws.close(code=1001, reason='piston desconectou')
        except Exception:
            pass


async def relay_browser_to_piston(browser_ws, piston_ws):
    """Navegador → Piston. Repassa stdin e signals. Aplica idle timeout."""
    try:
        while True:
            try:
                raw = await asyncio.wait_for(browser_ws.recv(), timeout=IDLE_TIMEOUT_S)
            except asyncio.TimeoutError:
                # Aluno abandonou — manda SIGKILL pro Piston e fecha
                log.warning(f'IDLE_TIMEOUT after {IDLE_TIMEOUT_S}s — killing piston')
                try:
                    await piston_ws.send(json.dumps({'type': 'signal', 'signal': 'SIGKILL'}))
                except Exception:
                    pass
                try:
                    await browser_ws.close(code=4408, reason='idle timeout')
                except Exception:
                    pass
                return
            try:
                msg = json.loads(raw)
                t = msg.get('type', '')
                # Sanity-check: só aceitamos data e signal depois do init
                if t not in ('data', 'signal'):
                    continue
                # data: só stdin é gravável
                if t == 'data' and msg.get('stream') != 'stdin':
                    continue
            except (ValueError, TypeError):
                continue
            await piston_ws.send(raw)
    except ConnectionClosed:
        pass


# ─── Heartbeat ping/pong (mantém conexões vivas) ────────────────────────
async def heartbeat(ws):
    """Envia ping pro browser a cada PING_INTERVAL_S; se falhar, cancela a sessão."""
    try:
        while True:
            await asyncio.sleep(PING_INTERVAL_S)
            # websockets 10.x: ping() não existe, use send control frame
            try:
                pong = await ws.ping()
                await asyncio.wait_for(pong, timeout=5)
            except (asyncio.TimeoutError, Exception):
                await ws.close(code=1011, reason='ping failed')
                return
    except asyncio.CancelledError:
        pass


# ─── Main ────────────────────────────────────────────────────────────────
async def main():
    log.info(f'subindo terminal_server em ws://{TERMINAL_HOST}:{TERMINAL_PORT}')
    log.info(f'PISTON_WS_URL={PISTON_WS_URL} SUPABASE_URL={SUPABASE_URL[:40] if SUPABASE_URL else "-"}')
    async with websockets.serve(
        handle_browser, TERMINAL_HOST, TERMINAL_PORT,
        max_size=2**20,
        ping_interval=20,
        ping_timeout=20,
    ):
        log.info('OK servindo')
        await asyncio.Future()  # nunca termina


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info('shutdown manual')
    except Exception as e:
        log.exception(f'FATAL: {e}')
        sys.exit(1)
