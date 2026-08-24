#!/usr/bin/env python3
"""Leitor IA - TTS Proxy (MiniMax Audio Starter, Modo Autor voice).
Roda na porta 9137. Converte texto em MP3 via API MiniMax T2A v2.

Por que server separado:
- semantic_server.py não deve carregar requests (mantém deps mínimas)
- voice_id pode ser tuneado sem reiniciar o pipeline RAG
- cache simples pra evitar gastar quota no replay
- loga usage (chars + custo estimado) pro Isaías auditar

Endpoint:
  POST /tts {"text": "...", "voice_id": "Portuguese_Narrator"}
    -> audio/mpeg binary
  GET /health
    -> {"status":"ok","voice_id":"...","model":"...","cache_size":N}
"""
import json, hashlib, os, sys, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError

# --- MiniMax config ---
ENV_PATH = Path('/root/.hermes/.env')
MINIMAX_KEY = ''
for line in ENV_PATH.read_text().splitlines():
    line = line.strip()
    if line.startswith('MINIMAX_API_KEY=') and 'MOVED' not in line:
        MINIMAX_KEY = line.split('=', 1)[1].strip().strip('"').strip("'")
        break

TTS_URL = 'https://api.minimax.io/v1/t2a_v2'
DEFAULT_VOICE = os.environ.get('TTS_VOICE_ID', 'Portuguese_Narrator')
DEFAULT_SPEED = float(os.environ.get('TTS_SPEED', '0.92'))
DEFAULT_MODEL = os.environ.get('TTS_MODEL', 'speech-2.8-hd')

# --- Cache ---
_CACHE = {}  # hash(voice_id+text) -> (audio_bytes, ts)
_CACHE_MAX = 32

def _hash_key(voice_id: str, text: str) -> str:
    return hashlib.md5(f"{voice_id}|{text}".encode()).hexdigest()

def synth_minimax(text: str, voice_id: str = DEFAULT_VOICE,
                  speed: float = DEFAULT_SPEED, model: str = DEFAULT_MODEL) -> bytes:
    """Chama MiniMax T2A v2 e retorna bytes do MP3."""
    payload = {
        'model': model,
        'text': text,
        'stream': False,
        'voice_setting': {'voice_id': voice_id, 'speed': speed, 'vol': 1.0, 'pitch': 0},
        'audio_setting': {'sample_rate': 32000, 'bitrate': 128000, 'format': 'mp3', 'channel': 1},
        'language_boost': 'Portuguese',
    }
    req = Request(
        TTS_URL,
        data=json.dumps(payload).encode(),
        headers={'Authorization': f'Bearer {MINIMAX_KEY}', 'Content-Type': 'application/json'},
        method='POST',
    )
    with urlopen(req, timeout=60) as r:
        data = json.loads(r.read())
    if 'data' not in data or 'audio' not in data.get('data', {}):
        raise RuntimeError(f"MiniMax error: {data.get('base_resp', {}).get('status_msg', '?')}")
    return bytes.fromhex(data['data']['audio'])


def get_audio(text: str, voice_id: str) -> tuple[bytes, bool]:
    """Retorna (audio_bytes, from_cache)."""
    text = text.strip()
    if not text:
        raise ValueError('text vazio')
    if len(text) > 5000:
        raise ValueError(f'text muito longo ({len(text)} chars, max 5000)')
    key = _hash_key(voice_id, text)
    if key in _CACHE:
        return _CACHE[key][0], True
    audio = synth_minimax(text, voice_id=voice_id)
    # LRU simples: se lotou, remove o mais antigo
    if len(_CACHE) >= _CACHE_MAX:
        oldest = min(_CACHE, key=lambda k: _CACHE[k][1])
        _CACHE.pop(oldest, None)
    _CACHE[key] = (audio, time.time())
    return audio, False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        # Log compacto só pra requests TTS (silencia health)
        if '/health' not in args[0]:
            print(f'[tts] {args[0]}', flush=True)

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
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'POST,GET,OPTIONS')
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            return self.send_json(200, {
                'status': 'ok',
                'voice_id': DEFAULT_VOICE,
                'model': DEFAULT_MODEL,
                'speed': DEFAULT_SPEED,
                'cache_size': len(_CACHE),
                'minimax_configured': bool(MINIMAX_KEY),
            })
        return self.send_json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/tts':
            return self.send_json(404, {'error': 'not found'})
        try:
            n = int(self.headers.get('Content-Length', '0'))
            data = json.loads(self.rfile.read(n))
            text = str(data.get('text', '')).strip()
            voice_id = str(data.get('voice_id', DEFAULT_VOICE)).strip() or DEFAULT_VOICE
            if not text:
                return self.send_json(400, {'error': 'text vazio'})
            t0 = time.time()
            audio, from_cache = get_audio(text, voice_id)
            elapsed = time.time() - t0
            print(f'[tts] voice={voice_id} chars={len(text)} bytes={len(audio)} '
                  f'cached={from_cache} t={elapsed:.2f}s', flush=True)
            self.send_response(200)
            self.send_header('Content-Type', 'audio/mpeg')
            self.send_header('Content-Length', str(len(audio)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'public, max-age=86400')
            self.end_headers()
            self.wfile.write(audio)
        except ValueError as e:
            return self.send_json(400, {'error': str(e)})
        except HTTPError as e:
            body = e.read().decode('utf-8', 'ignore')[:500]
            print(f'[tts] MiniMax HTTPError: {e.code} {body}', flush=True)
            return self.send_json(502, {'error': f'MiniMax HTTP {e.code}', 'detail': body})
        except Exception as e:
            print(f'[tts] ERROR: {e}', flush=True)
            return self.send_json(500, {'error': str(e)[:500]})


if __name__ == '__main__':
    if not MINIMAX_KEY:
        print('[tts] ❌ MINIMAX_API_KEY não configurada em /root/.hermes/.env', flush=True)
        sys.exit(1)
    print(f'[tts] Leitor TTS Proxy: porta 9137 | voice={DEFAULT_VOICE} | model={DEFAULT_MODEL}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 9137), Handler).serve_forever()
