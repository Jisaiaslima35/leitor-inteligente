"""
Cakto PaymentProvider.

API endpoints (testados pelo Manus):
- GET  /public_api/products/     — lista produtos
- POST /public_api/products/     — cria produto (mínimo R$ 5.00)
- GET  /public_api/transactions/ — lista vendas
- POST /public_api/token/        — renova access_token

Auth:
- access_token via Authorization: Bearer <token>
- access_token expira ~10h, renova POSTando credenciais
- endpoint de token espera form-urlencoded

Webhook:
- Cakto envia POST no CAKTO_WEBHOOK_URL configurado
- Content-Type: application/json
- Assinatura no header `Webhook-Signature` (HMAC-SHA256 do body usando client_secret)
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .base import CheckoutSession, PaymentProvider


class CaktoProvider(PaymentProvider):
    name = "cakto"

    def __init__(self):
        from pathlib import Path
        env = {}
        for line in Path('/root/.hermes/.env').read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k] = v
        self.base_url = env.get('CAKTO_BASE_URL', 'https://api.cakto.com.br/public_api').rstrip('/')
        self.client_id = env.get('CAKTO_CLIENT_ID', '')
        self.client_secret = env.get('CAKTO_CLIENT_SECRET', '')
        self._access_token = env.get('CAKTO_ACCESS_TOKEN', '')
        self._token_obtained_at = time.time()

    # ---------- helpers ----------
    def _request(self, method: str, path: str, *, body=None, headers=None, raw=False):
        url = f"{self.base_url}{path}"
        h = {
            'Authorization': f'Bearer {self._access_token}',
            'Accept': 'application/json',
            'User-Agent': 'Leitor-Inteligente/1.0 (Isaías; suporte@automacaojs.com.br)',
        }
        if headers:
            h.update(headers)
        data: bytes | None = None
        if body is not None:
            if isinstance(body, (dict, list)):
                data = json.dumps(body).encode('utf-8')
                h['Content-Type'] = 'application/json'
            elif isinstance(body, str):
                data = body.encode('utf-8')
            elif isinstance(body, bytes):
                data = body
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        try:
            r = urllib.request.urlopen(req, timeout=30)
            content = r.read()
            if raw:
                return (r.status, r.headers, content)
            return (r.status, r.headers, json.loads(content) if content else {})
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"Cakto API {method} {path} → {e.code}: {e.read()[:500].decode('utf-8', errors='replace')}")

    def _renew_token(self):
        """Renova access_token via POST /public_api/token/ com form-urlencoded."""
        body = urllib.parse.urlencode({
            'grant_type': 'client_credentials',
            'client_id': self.client_id,
            'client_secret': self.client_secret,
        }).encode()
        req = urllib.request.Request(
            f"{self.base_url}/token/",
            data=body,
            method='POST',
            headers={
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'User-Agent': 'Leitor-Inteligente/1.0',
            },
        )
        r = urllib.request.urlopen(req, timeout=30)
        data = json.loads(r.read())
        self._access_token = data.get('access_token', '')
        self._token_obtained_at = time.time()
        return self._access_token

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
        metadata: dict | None = None,  # Cakto ignora (não usa externalReference, mas aceita pra interface)
    ) -> CheckoutSession:
        """Cria produto dinâmico e retorna URL de checkout.

        Cakto exige mínimo R$ 5.00 (500 centavos). Pra valores menores (ex: ebook R$2,99)
        a gente cria o produto no valor cheio e usa metadata pra rastrear.
        """
        amount_brl = max(5.00, amount_cents / 100)
        payload = {
            'name': product_name,
            'description': f'Ebook Devocional 12 — {product_name}',
            'price': amount_brl,
            'currency': 'BRL',
            'type': 'unique',
            'paymentMethods': ['pix', 'credit_card', 'boleto'],
            'metadata': json.dumps({
                'ebook_id': product_id,
                'customer_id': customer_id,
                'customer_email': customer_email,
                'success_url': success_url,
                'cancel_url': cancel_url,
            }),
        }
        try:
            status, headers, body = self._request('POST', '/products/', body=payload, raw=True)
        except RuntimeError as e:
            if '401' in str(e) or 'expired' in str(e).lower():
                self._renew_token()
                status, headers, body = self._request('POST', '/products/', body=payload, raw=True)
            else:
                raise
        # Cakto retorna o produto criado; o checkout_url é montado
        product_data = json.loads(body) if body else {}
        product_id_cakto = product_data.get('id', '')
        checkout_url = f"https://pay.cakto.com.br/{product_id_cakto}" if product_id_cakto else ''
        return CheckoutSession(
            checkout_url=checkout_url,
            external_id=product_id_cakto,
            raw=product_data,
        )

    def verify_webhook(self, headers: dict, body: bytes) -> dict | None:
        """Verifica assinatura HMAC-SHA256 do webhook.

        Header esperado: `Webhook-Signature: sha256=<hex>`
        """
        sig_header = headers.get('Webhook-Signature', headers.get('webhook-signature', ''))
        if not sig_header:
            return None
        if sig_header.startswith('sha256='):
            sig_header = sig_header.split('=', 1)[1]
        expected = hmac.new(
            self.client_secret.encode('utf-8'),
            body,
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(expected, sig_header):
            return None
        try:
            return json.loads(body)
        except Exception:
            return None

    def get_event_type(self, event: dict) -> str:
        return (event.get('event') or event.get('type') or '').lower()

    def get_order_id(self, event: dict) -> str | None:
        return event.get('id') or event.get('order_id') or event.get('transaction_id')

    def get_order_email(self, event: dict) -> str | None:
        return (
            event.get('customer', {}).get('email')
            or event.get('email')
            or event.get('buyer_email')
        )

    def get_order_amount_cents(self, event: dict) -> int | None:
        amount = (
            event.get('amount')
            or event.get('value')
            or event.get('total')
        )
        if amount is None:
            return None
        try:
            return int(float(amount) * 100)
        except Exception:
            return None

    def get_order_metadata(self, event: dict) -> dict:
        meta = event.get('metadata')
        if isinstance(meta, str):
            try:
                return json.loads(meta)
            except Exception:
                return {}
        if isinstance(meta, dict):
            return meta
        return {}
