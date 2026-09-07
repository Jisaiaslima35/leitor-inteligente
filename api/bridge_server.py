"""Ponte de áudio: sala de estudo do Leitor → Harbor do Liquidsoap (Devocional 12).

07/09/2026 — Claudinho (v18 — Estúdio de Transmissão ao Vivo).

Arquitetura v18 (PCM s16le via stdin):
- Cliente y-websocket (websockets lib) conecta no collab_server.py:2006 como
  guest com `display_name="Studio-Bridge"`. Entra na sala global `_broadcast`
  onde o front publica awareness → broadcast_state.
- Recebe mensagens `{type:"broadcast_audio", audio:"data:audio/pcm-s16le;base64,..."}`
  retransmitidas pelo fan-out do collab_server. **O áudio já vem decodificado**
  pelo front via `AudioContext.decodeAudioData` (lib `src/lib/audioPcm.ts`),
  em PCM s16le 16kHz mono. Cada ~2s de áudio vira ~64KB de PCM.
- Acumula em `prebuffer` (memória). Quando atinge PRÉ_BUFFER_S de PCM
  (6s = 192KB), abre `ffmpeg -f s16le -ar 16000 -ac 1 -i pipe:0 ... -f mp3
  -method PUT http://source:***@127.0.0.1:9015/`. ffmpeg recebe PCM cru
  no stdin, encoda MP3, manda PUT no Icecast/Harbor com headers ICY.
- Depois do start, chunks novos vão **direto pro stdin** (sem arquivo). PCM
  é trivialmente decodificável (sem header, sem índice), ffmpeg não trava.
- Keepalive escreve 100ms de silêncio PCM a cada 200ms enquanto não há
  chunk novo, pra Liquidsoap não voltar pro AutoDJ entre falas.
- Quando moderador desliga OU heartbeat expira (10s sem chunks), ffmpeg
  termina, harbor fecha, Liquidsoap volta pro AutoDJ em ~2s.

CHANGELOG:
- 07/09/2026 v18 Claudinho: troca WebM→arquivo→stream_loop por PCM→stdin.
  Resolve o loop infinito do -stream_loop -1 (WebM não recalcula índice).
  PCM s16le é trivialmente decodificável: ffmpeg nunca trava.
- 07/09/2026 v17 Claudinho: PRÉ-BUFFER 6s + arquivo + stream_loop.
- 07/09/2026 v16 Claudinho: detecta br zumbi e reinicia start().
- 07/09/2026 v15 Claudinho: troca icecast:// → http:// -method PUT, ICY headers.
- 07/09/2026 v14 Claudinho: primeira versão (cliente y-websocket + FIFO + ffmpeg).
"""
import asyncio
import base64
import json
import logging
import os
import subprocess
import sys
import time
from typing import Dict, Optional

import websockets

# ─── Logging ─────────────────────────────────────────────────────────────
LOG_PATH = os.environ.get("BRIDGE_LOG", "/var/log/leitor-bridge.log")
log = logging.getLogger("bridge")
log.setLevel(logging.INFO)
try:
    _h = logging.FileHandler(LOG_PATH)
    _h.setFormatter(logging.Formatter('%(asctime)s %(levelname)-5s %(message)s'))
    log.addHandler(_h)
except Exception as e:
    sys.stderr.write(f"log file open falhou {LOG_PATH}: {e}\n")
_sh = logging.StreamHandler(sys.stderr)
_sh.setFormatter(logging.Formatter('%(levelname)s %(message)s'))
log.addHandler(_sh)

# ─── Config ──────────────────────────────────────────────────────────────
COLLAB_WS = os.environ.get("COLLAB_WS", "ws://127.0.0.1:2006/collab")
ICE_URL = os.environ.get("ICE_URL", "http://127.0.0.1:9015/")
ICE_USER = os.environ.get("ICE_USER", "source")
ICE_PASS = os.environ.get("ICE_PASS", "RtqxAwgn")
ICE_NAME = os.environ.get("ICE_NAME", "Leitor-Estudio-Devocional12")
ICE_DESC = os.environ.get("ICE_DESC", "Estúdio de Transmissão ao Vivo - Devocional 12")
ICE_URL_PUB = os.environ.get("ICE_URL_PUB", "https://leitor.automacaojs.us")
HEARTBEAT_TIMEOUT_S = 10
MAX_BITRATE = "128k"
MAX_CHUNK_BYTES = 4 * 1024 * 1024  # 4MB
RECONNECT_DELAY_S = 3
PRÉ_BUFFER_S = 6
# PCM s16le 16kHz mono = 32000 bytes/s. 6s = 192000 bytes.
PRÉ_BUFFER_BYTES = 32000 * PRÉ_BUFFER_S
SILENCE_BYTES = 3200  # 100ms @ 16kHz mono s16le (manter o source vivo entre falas)


# ─── Estado por sala ─────────────────────────────────────────────────────
class RoomBridge:
    """Mantém o processo ffmpeg lendo PCM do stdin por sala em modo ON_AIR.

    v18: PCM cru entra via stdin do ffmpeg. Sem arquivo, sem loop, sem índice.
    """

    def __init__(self, room_id: str):
        self.room_id = room_id
        self.proc: Optional[subprocess.Popen] = None
        self.prebuffer: bytes = b""
        self.last_chunk_at: float = 0.0
        self.chunks: int = 0
        self.bytes_buffered: int = 0

    async def start(self):
        """Inicia ffmpeg lendo PCM do stdin. Pré-condição: prebuffer ≥ 192KB."""
        if self.proc and self.proc.poll() is None:
            log.info(f"start: já rodando room={self.room_id[:8]}")
            return
        if len(self.prebuffer) < PRÉ_BUFFER_BYTES:
            log.warning(f"start: prebuffer curto {len(self.prebuffer)//1024}KB < {PRÉ_BUFFER_BYTES//1024}KB")
            return
        auth_b64 = base64.b64encode(f"{ICE_USER}:{ICE_PASS}".encode()).decode()
        icy_headers = (
            f"Authorization: Basic {auth_b64}\r\n"
            f"Ice-Name: {ICE_NAME}\r\n"
            f"Ice-Description: {ICE_DESC}\r\n"
            f"Ice-URL: {ICE_URL_PUB}\r\n"
            f"Ice-Public: 1\r\n"
            f"Ice-Audio-Info: channels=2;samplerate=44100;bitrate={MAX_BITRATE.rstrip('k')}\r\n"
        )
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "warning",
            "-f", "s16le",      # PCM s16le cru do stdin
            "-ar", "16000",     # 16kHz
            "-ac", "1",         # mono
            "-i", "pipe:0",
            "-f", "mp3",
            "-content_type", "audio/mpeg",
            "-b:a", MAX_BITRATE,
            "-ar", "44100",
            "-ac", "2",
            "-method", "PUT",
            "-http_persistent", "0",
            "-headers", icy_headers,
            ICE_URL,
        ]
        try:
            self.proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except Exception as e:
            log.error(f"start: ffmpeg falhou room={self.room_id[:8]}: {e}")
            return
        # Descarrega o prebuffer acumulado direto no stdin (flush imediato)
        try:
            self.proc.stdin.write(self.prebuffer)
            self.proc.stdin.flush()
            dumped = len(self.prebuffer)
            self.prebuffer = b""
            self.last_chunk_at = time.time()
            log.info(f"start: ffmpeg PID={self.proc.pid} room={self.room_id[:8]} pré-buffer {dumped//1024}KB → {ICE_URL}")
        except (BrokenPipeError, OSError) as e:
            log.error(f"start: stdin falhou room={self.room_id[:8]}: {e}")
            try:
                self.proc.kill()
            except Exception:
                pass
            self.proc = None

    def _write_to_stdin(self, data: bytes) -> bool:
        """Escreve bytes no stdin do ffmpeg. Retorna False se morreu."""
        if not self.proc or self.proc.poll() is not None:
            return False
        try:
            self.proc.stdin.write(data)
            self.proc.stdin.flush()
            return True
        except (BrokenPipeError, OSError, ValueError) as e:
            log.warning(f"write: stdin quebrou room={self.room_id[:8]}: {e}")
            self.proc = None
            return False

    async def write_chunk(self, audio_b64: str) -> bool:
        """Decodifica base64 (PCM s16le 16kHz mono) e injeta no prebuffer
        ou direto no stdin do ffmpeg se já está rodando."""
        try:
            if audio_b64.startswith("data:"):
                idx = audio_b64.find(",")
                if idx >= 0:
                    audio_b64 = audio_b64[idx + 1:]
            clean = "".join(audio_b64.split())
            data = base64.b64decode(clean, validate=True)
            if len(data) > MAX_CHUNK_BYTES:
                log.warning(f"write: chunk enorme descartado {len(data)}b room={self.room_id[:8]}")
                return False
        except Exception as e:
            log.warning(f"write: erro decode room={self.room_id[:8]}: {e}")
            return False

        self.chunks += 1
        self.bytes_buffered += len(data)
        self.last_chunk_at = time.time()

        if self.proc is not None and self.proc.poll() is not None:
            log.info(f"write: ffmpeg morreu room={self.room_id[:8]} — limpa pra re-start")
            self.proc = None
        if self.proc is None:
            # Acumula no prebuffer. Inicia se já tem 6s.
            self.prebuffer += data
            if self.chunks == 1 or self.chunks % 5 == 0:
                log.info(f"write: prebuf chunk#{self.chunks} {len(data)}B ({self.bytes_buffered//1024}KB total) room={self.room_id[:8]}")
            if len(self.prebuffer) >= PRÉ_BUFFER_BYTES:
                log.info(f"write: pré-buffer atingido ({len(self.prebuffer)//1024}KB), iniciando ffmpeg")
                await self.start()
        else:
            # ffmpeg vivo, escreve direto no stdin
            ok = self._write_to_stdin(data)
            if not ok:
                # ffmpeg morreu durante write, guarda pra próximo start
                self.prebuffer += data
                log.info(f"write: ffmpeg morto, devolvido {len(data)}B ao prebuf ({len(self.prebuffer)//1024}KB)")
            elif self.chunks == 1 or self.chunks % 5 == 0:
                log.info(f"write: stdin chunk#{self.chunks} {len(data)}B ({self.bytes_buffered//1024}KB total) room={self.room_id[:8]}")
        return True

    def keepalive(self):
        """Se ficou >300ms sem chunk novo, escreve 100ms de silêncio PCM.
        Mantém o source Icecast vivo entre falas pra Liquidsoap não voltar
        pro AutoDJ. Não atualiza last_chunk_at."""
        if not self.proc or self.proc.poll() is not None:
            return
        if self.last_chunk_at == 0:
            return
        idle = time.time() - self.last_chunk_at
        if idle > 0.3:
            self._write_to_stdin(b"\x00" * SILENCE_BYTES)

    async def heartbeat_check(self):
        """Se ficou >HEARTBEAT_TIMEOUT_S sem chunks, encerra."""
        if not self.proc:
            return
        if self.last_chunk_at == 0:
            return
        idle = time.time() - self.last_chunk_at
        if idle > HEARTBEAT_TIMEOUT_S:
            log.info(f"heartbeat: {idle:.1f}s idle, fechando room={self.room_id[:8]}")
            await self.stop()

    async def stop(self):
        if not self.proc:
            return
        try:
            # Fecha stdin pra ffmpeg encerrar limpo (EOF)
            try:
                if self.proc.stdin and not self.proc.stdin.closed:
                    self.proc.stdin.close()
            except Exception:
                pass
            if self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
        except Exception as e:
            log.warning(f"stop: erro room={self.room_id[:8]}: {e}")
        self.proc = None
        self.prebuffer = b""
        log.info(f"stop: encerrado room={self.room_id[:8]}")


BRIDGES: Dict[str, RoomBridge] = {}


# ─── Loops auxiliares ────────────────────────────────────────────────────
async def heartbeat_loop():
    while True:
        await asyncio.sleep(2)
        for room_id in list(BRIDGES.keys()):
            br = BRIDGES.get(room_id)
            if br:
                await br.heartbeat_check()


async def keepalive_loop():
    """Escreve silêncio PCM no stdin a cada 200ms quando não há chunk novo."""
    while True:
        await asyncio.sleep(0.2)
        for br in list(BRIDGES.values()):
            try:
                br.keepalive()
            except Exception:
                pass


# ─── Conexão y-websocket cliente ─────────────────────────────────────────
async def connect_to_collab(room_id: str):
    backoff = RECONNECT_DELAY_S
    while True:
        try:
            log.info(f"conn: tentando {COLLAB_WS}/{room_id[:8]}…")
            async with websockets.connect(
                f"{COLLAB_WS}/{room_id}?token=&display_name=Studio-Bridge",
                max_size=2 ** 22,
                ping_interval=20,
                ping_timeout=30,
            ) as ws:
                backoff = RECONNECT_DELAY_S
                log.info(f"conn: conectado room={room_id[:8]}")
                async for raw in ws:
                    if not isinstance(raw, str):
                        continue
                    try:
                        msg = json.loads(raw)
                    except Exception:
                        continue
                    mtype = msg.get("type")
                    if mtype == "broadcast_audio":
                        br = BRIDGES.get(room_id)
                        if br is None:
                            br = RoomBridge(room_id)
                            BRIDGES[room_id] = br
                        await br.write_chunk(msg.get("audio", ""))
                    elif mtype == "broadcast_state":
                        state = msg.get("state")
                        if state == "off":
                            br = BRIDGES.get(room_id)
                            if br:
                                await asyncio.sleep(2)
                                if br.chunks == 0 or (time.time() - br.last_chunk_at) > 2:
                                    await br.stop()
                                    BRIDGES.pop(room_id, None)
                    else:
                        pass
        except Exception as e:
            log.warning(f"conn: caiu room={room_id[:8]}: {e}; reconectando em {backoff}s")
            br = BRIDGES.get(room_id)
            if br:
                await br.stop()
                BRIDGES.pop(room_id, None)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)
        await asyncio.sleep(0.1)


# ─── HTTP minimo (apenas /health) ────────────────────────────────────────
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402

HEALTH_PORT = int(os.environ.get("BRIDGE_HEALTH_PORT", "8130"))


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            payload = json.dumps({
                "alive": True,
                "rooms": {rid: {
                    "chunks": br.chunks,
                    "kb_buffered": br.bytes_buffered // 1024,
                    "idle_s": round(time.time() - br.last_chunk_at, 1) if br.last_chunk_at else None,
                    "prebuf_kb": len(br.prebuffer) // 1024,
                    "ffmpeg_alive": br.proc is not None and br.proc.poll() is None,
                } for rid, br in BRIDGES.items()},
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(payload)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, fmt, *args):
        log.debug(fmt % args)


async def main():
    log.info(f"bridge_server v18 iniciando — collab={COLLAB_WS} → {ICE_URL}")
    log.info(f"heartbeat_timeout={HEARTBEAT_TIMEOUT_S}s health_port={HEALTH_PORT} pré_buffer={PRÉ_BUFFER_S}s ({PRÉ_BUFFER_BYTES//1024}KB)")
    asyncio.create_task(heartbeat_loop())
    asyncio.create_task(keepalive_loop())

    import threading
    def _http():
        srv = ThreadingHTTPServer(("127.0.0.1", HEALTH_PORT), HealthHandler)
        log.info(f"HTTP health ouvindo :{HEALTH_PORT}/health")
        srv.serve_forever()
    threading.Thread(target=_http, daemon=True).start()

    SUBSCRIBE_ROOMS = os.environ.get(
        "BRIDGE_SUBSCRIBE_ROOMS",
        "_broadcast",
    ).split(",")
    tasks = [asyncio.create_task(connect_to_collab(r.strip())) for r in SUBSCRIBE_ROOMS if r.strip()]
    if not tasks:
        log.warning("nenhuma sala pra escutar — BRIDGE_SUBSCRIBE_ROOMS vazio")
    await asyncio.gather(*tasks)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("bridge_server encerrado")
