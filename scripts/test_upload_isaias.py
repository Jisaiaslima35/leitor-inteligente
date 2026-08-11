#!/usr/bin/env python3
"""Test upload: sobe o PDF 21 Dias como Isaías via service role.

Valida o pipeline completo do upload_book.py:
- upload pra Storage
- cria ebook row
- roda run_pipeline (detecta OCR, extrai páginas, embeddings, user_library)

Uso: python3 scripts/test_upload_isaias.py
"""
import sys, os, time, threading, json
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

# config
SUPABASE_ENV = {}
for line in Path('/root/.hermes/secrets/leitor-supabase.env').read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        SUPABASE_ENV[line.split('=', 1)[0]] = line.split('=', 1)[1]

SUPABASE_URL = SUPABASE_ENV['SUPABASE_URL']
SR = SUPABASE_ENV['SUPABASE_SERVICE_ROLE']

USER_ID = 'cde6c277-569f-4e4a-8fff-1efebcceae39'  # isaiassilva356@gmail.com (admin)
EMAIL = 'isaiassilva356@gmail.com'

PDF_PATH = '/root/.claude/channels/telegram/inbox/1785799337046-AgAD7AgAAuIJiEc.pdf'
TITLE = '21 Dias Para Curar a Sua Vida'
AUTHOR = 'Louise Hay'

# Sanitiza filename
import re, unicodedata
def sanitize(name):
    name = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode('ascii')
    name = re.sub(r'[^a-zA-Z0-9._-]', '_', name)
    if not name.endswith('.pdf'):
        name += '.pdf'
    return name[:80]

TS = int(time.time())
FILENAME = sanitize('21_dias_curar_vida.pdf')
STORAGE_PATH = f'{USER_ID}/tmp/{TS}_{FILENAME}'

def supa(path, method='GET', body=None, headers=None):
    h = {'apikey': SR, 'Authorization': f'Bearer {SR}'}
    if body is not None and 'Content-Type' not in (headers or {}):
        h['Content-Type'] = 'application/json'
    if headers:
        h.update(headers)
    data = json.dumps(body).encode() if body is not None else None
    req = Request(f'{SUPABASE_URL}{path}', data=data, headers=h, method=method)
    try:
        with urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except HTTPError as e:
        return e.code, e.read().decode()[:500]

def main():
    print(f'USER_ID: {USER_ID}')
    print(f'STORAGE_PATH: {STORAGE_PATH}')
    print()

    # 1. Upload PDF pro Storage
    print('[1] Upload PDF pro Storage...')
    pdf_bytes = open(PDF_PATH, 'rb').read()
    up_req = Request(
        f'{SUPABASE_URL}/storage/v1/object/ebooks/{STORAGE_PATH}',
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
            print(f'  OK (HTTP {r.status}) — {len(pdf_bytes)} bytes')
    except HTTPError as e:
        print(f'  ERRO HTTP {e.code}: {e.read().decode()[:300]}')
        return

    # 2. Cria ebook row
    print('[2] Cria ebook row...')
    from datetime import datetime
    slug = '21-dias-para-curar-a-sua-vida-' + datetime.now().strftime('%Y%m%d%H%M%S')
    ebook_code, ebook = supa(
        '/rest/v1/ebooks',
        method='POST',
        body={
            'slug': slug,
            'title': TITLE,
            'author': AUTHOR,
            'description': f'Enviado por Claudinho (teste pipeline) em {datetime.now().isoformat()}',
            'pdf_storage_path': STORAGE_PATH,
            'total_pages': 132,
            'price_cents': 0,
            'owner_user_id': USER_ID,
            'is_published': True,
        },
        headers={
            'Prefer': 'return=representation',
        }
    )
    if ebook_code != 201:
        print(f'  ERRO ebook_code={ebook_code}: {ebook}')
        return
    ebook_id = ebook[0]['id']
    print(f'  OK ebook_id={ebook_id} slug={slug}')

    # 3. Trigger run_pipeline
    print('[3] Disparando run_pipeline()...')
    sys.path.insert(0, '/root/projetos/leitor-inteligente/api')
    from upload_book import run_pipeline

    t = threading.Thread(
        target=run_pipeline,
        args=(USER_ID, ebook_id, STORAGE_PATH, TITLE, AUTHOR, 132),
        daemon=True,
    )
    t.start()
    print(f'  Thread iniciada. ebook_id={ebook_id}')
    print(f'  Acompanhe logs: journalctl -u leitor-upload-api.service -f')
    print()
    print(f'TESTE CONCLUÍDO. Aguarde ~7min (132p × 3s/pág).')
    print(f'Verifique user_library em:')
    print(f'  {SUPABASE_URL}/rest/v1/user_library?user_id=eq.{USER_ID}&select=ebook_id,ebooks(slug,title)')

if __name__ == '__main__':
    main()
