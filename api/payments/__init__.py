"""Factory: escolhe o PaymentProvider baseado em env.

Prioridade: ASAAS > CAKTO. Pra adicionar Mercado Pago depois,
é só criar `mercadopago.py` e adicionar elif aqui.
"""
from pathlib import Path
from typing import Type

from .base import PaymentProvider


def _env_has(name: str) -> bool:
    env_file = Path('/root/.hermes/.env')
    if not env_file.exists():
        return False
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        if k == name and v.strip():
            return True
    return False


def get_provider() -> PaymentProvider:
    """Retorna o provider ativo baseado em env."""
    if _env_has('ASAAS_API_KEY'):
        from .asaas import AsaasProvider
        return AsaasProvider()
    if _env_has('CAKTO_CLIENT_ID'):
        from .cakto import CaktoProvider
        return CaktoProvider()
    raise RuntimeError('Nenhum PaymentProvider configurado. Defina ASAAS_API_KEY ou CAKTO_CLIENT_ID em /root/.hermes/.env')
