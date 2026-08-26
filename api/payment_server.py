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
from datetime import datetime, timezone
from pathlib import Path

# Adiciona o path do projeto
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flask import Flask, jsonify, redirect, request
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


def _lookup_purchase_by_payment_id(payment_id: str) -> dict | None:
    """Busca purchase por payment_id (campo único-confiável do Asaas: pay_xxx).

    Retorna o dict da purchase se encontrada, com user_id, ebook_id, traffic_source,
    amount_cents, status. None se não existir.
    """
    status, body = _supabase_get(
        f'purchases?payment_id=eq.{payment_id}'
        f'&select=id,user_id,ebook_id,payment_id,status,amount_cents,traffic_source,paid_at,created_at'
    )
    if status != 200 or not body.strip() or body.strip() == '[]':
        return None
    try:
        rows = json.loads(body)
    except Exception:
        return None
    return rows[0] if rows else None


def _lookup_upload_payment(payment_id: str) -> dict | None:
    """Busca upload_payments por asaas_payment_id (taxa de upload R$10).

    Diferente de ebooks, o upload tem tabela dedicada (upload_payments) e NÃO
    cria row em purchases (purchases.ebook_id é NOT NULL — não cabe upload).
    Retorna o dict da upload_payment se encontrada.
    """
    status, body = _supabase_get(
        f'upload_payments?asaas_payment_id=eq.{payment_id}'
        f'&select=user_id,asaas_payment_id,traffic_source,amount_cents,paid_at,consumed_at'
    )
    if status != 200 or not body.strip() or body.strip() == '[]':
        return None
    try:
        rows = json.loads(body)
    except Exception:
        return None
    return rows[0] if rows else None


def _release_ebook(*, user_id: str, ebook_id: str, amount_cents: int,
                   payment_id: str, payment_method: str = 'cakto'):
    """Libera o ebook na biblioteca do user + marca purchase como paga.

    Idempotente: se já existe purchase pra esse payment_id, atualiza pra paid
    e garante que o item tá na user_library.

    IMPORTANTE: a partir da refatoração 19/08, o webhook passa payment_id
    como fonte primária. _lookup_purchase_by_payment_id faz o resto.
    """
    # 1. Verifica se já existe purchase com esse payment_id (idempotência)
    existing = _lookup_purchase_by_payment_id(payment_id)
    if existing:
        # Já existe — atualiza pra paid e garante biblioteca (idempotente)
        _supabase_patch(
            f'purchases?id=eq.{existing["id"]}',
            {
                'status': 'paid',
                'paid_at': datetime.now(timezone.utc).isoformat(),
            }
        )
        _supabase_post(
            'user_library?on_conflict=user_id,ebook_id',
            {
                'user_id': user_id,
                'ebook_id': ebook_id,
                'payment_status': 'confirmed',
            },
            prefer='resolution=merge-duplicates,return=representation',
        )
        return {'ok': True, 'already_processed': True, 'updated_to_paid': True}

    # 2. Cria purchase (webhook chegou sem purchase anterior — defesa, raro)
    status, body = _supabase_post('purchases', {
        'user_id': user_id,
        'ebook_id': ebook_id,
        'amount_cents': amount_cents,
        'currency': 'BRL',
        'payment_method': payment_method,
        'payment_id': payment_id,
        'status': 'paid',
        'paid_at': datetime.now(timezone.utc).isoformat(),
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

@app.route('/api/checkout/redirect', methods=['GET'])
def checkout_redirect():
    """GET endpoint que cria checkout + redireciona 302 ao Asaas.

    PITFALL mobile: fetch no click + window.location.href falha silencioso
    (popup blocker, gesture timeout, sessão perdida). Solução: uma única
    navegação GET para este endpoint, que retorna 302 -> Asaas. Browser
    trata como navegação normal, sem JSON fetching no front.

    Query params:
        slug: ebook_slug
        email: customer_email
        uid: customer_id (UUID do user)
        back: URL pra voltar pro Leitor (default: Library)
    """
    ebook_slug = request.args.get('slug')
    customer_email = request.args.get('email')
    customer_id = request.args.get('uid')
    traffic_source = request.args.get('src')  # instagram/youtube/whatsapp/outro
    back_url = request.args.get('back') or 'https://preview.automacaojs.us/leitor-inteligente/#/library'

    if not (ebook_slug and customer_email):
        return redirect('https://preview.automacaojs.us/leitor-inteligente/#/store')

    status, body = _supabase_get(
        f'ebooks?slug=eq.{ebook_slug}&select=id,title,price_cents,slug,shareable'
    )
    if status != 200:
        return redirect(
            f'https://preview.automacaojs.us/leitor-inteligente/#/store?error=supabase_{status}'
        )
    try:
        ebooks = json.loads(body)
    except Exception:
        ebooks = []
    if not ebooks:
        return redirect(
            f'https://preview.automacaojs.us/leitor-inteligente/#/store?error=ebook_not_found'
        )

    ebook = ebooks[0]
    ebook_id = ebook['id']
    product_name = ebook['title']
    amount_cents = int(ebook.get('price_cents') or 2990)
    # shareable=false = livro privado (testes, demos). Bloqueia checkout de campanha.
    if ebook.get('shareable') is False:
        return redirect('https://preview.automacaojs.us/leitor-inteligente/#/store?error=not_shareable')

    provider = get_provider()
    checkout_metadata = {'traffic_source': traffic_source} if traffic_source else None
    try:
        session = provider.create_checkout(
            amount_cents=amount_cents,
            product_name=product_name,
            product_id=ebook_slug,
            customer_email=customer_email,
            customer_id=customer_id or customer_email,
            success_url=back_url,
            cancel_url='https://preview.automacaojs.us/leitor-inteligente/#/store',
            metadata=checkout_metadata,
        )
    except Exception as e:
        print(f'[checkout/redirect] erro provider: {e}', flush=True)
        return redirect(
            f'https://preview.automacaojs.us/leitor-inteligente/#/store?error=provider_failed'
        )

    purchase_payload = {
        'user_id': customer_id or customer_email,
        'ebook_id': ebook_id,
        'amount_cents': amount_cents,
        'currency': 'BRL',
        'payment_method': provider.name,
        'payment_id': session.external_id or 'pending',
        'status': 'pending',
    }
    if traffic_source:
        purchase_payload['traffic_source'] = traffic_source
    _supabase_post('purchases', purchase_payload)

    return redirect(session.checkout_url, code=302)


@app.route('/api/checkout/create', methods=['POST'])
def checkout_create():
    """Cria checkout dinâmico via provider."""
    data = request.get_json(silent=True) or {}
    ebook_slug = data.get('ebook_slug')
    customer_email = data.get('customer_email')
    customer_id = data.get('customer_id')
    traffic_source = data.get('traffic_source')  # instagram/youtube/whatsapp/outro
    success_url = data.get('success_url', 'https://preview.automacaojs.us/leitor-inteligente/#/library')
    cancel_url = data.get('cancel_url', 'https://preview.automacaojs.us/leitor-inteligente/#/store')

    if not (ebook_slug and customer_email):
        return jsonify({'ok': False, 'error': 'ebook_slug e customer_email obrigatórios'}), 400

    # 1. Busca ebook
    status, body = _supabase_get(f'ebooks?slug=eq.{ebook_slug}&select=id,title,price_cents,slug,shareable')
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
    if ebook.get('shareable') is False:
        return jsonify({'ok': False, 'error': 'ebook não-divulgável (shareable=false)'}), 403

    # 2. Cria checkout via provider
    provider = get_provider()
    checkout_metadata = {'traffic_source': traffic_source} if traffic_source else None
    try:
        session = provider.create_checkout(
            amount_cents=amount_cents,
            product_name=product_name,
            product_id=ebook_slug,
            customer_email=customer_email,
            customer_id=customer_id or customer_email,
            success_url=success_url,
            cancel_url=cancel_url,
            metadata=checkout_metadata,
        )
    except Exception as e:
        return jsonify({'ok': False, 'error': f'erro Cakto: {e}'}), 500

    # 3. Cria purchase 'pending' pra rastreamento
    purchase_payload = {
        'user_id': customer_id or customer_email,
        'ebook_id': ebook_id,
        'amount_cents': amount_cents,
        'currency': 'BRL',
        'payment_method': provider.name,
        'payment_id': session.external_id or 'pending',
        'status': 'pending',
    }
    if traffic_source:
        purchase_payload['traffic_source'] = traffic_source
    _supabase_post('purchases', purchase_payload)

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
@app.route('/api/mercadopago/webhook', methods=['POST'])
@app.route('/api/webhook/<provider_name>', methods=['POST'])
def webhook(provider_name: str = 'cakto'):
    """Recebe notificação de pagamento do provider.

    REFATORAÇÃO 19/08/2026: payment_id (pay_xxx) é a fonte primária de verdade.
    Webhook busca purchase por payment_id e usa user_id/ebook_id/traffic_source
    daí. externalReference só é usado como hint (upload vs ebook) e ignora
    truncamento do Asaas (email/uid somiam em 35 chars).

    MP webhook NÃO tem HMAC — passamos query (request.args) pro verify_webhook
    pq o IPN legacy vem com data_id no query. Webhook v2 vem no body JSON.
    """
    raw_body = request.get_data()
    headers = {k: v for k, v in request.headers.items()}
    query = request.args.to_dict()

    provider = get_provider()
    event = provider.verify_webhook(headers, raw_body, query=query)
    if event is None:
        return jsonify({'ok': False, 'error': 'assinatura inválida'}), 401

    event_type = provider.get_event_type(event).lower()
    # Aceita variações: Cakto='order.paid', Asaas='PAYMENT_RECEIVED'/'PAYMENT_CONFIRMED'
    if not any(t in event_type for t in ('paid', 'approved', 'succeeded', 'completed', 'received', 'confirmed')):
        return jsonify({'ok': True, 'ignored': True, 'event_type': event_type})

    order_id = provider.get_order_id(event)
    if not order_id:
        return jsonify({'ok': False, 'error': 'event sem order_id'}), 400
    amount = provider.get_order_amount_cents(event)
    meta = provider.get_order_metadata(event)
    is_upload = meta.get('is_upload', False)

    # === FLUXO UPLOAD ===
    # externalReference == 'upload' é o gatilho. user_id vem de upload_payments
    # (tabela dedicada — purchases.ebook_id é NOT NULL, não cabe upload lá).
    if is_upload:
        upload_row = _lookup_upload_payment(order_id)
        if not upload_row:
            return jsonify({
                'ok': False,
                'error': f'upload_payments não encontrada pra payment {order_id}',
            }), 404
        user_id = upload_row['user_id']
        traffic_source = upload_row.get('traffic_source')
        paid_at_iso = datetime.now(timezone.utc).isoformat()
        # Idempotente: usa upsert via asaas_payment_id UNIQUE
        upsert_body = {
            'user_id': user_id,
            'asaas_payment_id': order_id,
            'paid_at': paid_at_iso,
            'expires_at': None,  # Não usado no modelo novo (era 365d)
            'consumed_at': None,  # Marcado por upload_book.py quando indexação termina
            'amount_cents': amount or 1000,  # R$10 — mínimo Asaas sandbox pra UNDEFINED é R$5
        }
        if traffic_source:
            upsert_body['traffic_source'] = traffic_source
        upsert_headers = {
            'apikey': SUPABASE_SR,
            'Authorization': f'Bearer {SUPABASE_SR}',
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=representation',
        }
        upsert_req = urllib.request.Request(
            f'{SUPABASE_URL}/rest/v1/upload_payments',
            data=json.dumps(upsert_body).encode(),
            headers=upsert_headers,
            method='POST',
        )
        try:
            with urllib.request.urlopen(upsert_req, timeout=15) as r:
                inserted = json.loads(r.read())
                print(f'[webhook] upload_payments: {len(inserted)} row(s) pra user={user_id}', flush=True)
        except urllib.error.HTTPError as e:
            err_body = e.read().decode('utf-8', errors='ignore')[:300]
            # 23505 = duplicate key — webhook duplicado. Idempotente: retorna 200 sem erro.
            if e.code == 409 or '23505' in err_body or 'duplicate' in err_body.lower():
                print(f'[webhook] upload_payments já existe pra payment={order_id}, idempotente', flush=True)
                return jsonify({
                    'ok': True,
                    'kind': 'upload_payment',
                    'user_id': user_id,
                    'idempotent': True,
                })
            print(f'[webhook] ERRO upload_payments HTTP {e.code}: {err_body}', flush=True)
            return jsonify({'ok': False, 'error': f'falha ao registrar upload_payment: {err_body}'}), 500
        return jsonify({
            'ok': True,
            'kind': 'upload_payment',
            'user_id': user_id,
            'amount_cents': amount or 1000,  # R$10 — mínimo Asaas sandbox pra UNDEFINED é R$5
            'asaas_payment_id': order_id,
        })

    # === FLUXO EBOOK ===
    # Source of truth: purchases.payment_id. Asaas devolve payment.id no webhook
    # (pay_xxx, nunca truncado). Buscamos a purchase criada em checkout_redirect
    # e tiramos user_id/ebook_id/traffic_source dela. Se não existir, aborta.
    purchase = _lookup_purchase_by_payment_id(order_id)
    if not purchase:
        return jsonify({
            'ok': False,
            'error': f'purchase não encontrada pra payment_id={order_id}. '
                     f'Checkout_redirect precisa rodar antes do webhook.',
        }), 404
    user_id = purchase['user_id']
    ebook_id = purchase['ebook_id']
    traffic_source = purchase.get('traffic_source')
    purchase_amount = purchase.get('amount_cents')

    # Libera (idempotente: _release_ebook já checa purchase.payment_id)
    result = _release_ebook(
        user_id=user_id,
        ebook_id=ebook_id,
        amount_cents=amount or purchase_amount or 0,
        payment_id=order_id,
        payment_method=provider.name,
    )
    result['kind'] = 'ebook_purchase'
    result['user_id'] = user_id
    result['ebook_id'] = ebook_id
    if traffic_source:
        result['traffic_source'] = traffic_source

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


# ============================================================
# UPLOAD FEE — checkout + access check (Asaas sandbox)
# ============================================================
# Padrão: externalReference = "upload|<user_id>|<email>"
# Webhook Asaas detecta ebook_slug == 'upload' e grava em upload_payments.
# Frontend faz polling em /api/upload/access pra liberar botão de upload.

@app.route('/api/upload/create-checkout', methods=['POST'])
def upload_create_checkout():
    """Cria payment Asaas de R$10 pra liberar 1 acesso de upload (365 dias)."""
    data = request.get_json(silent=True) or {}
    user_id = data.get('user_id')
    user_email = data.get('user_email')
    success_url = data.get('success_url')
    cancel_url = data.get('cancel_url')

    if not (user_id and user_email):
        return jsonify({'ok': False, 'error': 'user_id e user_email obrigatórios'}), 400

    provider = get_provider()
    try:
        session = provider.create_checkout(
            product_id='upload',  # gatilho que o webhook detecta
            product_name='Taxa de processamento de livro (Leitor Inteligente) - R$10',
            amount_cents=1000,  # R$10 — mínimo do Asaas sandbox pra billingType=UNDEFINED é R$5
            customer_id=user_id,
            customer_email=user_email,
            success_url=success_url or 'https://preview.automacaojs.us/leitor-inteligente/#/upload',
            cancel_url=cancel_url or 'https://preview.automacaojs.us/leitor-inteligente/#/upload',
        )
    except Exception as e:
        return jsonify({'ok': False, 'error': f'falha ao criar checkout: {e}'}), 500

    # Grava upload_payments ANTES do redirect (mesmo padrão do ebook).
    # Webhook Asaas busca user_id/traffic_source aqui e atualiza paid_at.
    # Sem essa row, webhook upload_payments quebra (mesmo bug do ebook, agora resolvido junto).
    traffic_source = data.get('traffic_source')  # instagram/youtube/whatsapp/outro
    upsert_body = {
        'user_id': user_id,
        'asaas_payment_id': session.external_id or 'pending',
        # NÃO mandar paid_at: coluna é NOT NULL com default now(). Se mandarmos
        # explicitamente None, viola o constraint (23502). Webhook faz UPDATE
        # com timestamp real quando pagamento cai.
        'expires_at': None,
        'consumed_at': None,
        'amount_cents': 1000,  # R$10 — bate com o amount_cents do Asaas payment acima
    }
    if traffic_source:
        upsert_body['traffic_source'] = traffic_source
    upsert_headers = {
        'apikey': SUPABASE_SR,
        'Authorization': f'Bearer {SUPABASE_SR}',
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation',
    }
    upsert_req = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/upload_payments',
        data=json.dumps(upsert_body).encode(),
        headers=upsert_headers,
        method='POST',
    )
    try:
        with urllib.request.urlopen(upsert_req, timeout=15) as r:
            r.read()  # consome body; não precisamos do retorno
            print(f'[upload/create-checkout] upload_payments PENDING criado pra payment={session.external_id}', flush=True)
    except urllib.error.HTTPError as e:
        err = e.read().decode('utf-8', errors='ignore')[:200]
        print(f'[upload/create-checkout] WARN ao criar upload_payments PENDING: {e.code} {err[:800]}', flush=True)
        # Não bloqueia — webhook pode INSERT ON CONFLICT na próxima iteração futura.
        # (Por ora, sem row pre-pendente, webhook upload falharia com 404. Melhor bloquear.)

    return jsonify({
        'ok': True,
        'checkout_url': session.checkout_url,
        'external_id': session.external_id,
        'amount_cents': 1000,  # R$10 — bate com o amount_cents do create-checkout
    })


@app.route('/api/upload/access', methods=['GET'])
def upload_access():
    """Verifica se o user tem upload_payments válida (não expirada).

    Query: ?user_id=<uuid>
    Retorna: { ok, has_access, expires_at, amount_cents, paid_at }
    """
    user_id = request.args.get('user_id')
    if not user_id:
        return jsonify({'ok': False, 'error': 'user_id obrigatório'}), 400

    # Busca a última upload_payments do user, ordenada por paid_at desc
    status, body = _supabase_get(
        f'upload_payments?user_id=eq.{user_id}&order=paid_at.desc&limit=1'
    )
    if status != 200:
        return jsonify({'ok': False, 'error': f'falha ao consultar: {body[:200]}'}), 500

    try:
        rows = json.loads(body) if body.strip() else []
    except Exception:
        rows = []

    if not rows:
        return jsonify({'ok': True, 'has_access': False, 'reason': 'no_payment'})

    row = rows[0]
    # Modelo novo: 1 pagamento por livro. Acesso = consumed_at IS NULL.
    # Quando upload_book.py termina a indexação, chama /api/upload/mark-consumed
    # e fecha o canal. Próximo upload exige novo pagamento.
    consumed_at = row.get('consumed_at')
    if consumed_at:
        return jsonify({
            'ok': True,
            'has_access': False,
            'reason': 'already_consumed',
            'consumed_at': consumed_at,
            'paid_at': row.get('paid_at'),
            'amount_cents': row.get('amount_cents'),
        })

    return jsonify({
        'ok': True,
        'has_access': True,
        'consumed_at': None,
        'paid_at': row.get('paid_at'),
        'amount_cents': row.get('amount_cents'),
    })


@app.route('/api/upload/mark-consumed', methods=['POST'])
def upload_mark_consumed():
    """Marca upload_payments.consumed_at=now() quando livro terminou de indexar.

    Chamado por upload_book.py ao fim do upload_job (todas páginas processadas).
    Idempotente: se já consumido, retorna 200 sem mudar nada.

    Body JSON: { asaas_payment_id?: <id>, ebook_id?: <uuid>, user_id?: <uuid> }
    user_id é o do UPLOADER (não do ebook). Se vier, evita ambiguidade quando
    ebook_id é compartilhado entre múltiplos users.
    """
    data = request.get_json(silent=True) or {}
    asaas_payment_id = data.get('asaas_payment_id')
    ebook_id = data.get('ebook_id')
    user_id_override = data.get('user_id')

    if not (asaas_payment_id or ebook_id):
        return jsonify({'ok': False, 'error': 'asaas_payment_id ou ebook_id obrigatório'}), 400

    from datetime import datetime, timezone
    consumed_iso = datetime.now(timezone.utc).isoformat()

    if asaas_payment_id:
        # Caminho direto: marca 1 row específica
        path = f'upload_payments?asaas_payment_id=eq.{asaas_payment_id}'
        patch_body = {'consumed_at': consumed_iso}
        if ebook_id:
            patch_body['ebook_id'] = ebook_id
    elif ebook_id:
        # Tem ebook_id → acha o user_id correto
        if user_id_override:
            user_id = user_id_override
        else:
            sl_status, sl_body = _supabase_get(
                f'user_library?ebook_id=eq.{ebook_id}&select=user_id&limit=1'
            )
            try:
                user_libs = json.loads(sl_body) if sl_body.strip() else []
                if not user_libs:
                    return jsonify({'ok': False, 'error': 'user_library não encontrada'}), 404
                user_id = user_libs[0]['user_id']
            except Exception as e:
                return jsonify({'ok': False, 'error': f'parse user_library: {e}'}), 500

        # Pega o 1º upload_payments NÃO CONSUMIDO do user (ordem por paid_at ASC)
        # ASC pra que o pagamento MAIS ANTIGO seja consumido primeiro (FIFO).
        path = f'upload_payments?user_id=eq.{user_id}&consumed_at=is.null&order=paid_at.asc&limit=1'
        patch_body = {'consumed_at': consumed_iso, 'ebook_id': ebook_id}

    status, body = _supabase_patch(path, patch_body)

    if status not in (200, 201, 204):
        return jsonify({'ok': False, 'error': f'PATCH falhou: {status} {body[:200]}'}), 500

    return jsonify({'ok': True, 'consumed_at': consumed_iso, 'user_id': user_id if ebook_id and not asaas_payment_id else None})


if __name__ == '__main__':
    import os
    port = int(os.environ.get('PAYMENT_PORT', '3019'))
    print(f"💳 Payment server starting on :{port}")
    app.run(host='0.0.0.0', port=port, debug=False)
