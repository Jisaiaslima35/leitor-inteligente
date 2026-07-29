#!/usr/bin/env bash
# Pipeline completo de ingestão de novo livro no Leitor Inteligente.
#
# Uso: bash ingest_book.sh <input.pdf> <slug> <title> <author> [price_cents]
#
# O que faz:
#   1. (se PDF escaneado) Roda OCR via ocrmypdf → gera PDF híbrido
#   2. Extrai texto por página → data/<slug>-pages.json
#   3. Upload pro Supabase Storage (bucket ebooks)
#   4. INSERT na tabela ebooks
#   5. Gera embeddings BGE-small-en
#   6. PATCH embeddings na tabela ebook_pages
#   7. (opcional) Compra pro user de teste (script outro)
#
# Pré-requisitos:
#   - /root/.hermes/secrets/leitor-supabase.env exportado no env (URL+KEY)
#   - pdftotext (poppler-utils), tesseract+ocrmypdf, fastembed (pip)
#   - jq pra parsear JSON
#   - service systemd leitor-semantic-api já running

set -euo pipefail

INPUT="${1:?informe o PDF de entrada}"
SLUG="${2:?informe o slug (sem espaço, ex: o-poder-do-habito)}"
TITLE="${3:?informe o título}"
AUTHOR="${4:?informe o autor}"
PRICE="${5:-0}"

cd /root/projetos/leitor-inteligente

# Carrega secrets
set -a
. /root/.hermes/secrets/leitor-supabase.env
set +a

# === 1. OCR se necessário ===
WORKDIR=$(mktemp -d /tmp/ingest-XXXXX)
trap "rm -rf $WORKDIR" EXIT

# Detecta se é escaneado
AVG_CHARS=$(pdftotext -f 1 -l 3 "$INPUT" - | wc -c | awk '{print int($1/3)}')
PDF_OCR="$INPUT"

if [ "$AVG_CHARS" -lt 200 ]; then
  echo "[ingest_book] PDF escaneado detectado ($AVG_CHARS chars/pg). Rodando OCR..."
  PDF_OCR="$WORKDIR/ocr.pdf"
  bash /root/.hermes/skills/pwa-leitor-inteligente/scripts/ocr_pdf.sh "$INPUT" "$PDF_OCR" por
fi

# === 2. Extrai texto por página ===
mkdir -p data
echo "[ingest_book] Extraindo páginas..."
python3 - "$PDF_OCR" "$SLUG" <<'PY'
import json, pathlib, sys
pdf = sys.argv[1]
slug = sys.argv[2]
import subprocess
text = subprocess.run(['pdftotext', '-layout', pdf, '-'], capture_output=True, text=True).stdout
pages = text.split('\f')
items = [
    {'page': i+1, 'text': p.strip()}
    for i, p in enumerate(pages)
    if len(p.strip()) > 5
]
pathlib.Path(f'data/{slug}-pages.json').write_text(
    json.dumps(items, ensure_ascii=False)
)
print(f"[ingest_book] {len(items)} páginas salvas em data/{slug}-pages.json")
PY

# === 3. Upload pro Supabase Storage ===
echo "[ingest_book] Upload pro Storage..."
STORAGE_PATH="$SLUG/livro.pdf"
curl -sS -X POST "$SUPABASE_URL/storage/v1/object/ebooks/$STORAGE_PATH" \
  -H "apikey: $SUPABASE_SERVICE_ROLE" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE" \
  -H "Content-Type: application/pdf" \
  -H "x-upsert: true" \
  --data-binary "@$PDF_OCR" | head -c 200
echo ""

# === 4. INSERT ebook ===
TOTAL_PAGES=$(pdfinfo "$PDF_OCR" | awk '/^Pages:/ {print $2}')
echo "[ingest_book] Inserindo row na tabela ebooks (total_pages=$TOTAL_PAGES)..."

# Resolve ON CONFLICT via upsert usando curl
curl -sS -X POST "$SUPABASE_URL/rest/v1/ebooks" \
  -H "apikey: $SUPABASE_SERVICE_ROLE" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE" \
  -H "Content-Type: application/json" \
  -H "Prefer: resolution=merge-duplicates" \
  -H "Prefer: return=representation" \
  -d "{
    \"slug\": \"$SLUG\",
    \"title\": \"$TITLE\",
    \"author\": \"$AUTHOR\",
    \"pdf_storage_path\": \"$STORAGE_PATH\",
    \"total_pages\": $TOTAL_PAGES,
    \"price_cents\": $PRICE,
    \"is_published\": true
  }" | python3 -c "import sys,json; d=json.load(sys.stdin); print('ebook_id:', d[0]['id'] if d else 'FAIL', file=sys.stderr)"

# === 5. Embeddings ===
echo "[ingest_book] Gerando embeddings BGE-small-en (~30s pra livro curto)..."
python3 /root/projetos/leitor-inteligente/scripts/fastembed_pages.py \
  --book "$SLUG" 2>&1 | tail -5

# === 6. PATCH embeddings no Supabase ===
echo "[ingest_book] Patchando embeddings no Supabase..."
python3 /root/projetos/leitor-inteligente/scripts/patch_embeddings.py \
  --book "$SLUG" 2>&1 | tail -10

echo ""
echo "[ingest_book] DONE. Livro '$SLUG' disponível em /reader/$SLUG"
echo "[ingest_book] Próximo: adicionar entry no src/domain/catalog.ts (ou via painel admin)"