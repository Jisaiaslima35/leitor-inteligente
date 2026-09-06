"""Helper compartilhado de autenticação Supabase.

Extraído de terminal_server.py para reuso por collab_server.py e futuros
serviços Python do Leitor Inteligente. Não toca a lógica — `terminal_server.py`
deve ficar byte-equivalente em comportamento.
"""
import base64
import json
import time


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
