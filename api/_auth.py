"""Helper compartilhado de autenticação Supabase.

Extraído de terminal_server.py para reuso por collab_server.py e futuros
serviços Python do Leitor Inteligente. Não toca a lógica — `terminal_server.py`
deve ficar byte-equivalente em comportamento.

06/09/2026 v14.1 (segurança pré-divulgação):
- Adicionado `decode_jwt_payload` que retorna o payload INTEIRO do JWT
  (incluindo `email`, `exp`, `role` custom). Usado pra checar ADMIN_EMAIL
  e `user_role` antes de operações privilegiadas.
- Adicionado `is_admin_jwt` que valida JWT + checa email admin OU role='admin'
  via Supabase. Torna endpoints admin reais (não mais honra token estático).
"""
import base64
import json
import os
import time
from typing import Any, Dict, Optional
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


def extract_user_id_from_jwt(token: str) -> str | None:
    """Decodifica payload do JWT Supabase (sem validar assinatura — o proxy
    reverso do Nginx + CORS + service_role auth abaixo confirmam origem).
    Retorna o `sub` (user UUID) ou None se inválido."""
    payload = decode_jwt_payload(token)
    if not payload:
        return None
    sub = payload.get('sub')
    return sub if sub else None


def extract_email_from_jwt(token: str) -> str | None:
    """Decodifica payload do JWT Supabase e retorna o `email` (lowercase).
    Retorna None se o token for inválido/expirado ou se não tiver email."""
    payload = decode_jwt_payload(token)
    if not payload:
        return None
    email = (payload.get('email') or '').strip().lower()
    return email or None


def is_admin_email_jwt(token: str, admin_emails: Optional[list] = None) -> bool:
    """Checagem rápida de admin só pelo email do JWT (sem consulta Supabase).
    Usado em hot-path (ex.: bridge_server filtrando chunks de áudio) onde
    não vale round-trip ao Supabase por mensagem."""
    if admin_emails is None:
        env = os.environ.get('ADMIN_EMAIL', '').strip()
        admin_emails = [e.strip().lower() for e in env.split(',') if e.strip()]
    if not admin_emails:
        return False
    email = extract_email_from_jwt(token)
    return bool(email) and email in admin_emails


def decode_jwt_payload(token: str) -> Optional[Dict[str, Any]]:
    """Decodifica o payload do JWT Supabase sem validar assinatura.
    Retorna o dict do payload ou None se inválido/expirado."""
    if not token or token.count('.') != 2:
        return None
    try:
        payload_b64 = token.split('.')[1]
        payload_b64 += '=' * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        if payload.get('exp', 0) < time.time() - 60:
            return None
        return payload
    except Exception:
        return None


def _supabase_url_and_sr() -> tuple[str, str]:
    """Resolve SUPABASE_URL e SUPABASE_SERVICE_ROLE do env ou dos arquivos
    canônicos do cofre Hermes."""
    from pathlib import Path
    url = os.environ.get('SUPABASE_URL', '')
    sr = os.environ.get('SUPABASE_SERVICE_ROLE') or ''
    if not sr:
        for p in (
            Path('/root/.hermes/secrets/leitor-supabase.env'),
            Path('/root/.hermes/profiles/leitor-inteligente/.env'),
        ):
            if not p.exists():
                continue
            try:
                for ln in p.read_text().splitlines():
                    ln = ln.strip()
                    if ln.startswith('SUPABASE_SERVICE_ROLE=') or ln.startswith('SUPABASE_SERVICE_KEY='):
                        sr = ln.split('=', 1)[1].strip().strip('"').strip("'")
                    elif not url and ln.startswith('SUPABASE_URL='):
                        url = ln.split('=', 1)[1].strip().strip('"').strip("'")
            except (PermissionError, OSError):
                continue
            if sr:
                break
    if not url:
        url = 'https://yfnzlowtgnlqiznslh.supabase.co'  # fallback público (read-only)
    return url, sr


def is_admin_jwt(token: str, admin_emails: Optional[list] = None) -> Dict[str, Any]:
    """Valida JWT Supabase + verifica se caller é admin.

    Retorna dict {'ok': bool, 'reason': str, 'email': str|None, 'user_id': str|None,
                  'role': str|None}.

    Critérios de admin (qualquer um basta):
    1. `email` do JWT bate com `admin_emails` (env ADMIN_EMAIL ou lista passada).
    2. `profiles.role='admin'` no Supabase (consultado com service_role).
    3. `user_role` ou `role` no payload JWT = 'admin' (custom claim).

    Sem JWT válido → 401. JWT válido mas não admin → 403.
    """
    if admin_emails is None:
        env = os.environ.get('ADMIN_EMAIL', '').strip()
        admin_emails = [e.strip().lower() for e in env.split(',') if e.strip()]
    payload = decode_jwt_payload(token)
    if not payload:
        return {'ok': False, 'reason': 'jwt inválido ou expirado', 'email': None,
                'user_id': None, 'role': None}
    email = (payload.get('email') or '').lower()
    user_id = payload.get('sub')
    jwt_role = payload.get('user_role') or payload.get('role')

    # 1) Custom claim
    if jwt_role == 'admin':
        return {'ok': True, 'reason': 'jwt_role=admin', 'email': email,
                'user_id': user_id, 'role': 'admin'}
    # 2) Email bate com ADMIN_EMAIL
    if email and email in admin_emails:
        return {'ok': True, 'reason': 'email_admin', 'email': email,
                'user_id': user_id, 'role': 'admin'}

    # 3) profiles.role via service_role — só se temos SR configurado
    supa_url, sr = _supabase_url_and_sr()
    if user_id and sr:
        try:
            req = Request(
                f'{supa_url}/rest/v1/profiles?select=role,email&id=eq.{user_id}&limit=1',
                headers={'apikey': sr, 'Authorization': f'Bearer {sr}'},
            )
            with urlopen(req, timeout=5) as r:
                rows = json.loads(r.read())
                if rows and (rows[0].get('role') == 'admin' or rows[0].get('email', '').lower() in admin_emails):
                    return {'ok': True, 'reason': 'profiles.role=admin', 'email': email,
                            'user_id': user_id, 'role': 'admin'}
        except (HTTPError, URLError, TimeoutError, OSError):
            pass

    return {'ok': False, 'reason': 'não é admin', 'email': email,
            'user_id': user_id, 'role': jwt_role}

