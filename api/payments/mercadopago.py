"""
Mercado Pago PaymentProvider.

API: https://www.mercadopago.com.br/developers/pt/reference
SDK: pip install mercadopago (v3.5.0)

Fluxo Checkout Pro:
1. POST /checkout/preferences com items + payer + back_urls + notification_url
2. SDK retorna init_point (prod) ou sandbox_init_point (teste)
3. Cliente é redirecionado pro init_point — Checkout Pro transparente, abre no Leitor
4. Cliente paga (PIX, cartão, boleto)
5. Webhook: MP POST em notification_url com ?type=payment&data_id=<payment_id>
6. Backend chama GET /v1/payments/{payment_id} pra confirmar status real

Modos de webhook:
- **Webhook v2** (recomendado): body JSON com `action` + `data.id` (payment_id)
- **IPN legacy**: body vazio, query tem `?data_id=<payment_id>&type=payment`

Em ambos os casos a gente busca o pagamento via API pra ter dados completos
(transaction_amount, payer, status, external_reference, metadata).

Auth:
- Header: Authorization: Bearer <access_token>
- Webhook: NÃO tem HMAC. Validação é por fetch do pagamento + checagem de status.

PITFALL: external_reference vs payment_id
- Asaas: external_id (retornado em create_checkout) == payment_id do webhook
- MP: external_id (preference_id) != payment_id do webhook
- Solução: a gente gera um checkout_id (uuid) e usa como external_reference.
  Esse mesmo checkout_id vai pro purchases.payment_id, e o webhook busca por ele.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from .base import CheckoutSession, PaymentProvider


def _load_env() -> dict:
    """Lê /root/.hermes/.env (mesmo padrão dos outros providers)."""
    env: dict = {}
    env_file = Path('/root/.hermes/.env')
    if not env_file.exists():
        return env
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            env[k] = v
    return env


class MercadoPagoProvider(PaymentProvider):
    name = "mercadopago"

    def __init__(self):
        env = _load_env()
        self.access_token = env.get('MP_ACCESS_TOKEN', '')
        self.public_key = env.get('MP_PUBLIC_KEY', '')
        # Test creds começam com TEST- (sandbox). Prod começa com APP_USR-.
        self.is_sandbox = self.access_token.startswith('TEST-')
        # Webhook público — configurável via env. Default: rota já conhecida.
        self.webhook_url = env.get(
            'MP_WEBHOOK_URL',
            'https://pay.automacaojs.us/api/webhook/mercadopago',
        )
        # SDK
        import mercadopago
        self.sdk = mercadopago.SDK(self.access_token)

    # ---------- helpers ----------
    def _request(self, method: str, path: str, *, body=None, headers=None):
        url = f"https://api.mercadopago.com{path}"
        h = {
            'Authorization': f'Bearer {self.access_token}',
            'Accept': 'application/json',
            'User-Agent': 'Leitor-Inteligente/1.0 (Isaías; Hermes)',
        }
        if headers:
            h.update(headers)
        data = None
        if body is not None:
            data = json.dumps(body).encode('utf-8')
            h['Content-Type'] = 'application/json'
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        try:
            r = urllib.request.urlopen(req, timeout=30)
            content = r.read()
            return json.loads(content) if content else {}
        except urllib.error.HTTPError as e:
            err_body = e.read()[:500].decode('utf-8', errors='replace')
            raise RuntimeError(f"MP {method} {path} → {e.code}: {err_body}")

    def _fetch_payment(self, payment_id: str | int) -> dict:
        """Busca pagamento via API. Necessário nos 2 modos de webhook (v2 e IPN).

        SDK mercadopago 3.5.0: método é `sdk.payment().get(id)` (NÃO find_by_id).
        """
        try:
            pid = int(payment_id)
        except (ValueError, TypeError):
            pid = payment_id
        try:
            result = self.sdk.payment().get(pid)
        except Exception as e:
            raise RuntimeError(f'MP payment().get({payment_id}) falhou: {e}')
        response = result.get('response', {})
        if not response:
            raise RuntimeError(f'MP pagamento {payment_id} não retornou dados: {result}')
        return response

    # ---------- PaymentProvider interface ----------
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
        """Cria preference (Checkout Pro) e retorna init_point (URL de checkout)."""
        amount_brl = amount_cents / 100
        # checkout_id = uuid nosso. Vai pro external_reference do MP, e pra
        # purchases.payment_id. Webhook busca purchase por ele.
        checkout_id = str(uuid.uuid4())

        preference_data = {
            "items": [{
                "title": product_name[:256],  # MP trunca em 256
                "quantity": 1,
                "currency_id": "BRL",
                "unit_price": amount_brl,
            }],
            "payer": {
                "email": customer_email,
            },
            "back_urls": {
                "success": success_url,
                "failure": cancel_url,
                "pending": success_url,
            },
            "auto_return": "approved",  # só redireciona em approved
            "external_reference": checkout_id,
            "notification_url": self.webhook_url,
            "metadata": {
                "ebook_slug": product_id,
                "ebook_id": product_id,  # alias retrocompat (mesmo do Asaas)
                "customer_id": customer_id,
                "customer_email": customer_email,
                "is_upload": (product_id or '').lower() == 'upload',
            },
        }
        # traffic_source opcional (instagram/youtube/whatsapp/outro) — pra rastreamento
        if metadata and isinstance(metadata, dict):
            ts = metadata.get('traffic_source')
            if ts:
                preference_data['metadata']['traffic_source'] = ts

        try:
            result = self.sdk.preference().create(preference_data)
        except Exception as e:
            raise RuntimeError(f'Falha ao criar preference: {e}')

        if result.get('status') not in (200, 201):
            raise RuntimeError(f'MP preference falhou (status={result.get("status")}): {result}')

        response = result.get('response', {})
        # Em sandbox usa sandbox_init_point, em prod usa init_point
        if self.is_sandbox:
            checkout_url = response.get('sandbox_init_point') or response.get('init_point', '')
        else:
            checkout_url = response.get('init_point', '')

        if not checkout_url:
            raise RuntimeError(f'MP não retornou init_point: {result}')

        return CheckoutSession(
            checkout_url=checkout_url,
            external_id=checkout_id,  # NOSSO uuid, vai pro purchases.payment_id
            raw=response,
        )

    def verify_webhook(
        self,
        headers: dict,
        body: bytes,
        query: dict | None = None,
    ) -> dict | None:
        """Parse webhook MP. Suporta Webhook v2 e IPN legacy.

        Retorna SEMPRE o objeto de pagamento completo (do /v1/payments/{id}),
        pra que get_event_type/get_order_id/etc funcionem uniformemente.
        """
        # Tenta parsear JSON body
        try:
            data = json.loads(body) if body else {}
        except Exception:
            data = {}

        payment_id = None

        # Webhook v2 mode: { "action": "payment.created", "data": { "id": 12345 }, "type": "payment" }
        if isinstance(data, dict) and isinstance(data.get('data'), dict) and data['data'].get('id'):
            payment_id = data['data']['id']
        # IPN mode: body vazio, data_id no query
        elif query and query.get('data_id'):
            payment_id = query['data_id']

        if not payment_id:
            print(f'[MP webhook] sem payment_id. body={body[:200]!r} query={query}', flush=True)
            return None

        try:
            return self._fetch_payment(payment_id)
        except RuntimeError as e:
            print(f'[MP webhook] erro ao buscar payment {payment_id}: {e}', flush=True)
            return None

    def get_event_type(self, event: dict) -> str:
        """Status do pagamento MP: approved | pending | rejected | cancelled | refunded.

        Webhook handler já checa 'approved' / 'paid' / etc. MP usa 'approved'.
        """
        return (event.get('status') or '').lower()

    def get_order_id(self, event: dict) -> str | None:
        """external_reference = nosso checkout_id (uuid). É o que tá em purchases.payment_id."""
        ref = event.get('external_reference')
        return str(ref) if ref is not None else None

    def get_order_email(self, event: dict) -> str | None:
        payer = event.get('payer') or {}
        if isinstance(payer, dict):
            email = payer.get('email')
            if email:
                return email
        meta = event.get('metadata') or {}
        if isinstance(meta, dict):
            return meta.get('customer_email')
        return None

    def get_order_amount_cents(self, event: dict) -> int | None:
        amount = event.get('transaction_amount')
        if amount is None:
            return None
        try:
            return int(float(amount) * 100)
        except Exception:
            return None

    def get_order_metadata(self, event: dict) -> dict:
        """Metadata do preference: ebook_slug, customer_id, is_upload, traffic_source."""
        meta = event.get('metadata') or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except Exception:
                meta = {}
        if not isinstance(meta, dict):
            meta = {}

        slug = meta.get('ebook_slug') or meta.get('ebook_id') or ''
        return {
            'ebook_slug': slug,
            'ebook_id': slug,  # alias retrocompatibilidade com handler
            'is_upload': bool(meta.get('is_upload')) or slug.lower() == 'upload',
            'traffic_source': meta.get('traffic_source'),
        }
