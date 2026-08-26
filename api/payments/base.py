"""
PaymentProvider — interface abstrata para provedores de pagamento.

Hoje: Cakto (sandbox)
Amanhã: Mercado Pago, Stripe, etc.

Uso:
    from payments import get_provider
    provider = get_provider()  # detecta automaticamente via env
    checkout = await provider.create_checkout(...)
    valid = provider.verify_webhook(headers, body)
"""
from abc import ABC, abstractmethod
from typing import Any


class CheckoutSession:
    """Sessão de checkout criada por um provider."""
    def __init__(self, checkout_url: str, external_id: str, raw: dict[str, Any] = None):
        self.checkout_url = checkout_url
        self.external_id = external_id
        self.raw = raw if raw is not None else {}

    def to_dict(self):
        return {
            "checkout_url": self.checkout_url,
            "external_id": self.external_id,
        }


class PaymentProvider(ABC):
    """Interface comum pra qualquer provider de pagamento."""

    name: str = "unknown"

    @abstractmethod
    def create_checkout(
        self,
        *,
        amount_cents: int,
        product_name: str,
        product_id: str,
        customer_email: str,
        customer_id: str,
        success_url: str,
        cancel_url: str,
        metadata: dict | None = None,
    ) -> CheckoutSession:
        """Cria sessão de checkout. Retorna URL onde o cliente vai pagar.

        `metadata`: dict livre (ex: {traffic_source: 'instagram'}) que o provider
        precisa preservar até o webhook via externalReference ou descrição.
        """
        ...

    @abstractmethod
    def verify_webhook(self, headers: dict, body: bytes, query: dict | None = None) -> dict | None:
        """Verifica assinatura do webhook. Retorna evento parseado ou None.

        `query`: dict de query params (request.args). Opcional. Usado por provedores
        cujo webhook viaja no query (ex: MP IPN legacy: ?data_id=xxx&type=payment).
        """
        ...

    @abstractmethod
    def get_event_type(self, event: dict) -> str:
        """Tipo do evento (paid/refunded/created/etc)."""
        ...

    @abstractmethod
    def get_order_id(self, event: dict) -> str | None:
        """ID único do pedido nesse provider."""
        ...

    @abstractmethod
    def get_order_email(self, event: dict) -> str | None:
        """Email do pagador."""
        ...

    @abstractmethod
    def get_order_amount_cents(self, event: dict) -> int | None:
        """Valor pago em centavos."""
        ...

    @abstractmethod
    def get_order_metadata(self, event: dict) -> dict:
        """Metadata custom (product_id, customer_id, etc) embutido no checkout."""
        ...
