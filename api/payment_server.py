#!/usr/bin/env python3
"""
Payment Server — Leitor Inteligente

Endpoints:
- POST /api/checkout/create
    Body JSON: { ebook_slug, customer_email, customer_id, success_url, cancel_url }
    Cria checkout dinâmico via PaymentProvider (Cakto)
    Retorna: { checkout_url, external_id }

- POST /api/cakto/webhook  (ou /api/webhook/{provider})
    Recebe notificação de pagamento
    Verifica assinatura
    Adiciona ebook na user_library do usuário
    Marca purchase como 'paid'

- GET /api/payment/health
    Health check

Modo TESTE (sandbox):
- Cakto sandbox: produtos criados em modo sandbox não geram cobrança real
- Para testar webhook localmente: use ngrok ou cloudflared pra expor porta
"""
from __future__ import annotations

import json
import sys
import urllib.error
from pathlib import Path

# Adiciona o path do projeto
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flask import Flask, jsonify, request
from flask_cors import CORS

from payments import get_provider
from api.book_meta import SUPABASE_URL, SUPABASE_SR

import urllib.request

app = Flask(__name__)
# CORS: permite requisições do preview.automacaojs.us (frontend do Leitor)
CORS(app, resources={r'/api/*': {'origins': [
    'https://preview.automacaojs.us',
    'https://automacaojs.us',
    'http://localhost:5173',
    'http://localhost:3010',
]}})


def _supabase_post(path: str, body: dict, *, prefer: str = "return=representation"):
    """POST helper pro Supabase REST com service_role."""
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/{path}",
        data=json.dumps(body).encode('utf-8'),
        method='POST',
        headers={
            'apikey': SUPABASE_SR,
            'Authorization': f'Bearer {SUPABASE_SR}',
            'Content-Type': 'application/json',
            'Prefer': prefer,
        },
    )
    try:
        r = urllib.request.urlopen(req, timeout=15)
        return (r.status, r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return (e.code, e.read().decode('utf-8', errors='replace'))


def _supabase_patch(path: str, body: dict):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/{path}",
        data=json.dumps(body).encode('utf-8'),
        method='PATCH',
        headers={
            'apikey': SUPABASE_SR,
            'Authorization': f'Bearer {SUPABASE_SR}',
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
        },
    )
    try:
        r = urllib.request.urlopen(req, timeout=15)
        return (r.status, r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return (e.code, e.read().decode('utf-8', errors='replace'))


def _supabase_get(path: str):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}'},
    )
    try:
        r = urllib.request.urlopen(req, timeout=15)
        return (r.status, r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return (e.code, e.read().decode('utf-8', errors='replace'))


def _release_ebook(*, user_id: str, ebook_id: str, amount_cents: int,
                   payment_id: str, payment_method: str = 'cakto'):
    """Libera o ebook na biblioteca do user + marca purchase como paga.

    Idempotente: se já existe purchase pra esse payment_id, atualiza pra paid
    e garante que o item tá na user_library.
    """
    # 1. Verifica se já existe purchase com esse payment_id
    status, body = _supabase_get(
        f'purchases?payment_id=eq.{payment_id}&select=id,status'
    )
    if status == 200 and body.strip() not in ('[]', ''):
        try:
            purchases = json.loads(body)
            if purchases:
                # Já existe — atualiza pra paid (PATCH) e libera na biblioteca
                _supabase_patch(
                    f'purchases?id=eq.{purchases[0]["id"]}',
                    {'status': 'paid'}
                )
                # Garante que tá na user_library
                status2, body2 = _supabase_post(
                    'user_library?on_conflict=user_id,ebook_id',
                    {
                        'user_id': user_id,
                        'ebook_id': ebook_id,
                        'payment_status': 'confirmed',
                    },
                    prefer='resolution=merge-duplicates,return=representation',
                )
                return {'ok': True, 'already_processed': True, 'updated_to_paid': True}
        except Exception as e:
            pass

    # 2. Cria purchase
    status, body = _supabase_post('purchases', {
        'user_id': user_id,
        'ebook_id': ebook_id,
        'amount_cents': amount_cents,
        'currency': 'BRL',
        'payment_method': payment_method,
        'payment_id': payment_id,
        'status': 'paid',
    })
    if status not in (200, 201):
        return {'ok': False, 'error': f'purchase insert failed: {status} {body}'}

    # 3. Adiciona ebook na user_library (upsert)
    status, body = _supabase_post(
        'user_library?on_conflict=user_id,ebook_id',
        {
            'user_id': user_id,
            'ebook_id': ebook_id,
            'payment_status': 'confirmed',
        },
        prefer='resolution=merge-duplicates,return=representation',
    )
    if status not in (200, 201):
        return {'ok': False, 'error': f'library upsert failed: {status} {body}'}

    return {'ok': True, 'purchase_status': status}


# ==================== ENDPOINTS ====================

@app.route('/api/checkout/create', methods=['POST'])
def checkout_create():
    """Cria checkout dinâmico via provider."""
    data = request.get_json(silent=True) or {}
    ebook_slug = data.get('ebook_slug')
    customer_email = data.get('customer_email')
    customer_id = data.get('customer_id')
    success_url = data.get('success_url', 'https://preview.automacaojs.us/leitor-inteligente/#/library')
    cancel_url = data.get('cancel_url', 'https://preview.automacaojs.us/leitor-inteligente/#/store')

    if not (ebook_slug and customer_email):
        return jsonify({'ok': False, 'error': 'ebook_slug e customer_email obrigatórios'}), 400

    # 1. Busca ebook
    status, body = _supabase_get(f'ebooks?slug=eq.{ebook_slug}&select=id,title,price_cents,slug')
    if status != 200:
        return jsonify({'ok': False, 'error': f'erro ao buscar ebook: {body}'}), 500
    try:
        ebooks = json.loads(body)
    except Exception:
        ebooks = []
    if not ebooks:
        return jsonify({'ok': False, 'error': f'ebook "{ebook_slug}" não encontrado'}), 404

    ebook = ebooks[0]
    ebook_id = ebook['id']
    product_name = ebook['title']
    amount_cents = int(ebook['price_cents'] or 2990)

    # 2. Cria checkout via provider
    provider = get_provider()
    try:
        session = provider.create_checkout(
            amount_cents=amount_cents,
            product_name=product_name,
            product_id=ebook_slug,
            customer_email=customer_email,
            customer_id=customer_id or customer_email,
            success_url=success_url,
            cancel_url=cancel_url,
        )
    except Exception as e:
        return jsonify({'ok': False, 'error': f'erro Cakto: {e}'}), 500

    # 3. Cria purchase 'pending' pra rastreamento
    _supabase_post('purchases', {
        'user_id': customer_id or customer_email,
        'ebook_id': ebook_id,
        'amount_cents': amount_cents,
        'currency': 'BRL',
        'payment_method': provider.name,
        'payment_id': session.external_id or 'pending',
        'status': 'pending',
    })

    return jsonify({
        'ok': True,
        'checkout_url': session.checkout_url,
        'external_id': session.external_id,
        'ebook': {
            'slug': ebook['slug'],
            'title': ebook['title'],
            'price_cents': amount_cents,
        },
    })


@app.route('/api/cakto/webhook', methods=['POST'])
@app.route('/api/asaas/webhook', methods=['POST'])
@app.route('/api/webhook/<provider_name>', methods=['POST'])
def webhook(provider_name: str = 'cakto'):
    """Recebe notificação de pagamento do provider."""
    raw_body = request.get_data()
    headers = {k: v for k, v in request.headers.items()}

    provider = get_provider()
    event = provider.verify_webhook(headers, raw_body)
    if event is None:
        return jsonify({'ok': False, 'error': 'assinatura inválida'}), 401

    event_type = provider.get_event_type(event).lower()
    # Aceita variações: Cakto='order.paid', Asaas='PAYMENT_RECEIVED'/'PAYMENT_CONFIRMED'
    if not any(t in event_type for t in ('paid', 'approved', 'succeeded', 'completed', 'received', 'confirmed')):
        return jsonify({'ok': True, 'ignored': True, 'event_type': event_type})

    order_id = provider.get_order_id(event)
    email = provider.get_order_email(event)
    amount = provider.get_order_amount_cents(event)
    meta = provider.get_order_metadata(event)
    ebook_slug = meta.get('ebook_id')
    customer_id = meta.get('customer_id')

    if not (order_id and email):
        return jsonify({'ok': False, 'error': 'event sem order_id/email'}), 400

    # Resolve user_id a partir do email se não veio no metadata
    if not customer_id:
        status, body = _supabase_get(f'profiles?email=eq.{email}&select=id')
        try:
            profiles = json.loads(body)
            customer_id = profiles[0]['id'] if profiles else None
        except Exception:
            customer_id = None

    if not customer_id:
        return jsonify({'ok': False, 'error': f'user não encontrado pra email {email}'}), 404

    # Resolve ebook_id a partir do slug
    ebook_id = None
    if ebook_slug:
        status, body = _supabase_get(f'ebooks?slug=eq.{ebook_slug}&select=id')
        try:
            ebooks = json.loads(body)
            ebook_id = ebooks[0]['id'] if ebooks else None
        except Exception:
            pass

    if not ebook_id:
        return jsonify({'ok': False, 'error': f'ebook {ebook_slug} não encontrado'}), 404

    # Libera
    result = _release_ebook(
        user_id=customer_id,
        ebook_id=ebook_id,
        amount_cents=amount or 0,
        payment_id=order_id,
        payment_method=provider.name,
    )

    return jsonify(result)


@app.route('/api/payment/health', methods=['GET'])
def health():
    """Health check."""
    provider = get_provider()
    return jsonify({
        'ok': True,
        'provider': provider.name,
        'service': 'payment-server',
    })


@app.route('/api/payment/simulate-webhook', methods=['POST'])
def simulate_webhook():
    """Endpoint pra testar webhook sem precisar pagar de verdade (sandbox/dev only)."""
    if not request.json.get('__simulate'):
        return jsonify({'ok': False, 'error': 'não autorizado'}), 403
    # Reaproveita lógica do webhook
    return webhook('cakto')


@app.route('/api/payment/simulate-flow', methods=['POST'])
def simulate_flow():
    """Simula o fluxo COMPLETO sem precisar de Cakto real (pra testar do celular).

    Body:
    {
        "__simulate": true,
        "ebook_slug": "teste-r5",
        "customer_email": "fulano@gmail.com",
        "customer_id": "<uuid>",
        "simulate_payment": true   ← se true, já chama webhook automaticamente
    }
    """
    data = request.get_json(silent=True) or {}
    if not data.get('__simulate'):
        return jsonify({'ok': False, 'error': 'não autorizado'}), 403

    ebook_slug = data.get('ebook_slug')
    customer_email = data.get('customer_email')
    customer_id = data.get('customer_id') or customer_email

    if not (ebook_slug and customer_email):
        return jsonify({'ok': False, 'error': 'ebook_slug e customer_email obrigatórios'}), 400

    # Busca ebook
    status, body = _supabase_get(f'ebooks?slug=eq.{ebook_slug}&select=id,title,price_cents')
    try:
        ebooks = json.loads(body)
    except Exception:
        ebooks = []
    if not ebooks:
        return jsonify({'ok': False, 'error': f'ebook "{ebook_slug}" não encontrado'}), 404

    ebook = ebooks[0]

    # Cria checkout "fake"
    import uuid as uuidlib
    fake_external_id = f"sim-{uuidlib.uuid4().hex[:16]}"

    # Cria purchase pending
    _supabase_post('purchases', {
        'user_id': customer_id,
        'ebook_id': ebook['id'],
        'amount_cents': int(ebook['price_cents'] or 500),
        'currency': 'BRL',
        'payment_method': 'cakto-simulation',
        'payment_id': fake_external_id,
        'status': 'pending',
    })

    checkout_url = f"https://pay.automacaojs.us/api/payment/simulate-pay?external_id={fake_external_id}&ebook_id={ebook['id']}&customer_id={customer_id}"

    # Se pediu simulação automática, libera direto
    if data.get('simulate_payment'):
        if not (customer_id and ebook['id']):
            return jsonify({'ok': False, 'error': 'missing customer_id ou ebook_id'}), 400
        result = _release_ebook(
            user_id=customer_id,
            ebook_id=ebook['id'],
            amount_cents=int(ebook['price_cents'] or 500),
            payment_id=fake_external_id,
            payment_method='cakto-simulation',
        )
        return jsonify({
            'ok': True,
            'mode': 'simulation',
            'checkout_url': checkout_url,
            'external_id': fake_external_id,
            'release_result': result,
        })

    return jsonify({
        'ok': True,
        'mode': 'simulation',
        'checkout_url': checkout_url,
        'external_id': fake_external_id,
    })


@app.route('/api/payment/simulate-pay', methods=['GET'])
def simulate_pay():
    """Página de checkout fake pra você clicar 'pagar' e testar do celular."""
    external_id = request.args.get('external_id')
    ebook_id = request.args.get('ebook_id')
    customer_id = request.args.get('customer_id')

    if not (external_id and ebook_id and customer_id):
        return '<h1>Parâmetros faltando</h1>', 400

    # Busca info
    status, body = _supabase_get(f'ebooks?id=eq.{ebook_id}&select=title,price_cents')
    try:
        ebooks = json.loads(body)
        ebook = ebooks[0] if ebooks else {'title': '?', 'price_cents': 0}
    except Exception:
        ebook = {'title': '?', 'price_cents': 0}

    price_brl = (ebook.get('price_cents') or 0) / 100

    html = f'''<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pagamento (SIMULAÇÃO) — {ebook["title"]}</title>
<style>
body {{ font-family: system-ui; background: #0f172a; color: white; margin: 0; padding: 20px; min-height: 100vh; display: flex; align-items: center; justify-content: center; }}
.card {{ background: white; color: #0f172a; border-radius: 20px; padding: 32px; max-width: 420px; width: 100%; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }}
.alert {{ background: #fef3c7; border: 1px solid #f59e0b; padding: 12px; border-radius: 10px; margin-bottom: 20px; font-size: 0.9rem; }}
h1 {{ font-size: 1.4rem; margin: 0 0 12px; }}
.row {{ display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e5e7eb; }}
.total {{ font-size: 1.8rem; font-weight: 700; color: #059669; margin: 16px 0; }}
.btn {{ background: #10b981; color: white; border: 0; padding: 14px; border-radius: 10px; width: 100%; font-size: 1rem; font-weight: 600; cursor: pointer; }}
.btn:hover {{ background: #059669; }}
.btn-cancel {{ background: #6b7280; margin-top: 8px; }}
small {{ color: #6b7280; font-size: 0.85rem; }}
</style></head>
<body>
<div class="card">
  <div class="alert">⚠️ AMBIENTE DE SIMULAÇÃO — Nenhum pagamento real será processado. Apenas pra testar o fluxo.</div>
  <h1>{ebook["title"]}</h1>
  <div class="row"><span>Produto</span><span>1x ebook</span></div>
  <div class="row"><span>Pagamento</span><span>PIX/Cartão/Boleto</span></div>
  <div class="total">R$ {price_brl:.2f}</div>
  <form method="POST" action="/api/payment/simulate-confirm">
    <input type="hidden" name="external_id" value="{external_id}">
    <input type="hidden" name="ebook_id" value="{ebook_id}">
    <input type="hidden" name="customer_id" value="{customer_id}">
    <input type="hidden" name="amount_cents" value="{int(ebook.get("price_cents") or 500)}">
    <button class="btn" type="submit">✅ Pagar agora (simular)</button>
  </form>
  <a href="https://preview.automacaojs.us/leitor-inteligente/#/store" style="text-decoration:none"><button class="btn btn-cancel" type="button">Cancelar</button></a>
  <p><small>External ID: {external_id}</small></p>
</div>
</body></html>'''
    return html, 200, {'Content-Type': 'text/html; charset=utf-8'}


@app.route('/api/payment/simulate-confirm', methods=['POST'])
def simulate_confirm():
    """Confirma o pagamento simulado, chama o webhook, libera o ebook."""
    external_id = request.form.get('external_id')
    ebook_id = request.form.get('ebook_id')
    customer_id = request.form.get('customer_id')
    amount_cents = int(request.form.get('amount_cents') or 500)

    if not all([external_id, ebook_id, customer_id]):
        return '<h1>Parâmetros faltando</h1>', 400

    # Libera
    if not all([external_id, ebook_id, customer_id]):
        return '<h1>Parâmetros faltando</h1>', 400
    result = _release_ebook(
        user_id=customer_id,  # type: ignore[arg-type]
        ebook_id=ebook_id,  # type: ignore[arg-type]
        amount_cents=amount_cents,
        payment_id=external_id,  # type: ignore[arg-type]
        payment_method='cakto-simulation',
    )

    html = f'''<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pagamento confirmado! ✅</title>
<meta http-equiv="refresh" content="2;url=https://preview.automacaojs.us/leitor-inteligente/#/library">
<style>
body {{ font-family: system-ui; background: #065f46; color: white; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }}
.card {{ background: white; color: #065f46; border-radius: 20px; padding: 40px; max-width: 420px; text-align: center; }}
h1 {{ font-size: 2.5rem; margin: 0 0 16px; }}
pre {{ background: #f3f4f6; padding: 12px; border-radius: 8px; text-align: left; font-size: 0.85rem; overflow: auto; }}
</style></head>
<body>
<div class="card">
  <h1>✅</h1>
  <h1>Pagamento confirmado!</h1>
  <p>Livro liberado na sua biblioteca.</p>
  <p>Redirecionando pro Leitor em 2 segundos...</p>
  <pre>{result}</pre>
</div>
</body></html>'''
    return html, 200, {'Content-Type': 'text/html; charset=utf-8'}


if __name__ == '__main__':
    import os
    port = int(os.environ.get('PAYMENT_PORT', '3019'))
    print(f"💳 Payment server starting on :{port}")
    app.run(host='0.0.0.0', port=port, debug=False)
