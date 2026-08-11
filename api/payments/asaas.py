"""
Asaas PaymentProvider.

API: https://docs.asaas.com
Sandbox: api-sandbox.asaas.com/v3
Production: api.asaas.com/v3

Fluxo:
1. POST /v3/customers (se não existir pelo CPF/CNPJ ou email)
2. POST /v3/payments com billingType=UNDEFINED → retorna invoiceUrl
3. Webhook: PAYMENT_RECEIVED, PAYMENT_CONFIRMED, PAYMENT_OVERDUE

Auth:
- Header: access_token: <api_key>
- Webhook: header access_token (mesmo token) — Asaas envia esse header pra você
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .base import CheckoutSession, PaymentProvider


class AsaasProvider(PaymentProvider):
    name = "asaas"

    def __init__(self):
        from pathlib import Path
        env = {}
        for line in Path('/root/.hermes/.env').read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k] = v

        api_key = env.get('ASAAS_API_KEY', '')
        is_sandbox = api_key.startswith('$aact_hmlg_') or env.get('ASAAS_MODE') == 'sandbox'
        self.base_url = (
            'https://api-sandbox.asaas.com/v3' if is_sandbox
            else 'https://api.asaas.com/v3'
        )
        self.api_key = api_key
        self.is_sandbox = is_sandbox
        self.webhook_token = env.get('ASAAS_WEBHOOK_TOKEN', api_key)

    # ---------- helpers ----------
    def _request(self, method: str, path: str, *, body=None, query=None):
        url = f"{self.base_url}{path}"
        if query:
            url += '?' + urllib.parse.urlencode(query)
        h = {
            'access_token': self.api_key,
            'Accept': 'application/json',
            'User-Agent': 'Leitor-Inteligente/1.0 (Isaías; Hermes)',
        }
        data: bytes | None = None
        if body is not None:
            if isinstance(body, (dict, list)):
                data = json.dumps(body).encode('utf-8')
                h['Content-Type'] = 'application/json'
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        try:
            r = urllib.request.urlopen(req, timeout=30)
            content = r.read()
            return json.loads(content) if content else {}
        except urllib.error.HTTPError as e:
            err_body = e.read()[:500].decode('utf-8', errors='replace')
            raise RuntimeError(f"Asaas {method} {path} → {e.code}: {err_body}")

    def _find_or_create_customer(self, *, email: str, name: str | None = None,
                                  cpf_cnpj: str | None = None) -> str:
        """Procura customer por email; se não existir, cria. Retorna customer_id (cus_xxx).

        Asaas exige CPF/CNPJ pra criar cobrança. Se não vier, usa um CPF de teste sandbox.
        Se o customer já existe sem CPF, atualiza via PUT.
        """
        cpf = cpf_cnpj or '11144477735'

        # GET /v3/customers?email=...
        try:
            res = self._request('GET', '/customers', query={'email': email, 'limit': 1})
            if res.get('data'):
                cust = res['data'][0]
                # Se já tem CPF, retorna
                if cust.get('cpfCnpj'):
                    return cust['id']
                # Senão, atualiza via PUT com o CPF
                try:
                    upd = self._request('PUT', f'/customers/{cust["id"]}', body={'cpfCnpj': cpf})
                    return upd.get('id') or cust['id']
                except RuntimeError:
                    return cust['id']  # tenta mesmo assim
        except RuntimeError:
            pass

        # Cria novo
        payload = {
            'email': email,
            'name': name or email.split('@')[0],
            'cpfCnpj': cpf,
            'notificationDisabled': True,
        }
        res = self._request('POST', '/customers', body=payload)
        return res.get('id', '')

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
    ) -> CheckoutSession:
        """Cria customer + payment com billingType=UNDEFINED (Asaas permite cliente escolher)."""
        # 1. Cria/busca customer
        try:
            asaas_customer_id = self._find_or_create_customer(email=customer_email)
        except RuntimeError as e:
            raise RuntimeError(f'Falha ao criar/buscar customer: {e}')

        # 2. Cria payment UNDEFINED (cliente escolhe método no checkout)
        amount_brl = max(5.00, amount_cents / 100)
        external_reference = f"{product_id}|{customer_id}|{customer_email}"

        payload = {
            'customer': asaas_customer_id,
            'billingType': 'UNDEFINED',  # Asaas mostra todas as opções pro cliente
            'value': amount_brl,
            'dueDate': '2026-12-31',  # Pra cobranças avulsas sem vencimento
            'description': product_name,
            'externalReference': external_reference,
        }
        # Callback exige domínio whitelistado no painel Asaas (Minha Conta > Informações).
        # Doc: https://docs.asaas.com/reference/criar-nova-cobranca
        # autoRedirect=true é default, mas só funciona se o domínio tá whitelisted.
        # Em sandbox sem domínio: TUDO É REJEITADO. Por isso, só manda callback
        # se houver domínio confirmado OU se for explicitamente desabilitado.
        if (
            success_url
            and 'localhost' not in success_url
            and '127.0.0.1' not in success_url
            and not self.is_sandbox  # sandbox rejeita callback sempre
        ):
            callback = {
                'successUrl': success_url,
                'cancelUrl': cancel_url or success_url,
                'expiredUrl': cancel_url or success_url,
            }
            payload['callback'] = callback
        print(f'[DEBUG] Asaas payload: {json.dumps(payload, indent=2)[:500]}', flush=True)
        try:
            res = self._request('POST', '/payments', body=payload)
        except RuntimeError as e:
            raise RuntimeError(f'Falha ao criar payment: {e}')

        payment_id = res.get('id', '')
        invoice_url = res.get('invoiceUrl', '')
        return CheckoutSession(
            checkout_url=invoice_url,
            external_id=payment_id,
            raw=res,
        )

    def verify_webhook(self, headers: dict, body: bytes) -> dict | None:
        """Asaas envia header `asaas-access-token` — valida contra nosso token cadastrado."""
        # Asaas envia no header 'asaas-access-token' (header customizado do webhook configurado)
        token = (
            headers.get('asaas-access-token')
            or headers.get('Asaas-Access-Token')
            or headers.get('access_token')
            or headers.get('Authorization', '').replace('Bearer ', '')
        )
        if not token or token != self.webhook_token:
            return None
        try:
            return json.loads(body)
        except Exception:
            return None

    def get_event_type(self, event: dict) -> str:
        # Asaas usa event: PAYMENT_RECEIVED, PAYMENT_CONFIRMED, etc
        return (event.get('event') or '').upper()

    def get_order_id(self, event: dict) -> str | None:
        payment = event.get('payment', {})
        return payment.get('id') or event.get('id')

    def get_order_email(self, event: dict) -> str | None:
        """Asaas NÃO envia customerEmail no webhook. Pega do externalReference."""
        # 1. Tenta direto (alguns webhooks Asaas mandam)
        direct = event.get('payment', {}).get('customerEmail') or event.get('customerEmail')
        if direct:
            return direct
        # 2. Pega do externalReference: "ebook_slug|customer_id|email"
        ext = event.get('payment', {}).get('externalReference') or event.get('externalReference') or ''
        if '|' in ext:
            parts = ext.split('|', 2)
            return parts[2] if len(parts) > 2 else None
        return None

    def get_order_amount_cents(self, event: dict) -> int | None:
        payment = event.get('payment', {})
        value = payment.get('value') or event.get('value')
        if value is None:
            return None
        try:
            return int(float(value) * 100)
        except Exception:
            return None

    def get_order_metadata(self, event: dict) -> dict:
        """External reference: "ebook_slug|customer_id|email"."""
        ext = event.get('payment', {}).get('externalReference') or event.get('externalReference') or ''
        if '|' in ext:
            parts = ext.split('|', 2)
            return {
                'ebook_id': parts[0] if len(parts) > 0 else '',
                'customer_id': parts[1] if len(parts) > 1 else '',
                'customer_email': parts[2] if len(parts) > 2 else '',
            }
        return {'ebook_id': ext}
