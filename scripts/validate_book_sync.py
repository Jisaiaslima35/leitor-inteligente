#!/usr/bin/env python3
"""
validate_book_sync.py — Valida sincronização entre PDF local, pages.json e Supabase.

Uso:
    python3 scripts/validate_book_sync.py [--slug NAME]

Verifica:
1. PDF existe e tem N páginas
2. pages.json tem N entradas com page_number 1..N
3. Supabase ebook_pages tem N registros com mesmo N de páginas
4. Texto da página X no JSON bate (primeiros 80 chars) com Supabase

Se algum falhar, mostra onde tá a dessincronização.

EXIT CODES:
    0 = tudo sincronizado
    1 = alguma dessincronização detectada
"""
import argparse, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / 'api'))
from urllib.request import Request, urlopen


def env(name):
    for line in open('/root/.hermes/secrets/leitor-supabase.env'):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line and line.split('=', 1)[0] == name:
            return line.split('=', 1)[1].strip()
    sys.exit(f'env não definida: {name}')


def check(slug):
    URL = env('SUPABASE_URL')
    SR = env('SUPABASE_SERVICE_ROLE')

    # 1. PDF
    pdf_path = Path(f'/root/projetos/leitor-inteligente/source.pdf')
    if not pdf_path.exists():
        print(f'❌ PDF não existe: {pdf_path}')
        return 1
    try:
        import fitz
        doc = fitz.open(pdf_path)
        pdf_pages = len(doc)
        print(f'✅ PDF: {pdf_pages} páginas')
        doc.close()
    except Exception as e:
        print(f'❌ Erro abrindo PDF: {e}')
        return 1

    # 2. JSON local
    json_path = Path(f'/root/projetos/leitor-inteligente/data/{slug}-pages.json')
    if not json_path.exists():
        print(f'❌ JSON local não existe: {json_path}')
        return 1
    try:
        pages = json.loads(json_path.read_text(encoding='utf-8'))
        # Detecta formato: page ou page_number
        sample = pages[0]
        key = 'page' if 'page' in sample else 'page_number'
        json_pages = len(pages)
        json_page_nums = [p[key] for p in pages]
        ok = json_page_nums == list(range(1, json_pages + 1))
        if not ok:
            print(f'❌ JSON: {json_pages} páginas mas page_numbers não são 1..N (falta ou duplica)')
            print(f'   primeiros: {json_page_nums[:5]}')
            print(f'   últimos:   {json_page_nums[-5:]}')
            return 1
        print(f'✅ JSON local: {json_pages} páginas, contíguas 1..N')
    except Exception as e:
        print(f'❌ Erro lendo JSON: {e}')
        return 1

    # 3. Supabase
    try:
        # Resolve ebook_id
        path = f'/rest/v1/ebooks?select=id&slug=eq.{slug}&limit=1'
        req = Request(f'{URL}{path}', headers={'apikey': SR, 'Authorization': f'Bearer {SR}'})
        rows = json.loads(urlopen(req, timeout=10).read())
        if not rows:
            print(f'❌ Supabase: nenhum ebook com slug={slug}')
            return 1
        ebook_id = rows[0]['id']

        # Conta páginas no Supabase
        path = f'/rest/v1/ebook_pages?select=page_number&ebook_id=eq.{ebook_id}'
        req = Request(f'{URL}{path}', headers={'apikey': SR, 'Authorization': f'Bearer {SR}'})
        rows = json.loads(urlopen(req, timeout=30).read())
        sb_pages = len(rows)
        sb_page_nums = sorted(r['page_number'] for r in rows)
        ok = sb_page_nums == list(range(1, sb_pages + 1))
        if not ok:
            print(f'❌ Supabase: {sb_pages} registros mas page_numbers não contíguos')
            return 1
        print(f'✅ Supabase: {sb_pages} páginas indexadas')

        # 4. Comparação cruzada
        if pdf_pages != json_pages:
            print(f'⚠️  DESSINC: PDF={pdf_pages} vs JSON={json_pages} (diferença {abs(pdf_pages - json_pages)})')
            return 1
        if json_pages != sb_pages:
            print(f'⚠️  DESSINC: JSON={json_pages} vs Supabase={sb_pages} (diferença {abs(json_pages - sb_pages)})')
            return 1

        # 5. Sample check (página 50 — se existir)
        if 50 <= sb_pages:
            sample = next((p for p in pages if p[key] == 50), None)
            sb_req = Request(
                f'{URL}/rest/v1/ebook_pages?select=page_text&ebook_id=eq.{ebook_id}&page_number=eq.50',
                headers={'apikey': SR, 'Authorization': f'Bearer {SR}'}
            )
            sb_rows = json.loads(urlopen(sb_req, timeout=10).read())
            if sb_rows:
                sb_txt = (sb_rows[0]['page_text'] or '')[:80]
                json_txt = (sample.get('text', '') or '')[:80]
                if sb_txt != json_txt:
                    print(f'⚠️  Sample p.50 DESSINC entre JSON e Supabase')
                    print(f'   JSON:  "{json_txt}"')
                    print(f'   Sup:   "{sb_txt}"')
                    return 1
                print(f'✅ Sample p.50 idêntico JSON ↔ Supabase')
        print()
        print(f'🎉 {slug} SINCRONIZADO (PDF/JSON/Supabase = {pdf_pages} páginas)')
        return 0
    except Exception as e:
        print(f'❌ Erro Supabase: {e}')
        return 1


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--slug', default='fabricante-de-lagrimas')
    args = ap.parse_args()
    sys.exit(check(args.slug))