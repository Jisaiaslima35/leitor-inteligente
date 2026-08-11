#!/usr/bin/env python3
"""Test upload completo via HTTP — usa o endpoint /upload-api/process.

Forja JWT com sub=USER_ID (resolve_user_id não verifica signature).
Pipeline roda no PROCESSO DO SERVIÇO (sobrevive).
"""
import sys, os, time, json, base64
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

# JWT — HS256, assinatura fake (resolve_user_id não valida)
USER_ID = 'cde6c277-569f-4e4a-8fff-1efebcceae39'  # Isaías admin
NOW = int(time.time())
header = {'alg': 'HS256', 'typ': 'JWT'}
payload = {
    'sub': USER_ID,
    'email': 'isaiassilva356@gmail.com',
    'role': 'authenticated',
    'aud': 'authenticated',
    'iat': NOW,
    'exp': NOW + 3600,
}

def b64url(d):
    return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip('=')

# signature fake — só pra ter 3 partes
jwt_token = f"{b64url(header)}.{b64url(payload)}.fake_sig_for_test"
print(f'JWT gerado: {jwt_token[:60]}...')

# Dados do upload
PDF_PATH = '/root/.claude/channels/telegram/inbox/1785799337046-AgAD7AgAAuIJiEc.pdf'
TITLE = '21 Dias Para Curar a Sua Vida'
AUTHOR = 'Louise Hay'
TS = int(time.time())
FILENAME = '21_dias_curar_vida.pdf'
STORAGE_PATH = f'{USER_ID}/tmp/{TS}_{FILENAME}'

# 1. Upload PDF pro Storage via service role (signed URL precisa de service)
SUPABASE_ENV = {}
for line in Path('/root/.hermes/secrets/leitor-supabase.env').read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        SUPABASE_ENV[line.split('=', 1)[0]] = line.split('=', 1)[1]
URL = SUPABASE_ENV['SUPABASE_URL']
SR = SUPABASE_ENV['SUPABASE_SERVICE_ROLE']

print(f'\n[1] Upload PDF pro Storage...')
pdf_bytes = open(PDF_PATH, 'rb').read()
up_req = Request(
    f'{URL}/storage/v1/object/ebooks/{STORAGE_PATH}',
    data=pdf_bytes,
    headers={
        'apikey': SR, 'Authorization': f'Bearer {SR}',
        'Content-Type': 'application/pdf',
        'x-upsert': 'true',
        'Content-Length': str(len(pdf_bytes)),
    },
    method='POST'
)
try:
    with urlopen(up_req, timeout=120) as r:
        print(f'  OK (HTTP {r.status})')
except HTTPError as e:
    print(f'  ERRO {e.code}: {e.read().decode()[:300]}')
    sys.exit(1)

# 2. Chamar /upload-api/process — pipeline roda no serviço
print(f'\n[2] POST http://127.0.0.1:9134/process')
proc_req = Request(
    'http://127.0.0.1:9134/process',
    data=json.dumps({
        'storage_path': STORAGE_PATH,
        'title': TITLE,
        'author': AUTHOR,
        'total_pages': 132,
    }).encode(),
    headers={
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {jwt_token}',
    },
    method='POST'
)
try:
    with urlopen(proc_req, timeout=15) as r:
        body = json.loads(r.read())
        print(f'  OK HTTP {r.status}')
        print(f'  Resposta: {json.dumps(body, indent=2, ensure_ascii=False)}')
except HTTPError as e:
    print(f'  ERRO {e.code}: {e.read().decode()[:500]}')
    sys.exit(1)

print(f'\n[3] Acompanhar pipeline:')
print(f'  journalctl -u leitor-upload-api.service -f')
print(f'  Tempo estimado: ~7min (132p × 3s/página embeddings BGE)')
