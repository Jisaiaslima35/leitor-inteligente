#!/usr/bin/env python3
# dev_server.py — backend da Sala Dev do Leitor Inteligente
# ISAÍAS: instalado 23/08/2026 como motor do Leitor DEVs.
# Conecta frontend (Vite/React) com:
#   1) Piston em 127.0.0.1:2000 (execução de código PHP/Python/JavaScript)
#   2) Hermes CLI perfil leitor-inteligente-dev (feedback pedagógico do mentor)
#
# Endpoints:
#   GET  /health                          — sanity check
#   POST /exec                            — executa código no Piston
#                                            body: {language, code, session_id}
#                                            returns: {stdout, stderr, code,
#                                                       cpu_time, wall_time,
#                                                       memory, language, version}
#   POST /feedback                        — gera feedback do Mentor Dev
#                                            body: {language, code, stdout, stderr,
#                                                   exit_code, enunciado, session_id}
#                                            returns: {feedback, history_len}
#
# Limites:
#   - código máx 5000 chars
#   - rate limit 1 execução/2s por IP
#   - timeout Piston 5s
#   - timeout hermes 90s
#   - histórico em memória (até 20 itens por sessão)
#
# SEM PERSISTÊNCIA EM BANCO — Isaías pediu pra não persistir por enquanto.

import json
import os
import subprocess
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

# ─── Configuração ────────────────────────────────────────────────────────
PISTON_URL = os.environ.get('PISTON_URL', 'http://127.0.0.1:2000/api/v2')
HERMES_HOME = os.environ.get('HERMES_HOME', '/root/.hermes')
HERMES_PROFILE = 'leitor-inteligente-dev'
MAX_CODE_CHARS = 5000
PISTON_TIMEOUT_MS = 5000  # 5s — loop infinito cai aqui
HERMES_TIMEOUT_S = 90     # hermes chat pode demorar (9router fallback)
RATE_LIMIT_INTERVAL_S = 2.0  # 1 execução a cada 2s por IP
HISTORY_MAX = 20  # últimas N execuções por sessão

# Mapear linguagem do front → (Piston language, Piston version default)
LANG_MAP = {
    'python':    ('python', '3.11.0'),
    'python3':   ('python', '3.11.0'),
    'php':       ('php', '8.2.3'),
    'javascript':('javascript', '20.11.1'),  # Piston chama Node de "javascript"
    'js':        ('javascript', '20.11.1'),
    'node':      ('javascript', '20.11.1'),
}

# ─── Estado em memória ────────────────────────────────────────────────────
rate_lock = threading.Lock()
last_exec_ts = {}  # ip -> timestamp do último /exec
sessions = defaultdict(lambda: deque(maxlen=HISTORY_MAX))  # session_id -> deque

# ─── Helpers ─────────────────────────────────────────────────────────────

def normalize_language(lang: str) -> tuple[str, str]:
    """Retorna (piston_language, piston_version) ou levanta ValueError."""
    key = lang.strip().lower()
    if key not in LANG_MAP:
        raise ValueError(
            f"Linguagem '{lang}' não suportada. Use: {', '.join(sorted(set(LANG_MAP.keys())))}"
        )
    return LANG_MAP[key]


def call_piston(language: str, version: str, code: str) -> dict:
    """Executa código no Piston. Retorna dict com stdout/stderr/code/etc."""
    res = requests.post(
        f'{PISTON_URL}/execute',
        json={
            'language': language,
            'version': version,
            'files': [{'content': code}],
            'run_timeout': PISTON_TIMEOUT_MS,
        },
        timeout=HERMES_TIMEOUT_S,
    )
    if res.status_code != 200:
        return {
            'stdout': '',
            'stderr': f'Piston retornou HTTP {res.status_code}: {res.text[:300]}',
            'code': -1,
            'cpu_time': 0,
            'wall_time': 0,
            'memory': 0,
        }
    data = res.json()
    run = data.get('run') or {}
    return {
        'stdout': run.get('stdout', '') or '',
        'stderr': run.get('stderr', '') or '',
        'code': run.get('code', 0) if run.get('code') is not None else 0,
        'signal': run.get('signal'),
        'cpu_time': run.get('cpu_time', 0),
        'wall_time': run.get('wall_time', 0),
        'memory': run.get('memory', 0),
        'language': data.get('language', language),
        'version': data.get('version', version),
    }


def call_hermes_mentor(prompt: str) -> str:
    """Chama o modelo via 9Router direto (sem passar pelo hermes CLI).

    Carrega SOUL.md do profile leitor-inteligente-dev como system prompt,
    monta uma chamada OpenAI-compat pro 9Router usando o combo Hermes-fallbacks.
    Bloqueante, ~5-30s.
    """
    # Carrega SOUL.md do profile como system prompt
    soul_path = os.path.join(HERMES_HOME, 'profiles', HERMES_PROFILE, 'SOUL.md')
    try:
        with open(soul_path, 'r', encoding='utf-8') as f:
            soul = f.read()
    except FileNotFoundError:
        soul = 'Você é o Mentor Dev, persona que ensina PHP/Python/JavaScript.'

    # Carrega env vars do profile .env
    api_key = ''
    base_url = 'https://9router.automacaojs.us/v1'
    env_path = os.path.join(HERMES_HOME, 'profiles', HERMES_PROFILE, '.env')
    try:
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line.startswith('#') or '=' not in line:
                    continue
                k, _, v = line.partition('=')
                k = k.strip()
                if k == 'MINIMAX_API_KEY':
                    api_key = v.strip()
                elif k == 'MINIMAX_BASE_URL':
                    base_url = v.strip()
    except FileNotFoundError:
        pass

    if not api_key:
        return '[Mentor Dev offline — API key do 9Router não encontrada no profile .env]'

    # Monta request OpenAI-compat pro 9Router
    try:
        r = requests.post(
            f'{base_url.rstrip("/")}/chat/completions',
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/json',
            },
            json={
                'model': 'Hermes-fallbacks',
                'messages': [
                    {'role': 'system', 'content': soul},
                    {'role': 'user', 'content': prompt},
                ],
                'max_tokens': 800,
                'temperature': 0.6,
                'stream': False,
            },
            timeout=(10, HERMES_TIMEOUT_S),  # connect 10s, read HERMES_TIMEOUT_S
        )
    except requests.Timeout:
        return '[Mentor Demorou demais. Tenta de novo em 30s — o 9Router pode estar trocando de provedor.]'
    except requests.ConnectionError as e:
        return f'[Mentor offline — sem conexão com 9Router ({e}). Tenta em 30s.]'
    except Exception as e:
        return f'[Não consegui falar com o Mentor agora ({e}). Continua tentando que ele volta.]'

    if r.status_code != 200:
        # IMPORTANTE: truncar body pra não vazar token em log
        body_preview = (r.text or '')[:120].replace('\n', ' ')
        return f'[Mentor offline — 9Router retornou HTTP {r.status_code}: {body_preview}. Tenta em 30s.]'

    try:
        data = r.json()
        content = data['choices'][0]['message']['content']
        return (content or '').strip() or '[Mentor retornou resposta vazia — tenta de novo]'
    except (KeyError, IndexError, ValueError) as e:
        return f'[Mentor retornou formato inesperado ({e})]'


def get_client_ip(handler) -> str:
    """Extrai IP do cliente considerando proxy reverso."""
    xff = handler.headers.get('X-Forwarded-For', '').split(',')[0].strip()
    return xff or (handler.client_address[0] if handler.client_address else 'unknown')


# ─── HTTP Handler ────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # silencia log default

    def handle(self):
        # Rede de segurança FINAL: se qualquer exception escapar de do_GET/do_POST
        # (incluindo bugs não descobertos), ainda assim devolvemos JSON 500 em vez
        # de matar a conexão — isso evita o nginx traduzir em 502 Bad Gateway.
        try:
            super().handle()
        except Exception as e:
            import traceback
            print(f'[CRASH-handle] {self.command} {self.path}: {type(e).__name__}: {e}', flush=True)
            print(traceback.format_exc(), flush=True)
            try:
                self.send_json(500, {'error': f'crash no servidor: {type(e).__name__}'})
            except Exception:
                pass

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        try:
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            import traceback
            print(f'[CRASH-send_json] {code}: {type(e).__name__}: {e}', flush=True)
            print(traceback.format_exc(), flush=True)
            raise

    def do_OPTIONS(self):
        self.send_json(200, {})

    def do_GET(self):
        if self.path == '/health':
            # Checagem rápida do Piston
            try:
                r = requests.get(f'{PISTON_URL}/runtimes', timeout=3)
                pist_ok = r.status_code == 200
                runtimes = [f"{x['language']}-{x['version']}" for x in r.json()] if pist_ok else []
            except Exception as e:
                pist_ok = False
                runtimes = []
                err = str(e)[:200]
            return self.send_json(200 if pist_ok else 503, {
                'status': 'ok' if pist_ok else 'piston_down',
                'piston_url': PISTON_URL,
                'piston_runtimes': runtimes,
                'hermes_profile': HERMES_PROFILE,
                'history_sessions': len(sessions),
            })
        return self.send_json(404, {'error': 'not found'})

    def do_POST(self):
        try:
            n = int(self.headers.get('Content-Length', '0'))
            data = json.loads(self.rfile.read(n)) if n else {}
        except Exception as e:
            return self.send_json(400, {'error': f'JSON inválido: {e}'})

        # Try/except amplo: QUALQUER exception não tratada aqui vira 500 JSON
        # em vez de matar a conexão (que o nginx traduz em 502 Bad Gateway).
        try:
            self._do_POST_dispatch(data)
        except Exception as e:
            import traceback
            print(f'[CRASH] do_POST {self.path}: {type(e).__name__}: {e}', flush=True)
            print(traceback.format_exc(), flush=True)
            try:
                self.send_json(500, {'error': f'crash interno do servidor: {type(e).__name__}'})
            except Exception:
                # se até send_json falhar, não há nada a fazer — log e deixa
                pass

    def _do_POST_dispatch(self, data: dict):
        """Lógica real do POST, separada pra try/except amplo pegar tudo."""

        # ── POST /exec ─────────────────────────────────────────────────
        if self.path == '/exec':
            ip = get_client_ip(self)
            now = time.time()
            with rate_lock:
                last = last_exec_ts.get(ip, 0)
                wait = RATE_LIMIT_INTERVAL_S - (now - last)
                if wait > 0:
                    return self.send_json(429, {
                        'error': 'rate_limited',
                        'message': f'Calma, espera {wait:.1f}s antes de rodar de novo',
                        'retry_after_s': round(wait, 1),
                    })
                last_exec_ts[ip] = now

            code = (data.get('code') or '').strip()
            if not code:
                return self.send_json(400, {'error': 'code vazio'})
            if len(code) > MAX_CODE_CHARS:
                return self.send_json(400, {
                    'error': f'código muito grande ({len(code)} chars). Limite: {MAX_CODE_CHARS}',
                })
            lang_in = data.get('language', 'python')
            try:
                language, version = normalize_language(lang_in)
            except ValueError as e:
                return self.send_json(400, {'error': str(e)})

            session_id = (data.get('session_id') or 'anon').strip()[:64]
            try:
                result = call_piston(language, version, code)
                # Salva no histórico da sessão
                sessions[session_id].append({
                    'ts': int(time.time()),
                    'language': language,
                    'version': version,
                    'code': code,
                    'stdout': result['stdout'],
                    'stderr': result['stderr'],
                    'code_exit': result['code'],
                })
                result['session_id'] = session_id
                result['history_len'] = len(sessions[session_id])
                return self.send_json(200, result)
            except requests.Timeout:
                return self.send_json(504, {
                    'error': 'Piston timeout',
                    'stdout': '', 'stderr': '', 'code': -1,
                    'message': 'Execução excedeu tempo limite do Piston',
                })
            except Exception as e:
                return self.send_json(502, {
                    'error': f'Piston offline: {e}',
                    'stdout': '', 'stderr': '', 'code': -1,
                })

        # ── POST /feedback ─────────────────────────────────────────────
        if self.path == '/feedback':
            session_id = (data.get('session_id') or 'anon').strip()[:64]
            enunciado = (data.get('enunciado') or '').strip()
            code = (data.get('code') or '').strip()
            language = data.get('language', 'python')
            stdout = data.get('stdout', '')
            stderr = data.get('stderr', '')
            exit_code = data.get('exit_code', 0)

            if not code:
                return self.send_json(400, {'error': 'code vazio'})

            # Monta prompt pedagógico pro Mentor Dev
            # inclui as últimas N execuções da sessão pra contexto (regra dos 2 erros).
            # IMPORTANTE: o histórico mistura items de /exec (com code_exit) e /feedback
            # (com feedback). Filtrar só pelos de /exec antes de checar code_exit.
            hist_exec = [h for h in list(sessions.get(session_id, []))[-3:]
                         if 'code_exit' in h]  # só items vindos do /exec
            hist_text = ''
            if len(hist_exec) >= 2:
                # Verifica se errou 2x seguidas no mesmo exercício
                ultimos_erros = [h for h in hist_exec[-2:] if h.get('code_exit') != 0]
                if len(ultimos_erros) >= 2:
                    hist_text = (
                        '\n\n[CONTEXTO DO BACKEND] O aluno errou 2x seguidas neste '
                        'exercício — você PODE dar a solução completa agora.\n'
                    )

            prompt = f"""Exercício em andamento: {enunciado or '(não informado)'}

Linguagem: {language}

Último código do aluno:
```
{code[:1500]}
```

Resultado da execução:
- exit_code: {exit_code}
- stdout: {stdout[:800] or '(vazio)'}
- stderr: {stderr[:500] or '(vazio)'}
{hist_text}

Dê o feedback do Mentor Dev conforme a SOUL.md:
1. Veredito curto (1 linha)
2. Análise (2-4 frases)
3. Próximo passo: dica se errou, desafio incremental se acertou

Lembre: NUNCA dê a solução pronta de cara. Só entregue solução completa se aluno errou 2x ou pedir explicitamente."""

            try:
                feedback = call_hermes_mentor(prompt)
                sessions[session_id].append({
                    'ts': int(time.time()),
                    'language': language,
                    'code': code,
                    'feedback': feedback,
                })
                return self.send_json(200, {
                    'feedback': feedback,
                    'session_id': session_id,
                    'history_len': len(sessions[session_id]),
                })
            except subprocess.TimeoutExpired:
                return self.send_json(504, {
                    'error': 'Mentor Dev timeout',
                    'feedback': '[Mentor Demorou demais. Tenta de novo em 30s — o 9Router pode estar trocando de provedor.]',
                })
            except Exception as e:
                return self.send_json(500, {
                    'error': f'Mentor Dev offline: {e}',
                    'feedback': '[Não consegui falar com o Mentor agora. Continua tentando que ele volta.]',
                })

        return self.send_json(404, {'error': 'endpoint não existe'})


if __name__ == '__main__':
    print(
        f'Leitor Dev API: porta 9139 | Piston: {PISTON_URL} | '
        f'Hermes profile: {HERMES_PROFILE}',
        flush=True,
    )
    ThreadingHTTPServer(('127.0.0.1', 9139), Handler).serve_forever()
