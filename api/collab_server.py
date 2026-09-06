"""WS relay para salas colaborativas Yjs (Painel de Estudo em Dupla).

Arquitetura:
- Cliente (CollabPanel.tsx) abre WS via y-websocket em `wss://host/ws/collab/<roomId>?token=<JWT>&display_name=...`.
- Servidor extrai room_id do PATH e token/display_name do QUERY STRING
  (padrão y-websocket — cliente NÃO manda init JSON).
- Valida JWT via `_auth.extract_user_id_from_jwt`, registra peer, faz
  fan-out binário Yjs entre todos os peers da sala.
- Server é RELAY PURO — não interpreta Yjs, não armazena state (a não ser
  um snapshot binário opcional pra cold-start da sala).
- Salas vazias por >5min são limpas. Rate limit: 1 connect/1s/IP.

ROTA: wss://leitorinteligente.automacaojs.us/ws/collab/<roomId>  (v11, raiz)
       wss://preview.automacaojs.us/leitor-inteligente/ws/collab/<roomId>  (fallback preview)
       proxy nginx → ws://127.0.0.1:2006/collab/<roomId>

Códigos de close custom:
- 4401 → JWT inválido/ausente
- 4429 → rate limit
- 4400 → payload/path inválido

Compat: websockets 10.x–15.x

CHANGELOG:
- 04/09/2026 (v2) Claudinho: reescrito pra protocolo y-websocket padrão.
  Versão anterior esperava init JSON (cliente custom) mas y-websocket
  abre WS direto + manda binário Yjs → handshake sempre 4400.
- 04/09/2026 (v1) Claudinho: primeira versão (init JSON).
"""
import asyncio
import base64
import json
import logging
import os
import sys
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

import websockets
from websockets.exceptions import ConnectionClosed

# ─── Logging ──────────────────────────────────────────────────────────────
LOG_PATH = os.environ.get("COLLAB_LOG", "/var/log/leitor-collab.log")
log = logging.getLogger("collab")
log.setLevel(logging.INFO)
try:
    _h = logging.FileHandler(LOG_PATH)
    _h.setFormatter(logging.Formatter(
        '%(asctime)s %(levelname)-5s %(message)s'
    ))
    log.addHandler(_h)
except Exception as e:
    sys.stderr.write(f"log file open falhou {LOG_PATH}: {e}\n")
_sh = logging.StreamHandler(sys.stderr)
_sh.setFormatter(logging.Formatter('%(levelname)s %(message)s'))
log.addHandler(_sh)

# ─── Config ───────────────────────────────────────────────────────────────
PORT = int(os.environ.get("COLLAB_PORT", "2006"))
RATE_LIMIT_S = 0.0       # DESLIGADO: teto de 8 peers/sala já protege DoS; rate limit por IP atrapalha 2 abas reais
ROOM_TTL_EMPTY = 300     # 5min sem peers → sala removida
HOST_GRACE_S = 120       # 04/09/2026 (v3): sala "viva" 2min após host sair (convidado continua lendo)
MAX_ROOMS = 500          # teto absoluto
MAX_PEERS_PER_ROOM = 8   # limite peer por sala
PATH_PREFIX = "/collab/"  # server espera /collab/<roomId>

sys.path.insert(0, "/root/projetos/leitor-inteligente/api")
from _auth import extract_user_id_from_jwt  # noqa: E402


# ─── Estado ──────────────────────────────────────────────────────────────
@dataclass
class Peer:
    ws: Any
    user_id: str
    display_name: str
    ip: str
    joined_at: float


@dataclass
class Room:
    room_id: str
    peers: Dict[Any, Peer] = field(default_factory=dict)
    # 04/09/2026 (v3): anfitrião = primeiro peer autenticado. Quando ele sai,
    # a sala continua "viva" por HOST_GRACE_S (2min) — convidado pode ler
    # PDF e editar o editor (sincronização fica offline, restaura ao reconectar).
    host_user_id: Optional[str] = None
    host_left_at: Optional[float] = None
    # Snapshot binário Yjs opcional — usado pra cold-start quando 1º peer
    # entra em sala vazia (não há ninguém pra responder sync-step-1).
    snapshot: Optional[bytes] = None
    created_at: float = field(default_factory=time.time)
    last_active: float = field(default_factory=time.time)

    @property
    def peer_count(self) -> int:
        return len(self.peers)

    @property
    def host_online(self) -> bool:
        """True se o host (anfitrião autenticado) tem um peer conectado."""
        if not self.host_user_id:
            return False
        return any(p.user_id == self.host_user_id for p in self.peers.values())

    @property
    def alive(self) -> bool:
        """Sala está 'viva' = host online OU dentro do grace period após sair."""
        if self.host_online:
            return True
        if self.host_user_id and self.host_left_at is not None:
            return (time.time() - self.host_left_at) < HOST_GRACE_S
        # Sala sem host definido (só guests) — considera viva se tem peer ativo
        return self.peer_count > 0


ROOMS: Dict[str, Room] = {}
PEER_INDEX: Dict[Any, Peer] = {}
PEER_ROOM: Dict[Any, str] = {}
LAST_INIT_PER_IP: Dict[str, float] = {}


# ─── Helpers ─────────────────────────────────────────────────────────────
def _client_ip(ws) -> str:
    try:
        headers = dict(ws.request_headers) if ws.request_headers else {}
    except Exception:
        headers = {}
    forwarded = headers.get("x-forwarded-for") or headers.get("cf-connecting-ip")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if ws.remote_address:
        return ws.remote_address[0]
    return "?"


def _parse_path_query(ws) -> tuple[Optional[str], Dict[str, str]]:
    """Extrai room_id e query params do upgrade request.

    websockets 10.x: ws.path = '/collab/abc123?token=xyz'
    websockets 15.x: ws.request.path = '/collab/abc123', query_string separado
    Fallback: parse manual.
    """
    raw_path = ""
    raw_query = ""
    try:
        # websockets 10.x API
        raw_path = getattr(ws, "path", "") or ""
    except Exception:
        pass
    if not raw_path:
        try:
            # websockets 15.x API
            req = getattr(ws, "request", None)
            if req is not None:
                raw_path = getattr(req, "path", "") or ""
                raw_query = getattr(req, "query_string", b"") or b""
                if isinstance(raw_query, bytes):
                    raw_query = raw_query.decode("utf-8", "replace")
        except Exception:
            pass
    if not raw_path:
        return None, {}

    # separa path de query (path pode já ter query colada em 10.x)
    if "?" in raw_path:
        p, q = raw_path.split("?", 1)
        raw_path = p
        if not raw_query:
            raw_query = q
    query = dict(urllib.parse.parse_qsl(raw_query, keep_blank_values=True))

    # extrai room_id depois de PATH_PREFIX
    if not raw_path.startswith(PATH_PREFIX):
        return None, query
    room_id = raw_path[len(PATH_PREFIX):].strip("/")
    if not room_id or len(room_id) > 64:
        return None, query
    return room_id, query


async def _pump_binary(ws, room_id: str):
    """Fan-out de mensagens Yjs (binário) e PTT (texto JSON) entre peers.

    O servidor NÃO interpreta binário Yjs — apenas retransmite. Para
    mensagens de texto JSON (Rádio PX / Push-to-Talk), valida o tipo
    (`ptt_audio`, `ptt_state`) e faz fan-out como texto pra todos os
    outros peers. Snapshot binário NÃO é atualizado com mensagens PTT
    (são efêmeras, não devem persistir pra cold-start).
    """
    try:
        async for raw in ws:
            target = ROOMS.get(room_id)
            if not target:
                continue
            target.last_active = time.time()
            # ── Binário: protocolo Yjs ────────────────────────────────
            if isinstance(raw, (bytes, bytearray)):
                if len(raw) >= 2:
                    target.snapshot = bytes(raw)
                payload = raw
            # ── Texto: canal customizado (PTT) ────────────────────────
            elif isinstance(raw, str):
                # Limita tamanho pra não abusar: ~256KB de áudio Base64
                if len(raw) > 2 ** 18:
                    log.warning(f"pump: msg texto grande descartada ({len(raw)}b) room={room_id[:8]}")
                    continue
                try:
                    parsed = json.loads(raw)
                except Exception:
                    log.debug(f"pump: texto não-JSON descartado room={room_id[:8]}")
                    continue
                # Whitelist de tipos aceitos. Outros = silencioso.
                msg_type = parsed.get("type")
                if msg_type not in ("ptt_audio", "ptt_state"):
                    continue
                payload = raw  # repassa o JSON cru como string
                log.debug(f"pump: fan-out PTT type={msg_type} room={room_id[:8]} bytes={len(raw)}")
            else:
                continue
            for other in list(target.peers.values()):
                if other.ws is ws:
                    continue
                try:
                    await other.ws.send(payload)
                except Exception as e:
                    log.debug(f"fan-out falhou: {e}")
    except ConnectionClosed:
        pass
    except Exception as e:
        log.warning(f"pump erro room={room_id[:8] if room_id else '?'}: {e}")


async def _send_snapshot_if_any(ws, room: Room):
    """Se a sala tem snapshot binário, envia pra acelerar cold-start do peer."""
    if room.snapshot:
        try:
            await ws.send(room.snapshot)
            log.debug(f"snapshot enviado room={room.room_id[:8]} bytes={len(room.snapshot)}")
        except Exception:
            pass


async def _cleanup_empty_rooms():
    """Task recorrente: remove salas vazias há muito tempo."""
    while True:
        await asyncio.sleep(60)
        now = time.time()
        removed = 0
        for rid, room in list(ROOMS.items()):
            if room.peer_count == 0 and (now - room.last_active) > ROOM_TTL_EMPTY:
                ROOMS.pop(rid, None)
                removed += 1
        if removed:
            log.info(f"cleanup: {removed} salas removidas (TTL {ROOM_TTL_EMPTY}s)")


# ─── HTTP process_request: roteia /collab/<roomId>/status pro JSON, deixa
# resto passar pro upgrade WS normal.
def process_request(conn, request):
    """Chamado pelo websockets.serve ANTES do upgrade WS. Se a request for
    HTTP pura (sem Upgrade: websocket) e bater em /collab/<id>/status,
    responde JSON. Caso contrário, retorna None e deixa WS handshake rolar."""
    import http
    from websockets.http11 import Response
    from websockets.datastructures import Headers as WSHeaders
    # WS upgrade? deixa passar pro handler principal
    upgrade = (request.headers.get("Upgrade") or "").lower()
    if upgrade == "websocket":
        return None
    path = request.path
    if path.startswith(PATH_PREFIX):
        rest = path[len(PATH_PREFIX):]
        parts = rest.rstrip("/").split("/")
        # /collab/<roomId>/status → JSON
        if len(parts) == 2 and parts[1] == "status" and parts[0]:
            room = ROOMS.get(parts[0])
            if room:
                payload = json.dumps({
                    "alive": room.alive,
                    "host_online": room.host_online,
                    "peer_count": room.peer_count,
                    "host_user_id": room.host_user_id,
                    "expires_at": (room.host_left_at + HOST_GRACE_S) if (room.host_left_at is not None and room.host_user_id) else None,
                    "grace_seconds": HOST_GRACE_S,
                })
            else:
                payload = json.dumps({"alive": False, "reason": "sala não existe"})
            headers = WSHeaders([
                ("Content-Type", "application/json"),
                ("Access-Control-Allow-Origin", "*"),
                ("Cache-Control", "no-store"),
            ])
            return Response(
                status_code=200,
                reason_phrase="OK",
                headers=headers,
                body=payload.encode("utf-8"),
            )
        # /collab/<roomId> (sem /status) → deixa WS tentar (vai dar 4400)
        if len(parts) == 1 and parts[0]:
            return conn.respond(http.HTTPStatus.NOT_FOUND, "use /collab/<roomId>/status")
    return conn.respond(http.HTTPStatus.NOT_FOUND, "not found")


# ─── Handler principal ───────────────────────────────────────────────────
async def handle_connection(ws):
    """Aceita conexão y-websocket, valida JWT, registra peer, fan-out binário."""
    ip = _client_ip(ws)
    room_id, query = _parse_path_query(ws)

    # Validação: room_id obrigatório (path /collab/<id>)
    if not room_id:
        try:
            await ws.close(code=4400, reason="path deve ser /collab/<room_id>")
        except Exception:
            pass
        log.warning(f"400 ip={ip} path-sem-room (esperado /collab/<id>)")
        return

    # 04/09/2026 (v4): guest do Estudo em Dupla pode entrar SEM JWT —
    # o room_id compartilhado já é a credencial (quem tem o link entra).
    # guest recebe user_id sintético "guest-<ip>-<ts>", NÃO pode virar host,
    # e a sala continua protegida de venda pelo gate de viva do signed_url_server.
    token = query.get("token", "").strip()
    is_guest = False
    user_id = extract_user_id_from_jwt(token)
    if not user_id:
        if not token:
            # Sem token → aceitar como guest do Estudo em Dupla
            user_id = f"guest-{ip.replace('.', '-').replace(':', '-')}-{int(time.time())}"
            is_guest = True
        else:
            try:
                await ws.close(code=4401, reason="JWT inválido (assinatura/payload)")
            except Exception:
                pass
            log.warning(f"401 ip={ip} room={room_id[:8]} token-invalido")
            return

    default_name = "Convidado" if is_guest else "Anônimo"
    display_name = (query.get("display_name") or default_name).strip()[:40] or default_name

    # Rate limit por IP (anti-spam F5 criando salas vazias)
    now = time.time()
    last = LAST_INIT_PER_IP.get(ip, 0)
    if last and (now - last) < RATE_LIMIT_S:
        try:
            await ws.close(code=4429, reason="rate limit")
        except Exception:
            pass
        log.warning(f"429 ip={ip} room={room_id[:8]}")
        return

    # Teto de salas
    if room_id not in ROOMS and len(ROOMS) >= MAX_ROOMS:
        try:
            await ws.close(code=4400, reason="limite de salas atingido")
        except Exception:
            pass
        return

    # Adiciona peer na sala
    room = ROOMS.setdefault(room_id, Room(room_id=room_id))
    if room.peer_count >= MAX_PEERS_PER_ROOM:
        try:
            await ws.close(code=4400, reason=f"sala cheia (max {MAX_PEERS_PER_ROOM})")
        except Exception:
            pass
        return

    peer = Peer(ws=ws, user_id=user_id, display_name=display_name, ip=ip, joined_at=now)
    room.peers[ws] = peer
    room.last_active = now
    PEER_INDEX[ws] = peer
    PEER_ROOM[ws] = room_id
    LAST_INIT_PER_IP[ip] = now

    # 04/09/2026 (v3→v4): primeiro peer AUTENTICADO vira host (anfitrião).
    # Guest NÃO pode ser host — só entra como peer sincronizado.
    # Se host reconecta dentro do grace period, reseta timestamp de saída.
    if not is_guest and (
        not room.host_user_id or (
            room.host_user_id == user_id and room.host_left_at is not None
            and (now - room.host_left_at) < HOST_GRACE_S
        )
    ):
        room.host_user_id = user_id
        room.host_left_at = None
        log.info(f"host definido room={room_id[:8]} user={user_id[:8]}")

    log.info(f"join room={room_id[:8]} user={user_id[:8]} nome={display_name!r} "
             f"peers={room.peer_count} host={'online' if room.host_online else 'offline'} "
             f"guest={is_guest}")

    # 04/09/2026: NÃO enviar welcome JSON — y-websocket cliente ignora
    # mensagens que não sejam do protocolo binário. Apenas retransmitir
    # snapshot se houver (cold-start).
    await _send_snapshot_if_any(ws, room)

    # Loop pump até desconexão
    try:
        await _pump_binary(ws, room_id)
    finally:
        await _disconnect(ws)


async def _disconnect(ws):
    peer = PEER_INDEX.pop(ws, None)
    room_id = PEER_ROOM.pop(ws, None)
    if not peer or not room_id:
        return
    room = ROOMS.get(room_id)
    if not room:
        return
    room.peers.pop(ws, None)
    room.last_active = time.time()
    # 04/09/2026 (v3): se o host saiu, marca timestamp pra grace period.
    # Convidado continua conseguindo ler o PDF por HOST_GRACE_S segundos.
    if room.host_user_id == peer.user_id and not room.host_online:
        room.host_left_at = time.time()
        log.info(f"host saiu room={room_id[:8]} grace={HOST_GRACE_S}s")
    log.info(f"leave room={room_id[:8]} user={peer.user_id[:8]} "
             f"peers_restantes={room.peer_count} host={'online' if room.host_online else 'offline'}")


# ─── Bootstrap ───────────────────────────────────────────────────────────
async def main():
    log.info(f"collab_server v2 iniciando port={PORT} path_prefix={PATH_PREFIX}")
    asyncio.create_task(_cleanup_empty_rooms())

    async with websockets.serve(
        handle_connection,
        host="127.0.0.1",
        port=PORT,
        ping_interval=20,
        ping_timeout=30,
        max_size=2 ** 22,  # 4MB por frame (Yjs + PTT Base64 ~40KB cabem tranquilo)
        process_request=process_request,
    ) as srv:
        log.info(f"collab_server ouvindo ws://127.0.0.1:{PORT}{PATH_PREFIX}<roomId>")
        await asyncio.Future()  # roda até cancelar


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("collab_server encerrado")
