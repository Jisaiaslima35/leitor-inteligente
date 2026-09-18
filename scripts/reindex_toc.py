#!/usr/bin/env python3
"""Script para extrair e preencher o TOC estruturado de e-books existentes."""
import json
import os
import sys
import tempfile
from urllib.request import Request, urlopen

sys.path.insert(0, '/root/projetos/leitor-inteligente/api')
from upload_book import extract_toc, SUPABASE_URL, SUPABASE_SR

def supa_get(path):
    req = Request(
        f'{SUPABASE_URL}/rest/v1/{path}',
        headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}'},
    )
    with urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def supa_patch(table, filters, body):
    req = Request(
        f'{SUPABASE_URL}/rest/v1/{table}?{filters}',
        data=json.dumps(body).encode(),
        headers={
            'apikey': SUPABASE_SR,
            'Authorization': f'Bearer {SUPABASE_SR}',
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        },
        method='PATCH',
    )
    with urlopen(req, timeout=15) as r:
        return True

def download_pdf(storage_path: str, local_path: str) -> bool:
    try:
        sign_req = Request(
            f'{SUPABASE_URL}/storage/v1/object/sign/ebooks/{storage_path}',
            data=json.dumps({'expiresIn': 300}).encode(),
            headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}',
                     'Content-Type': 'application/json'},
            method='POST'
        )
        with urlopen(sign_req, timeout=15) as r:
            sign = json.loads(r.read())
            signed_path = sign.get('signedURL') or sign.get('signedUrl')
        if not signed_path:
            return False
        dl_url = f'{SUPABASE_URL}/storage/v1{signed_path}'
        with urlopen(dl_url, timeout=60) as r:
            with open(local_path, 'wb') as f:
                f.write(r.read())
        return True
    except Exception as e:
        print(f"   Erro download {storage_path}: {e}")
        return False

def main():
    print("Iniciando reindexação de TOC...")
    ebooks = supa_get('ebooks?select=id,slug,title,pdf_storage_path,total_pages,toc&order=created_at.desc&limit=50')
    print(f"Total de {len(ebooks)} ebooks carregados do Supabase.")

    with tempfile.TemporaryDirectory() as tmp_dir:
        for eb in ebooks:
            eb_id = eb['id']
            slug = eb['slug']
            title = eb['title']
            storage_path = eb.get('pdf_storage_path')
            existing_toc = eb.get('toc')

            if existing_toc and len(existing_toc) > 0:
                print(f"⏩ [SKIP] {slug} já possui TOC com {len(existing_toc)} itens.")
                continue

            if not storage_path:
                print(f"⚠️ [SEM PATH] {slug} não tem pdf_storage_path.")
                continue

            local_pdf = os.path.join(tmp_dir, f"{slug}.pdf")
            print(f"📥 Baixando {slug} ({storage_path})...")
            if not download_pdf(storage_path, local_pdf):
                continue

            # Busca algumas páginas para fallback se necessário
            pages_data = []
            try:
                raw_pages = supa_get(f'ebook_pages?select=page_number,page_text&ebook_id=eq.{eb_id}&order=page_number&limit=2000')
                pages_data = [{'page': p['page_number'], 'text': p.get('page_text') or ''} for p in raw_pages]
            except Exception as e:
                print(f"   Aviso ao buscar ebook_pages: {e}")

            toc = extract_toc(local_pdf, pages_data)
            print(f"✅ TOC extraído para '{title}': {len(toc)} marcadores encontrados.")
            if len(toc) > 0:
                supa_patch('ebooks', f'id=eq.{eb_id}', {'toc': toc})
                print(f"💾 TOC salvo com sucesso no Supabase para {slug}!")
            else:
                print(f"ℹ️ Nenhum marcador detectado para {slug}.")

            if os.path.exists(local_pdf):
                os.remove(local_pdf)

    print("\nReindexação de TOC concluída!")

if __name__ == '__main__':
    main()
