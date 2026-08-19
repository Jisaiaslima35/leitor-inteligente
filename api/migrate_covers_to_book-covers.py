#!/usr/bin/env python3
"""Migração: consertar capas dos livros antigos.

Bug: upload_book.py gravava cover.jpg no bucket PRIVADO 'ebooks' (path
user_id/ebook_id/cover.jpg) e montava URL com /public/ebooks/... que retorna 400
porque o bucket é privado. URL pública só funciona em buckets públicos.

Este script:
1. Lista todos ebooks com cover_url apontando pro bucket errado (path com user_id)
2. Pra cada um, baixa o PDF do bucket 'ebooks' via signed URL
3. Extrai capa via cover_extractor.extract_cover
4. Sobe no bucket PÚBLICO 'book-covers' (path {ebook_id}/cover.jpg)
5. Atualiza cover_url no Supabase com URL pública correta

Rodar: cd /root/projetos/leitor-inteligente && python3 api/migrate_covers_to_book-covers.py
"""
import json
import os
import sys
import tempfile
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

# Carrega envs do cofre
SUPABASE_ENV = {}
for line in Path('/root/.hermes/secrets/leitor-supabase.env').read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        SUPABASE_ENV[line.split('=', 1)[0]] = line.split('=', 1)[1]

SUPABASE_URL = SUPABASE_ENV['SUPABASE_URL']
SUPABASE_SR = SUPABASE_ENV['SUPABASE_SERVICE_ROLE']

# Adiciona path do projeto pra imports
sys.path.insert(0, '/root/projetos/leitor-inteligente')
from api.cover_extractor import extract_cover


def supabase_get(path):
    req = Request(
        f'{SUPABASE_URL}/rest/v1/{path}',
        headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}'},
    )
    try:
        r = urlopen(req, timeout=15)
        return (r.status, r.read().decode('utf-8'))
    except HTTPError as e:
        return (e.code, e.read().decode('utf-8', errors='replace'))


def supabase_patch(path, body):
    req = Request(
        f'{SUPABASE_URL}/rest/v1/{path}',
        data=json.dumps(body).encode(),
        headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}',
                 'Content-Type': 'application/json', 'Prefer': 'return=representation'},
        method='PATCH',
    )
    try:
        r = urlopen(req, timeout=15)
        return (r.status, r.read().decode('utf-8'))
    except HTTPError as e:
        return (e.code, e.read().decode('utf-8', errors='replace'))


def get_signed_url(bucket, path, expires=300):
    """Pega signed URL temporária pra download. Endpoint Supabase Storage v1.

    POST /storage/v1/object/sign/{bucket}/{path}
    Body: {"expiresIn": <seg>}
    Returns: {"signedURL": "/object/sign/...?token=<jwt>"} (relativo à /storage/v1)
    """
    req = Request(
        f'{SUPABASE_URL}/storage/v1/object/sign/{bucket}/{path}',
        data=json.dumps({'expiresIn': expires}).encode(),
        headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}',
                 'Content-Type': 'application/json'},
        method='POST'
    )
    try:
        with urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
            signed = data.get('signedURL') or data.get('signed_url')
            if not signed:
                return None
            # signed é "/object/sign/..." → prepende /storage/v1
            if signed.startswith('http'):
                return signed
            return f'{SUPABASE_URL}/storage/v1{signed}'
    except Exception as e:
        print(f'  [sign] erro: {e}')
        return None


def list_objects(bucket, prefix):
    """Lista objetos recursivamente."""
    req = Request(
        f'{SUPABASE_URL}/storage/v1/object/list/{bucket}',
        data=json.dumps({'prefix': prefix, 'limit': 100}).encode(),
        headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}',
                 'Content-Type': 'application/json'},
        method='POST'
    )
    try:
        with urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f'  [list] erro: {e}')
        return []


def upload_cover_public(ebook_id, cover_local_path):
    """Sobe cover.jpg pro bucket público book-covers e retorna URL pública."""
    cover_path = f'{ebook_id}/cover.jpg'
    # 1. Pega signed upload token
    sign_req = Request(
        f'{SUPABASE_URL}/storage/v1/object/upload/sign/book-covers/{cover_path}',
        headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}'},
        method='POST'
    )
    try:
        with urlopen(sign_req, timeout=15) as r:
            token = json.loads(r.read())['token']
    except Exception as e:
        return None, f'sign falhou: {e}'

    # 2. PUT bytes
    with open(cover_local_path, 'rb') as f:
        cover_bytes = f.read()
    up_req = Request(
        f'{SUPABASE_URL}/storage/v1/object/upload/sign/book-covers/{cover_path}?token={token}',
        data=cover_bytes,
        headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}',
                 'Content-Type': 'image/jpeg', 'x-upsert': 'true'},
        method='PUT'
    )
    try:
        with urlopen(up_req, timeout=30) as r:
            json.loads(r.read())
    except Exception as e:
        return None, f'put falhou: {e}'

    public_url = f'{SUPABASE_URL}/storage/v1/object/public/book-covers/{cover_path}'
    return public_url, None


def main():
    print('=== Migração de capas: ebooks privado → book-covers público ===')
    print(f'{SUPABASE_URL}\n')

    # 1. Lista ebooks ANTIGOS com cover_url errado (path com user_id)
    # Critério: cover_url contém '/object/public/ebooks/' OU cover_url IS NULL
    # E owner_user_id IS NOT NULL (foi upload do user — não catalog público)
    status, body = supabase_get(
        'ebooks?select=id,slug,title,cover_url,owner_user_id'
        '&or=(cover_url.ilike.*public/ebooks*,cover_url.is.null)'
        '&order=created_at.desc&limit=100'
    )
    if status != 200:
        print(f'erro listando ebooks: {status} {body[:200]}')
        return 1
    ebooks = json.loads(body)
    print(f'Encontrados {len(ebooks)} ebooks pra migrar\n')

    ok, fail, skip = 0, 0, 0
    for e in ebooks:
        eid = e['id']
        slug = e['slug']
        title = e.get('title') or slug
        owner = e['owner_user_id']

        print(f'[{slug}] {title}')
        if not owner:
            print(f'  → SKIP (sem owner_user_id, provavelmente catalog)')
            skip += 1
            continue

        # 2. Acha o PDF no bucket privado
        # Tentativa 1: storage_path gravado no upload
        # Pattern antigo: {user_id}/{ebook_id}/livro.pdf
        pdf_candidates = [
            f'{owner}/{eid}/livro.pdf',
            f'{owner}/{eid}/{slug}.pdf',
            f'{slug}.pdf',
        ]
        pdf_path = None
        for cand in pdf_candidates:
            # Pega signed URL
            url = get_signed_url('ebooks', cand)
            if not url:
                # Tenta via render TUS/resumable — pula
                continue
            # Testa se o GET funciona (200)
            try:
                head = Request(url, method='HEAD')
                with urlopen(head, timeout=10) as r:
                    if r.status == 200:
                        pdf_path = cand
                        pdf_url = url
                        break
            except Exception:
                continue

        if not pdf_path:
            print(f'  → FAIL (PDF não encontrado em ebooks: tentou {pdf_candidates})')
            fail += 1
            continue

        # 3. Baixa o PDF
        with tempfile.TemporaryDirectory() as tmp:
            local_pdf = f'{tmp}/livro.pdf'
            with urlopen(pdf_url, timeout=30) as r:
                pdf_bytes = r.read()
            with open(local_pdf, 'wb') as f:
                f.write(pdf_bytes)
            print(f'  PDF baixado: {len(pdf_bytes):,} bytes (path: {pdf_path})')

            # 4. Extrai capa
            cover_local = f'{tmp}/cover.jpg'
            extracted = extract_cover(local_pdf, cover_local, max_pages=5)
            if not extracted or not os.path.exists(extracted):
                print(f'  → FAIL (extract_cover retornou None)')
                fail += 1
                continue
            print(f'  Capa extraída: {os.path.getsize(extracted):,} bytes')

            # 5. Sobe no bucket público
            new_url, err = upload_cover_public(eid, cover_local)
            if err:
                print(f'  → FAIL (upload: {err})')
                fail += 1
                continue

        # 6. Atualiza cover_url no Supabase
        status, body = supabase_patch(
            f'ebooks?id=eq.{eid}',
            {'cover_url': new_url}
        )
        if status not in (200, 201, 204):
            print(f'  → FAIL (PATCH: {status} {body[:200]})')
            fail += 1
            continue
        print(f'  ✓ OK: {new_url}')
        ok += 1

    print(f'\n=== Resumo: {ok} ok, {fail} falhas, {skip} skips ===')
    return 0 if fail == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
