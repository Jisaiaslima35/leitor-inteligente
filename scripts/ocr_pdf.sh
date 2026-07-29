#!/usr/bin/env bash
# OCR pipeline wrapper — usado em produção pela feature "usuário sobe livro"
# (caso o PDF seja escaneado).
#
# Uso: bash ocr_pdf.sh <input.pdf> <output.pdf> [lang]
#
# Pré-requisitos (uma vez na VPS):
#   apt-get install -y tesseract-ocr tesseract-ocr-por poppler-utils unpaper
#   pip install ocrmypdf

set -euo pipefail

INPUT="${1:?informe o PDF de entrada}"
OUTPUT="${2:?informe o PDF de saída}"
LANG="${3:-por}"

# Pré-checagens
command -v ocrmypdf >/dev/null || {
  echo "ERROR: ocrmypdf não instalado. Rode: pip install ocrmypdf"
  exit 1
}
command -v tesseract >/dev/null || {
  echo "ERROR: tesseract não instalado. Rode: apt-get install -y tesseract-ocr tesseract-ocr-$LANG"
  exit 1
}
command -v unpaper >/dev/null || {
  echo "ERROR: unpaper não instalado. Rode: apt-get install -y unpaper"
  exit 1
}
command -v pdftoppm >/dev/null || {
  echo "ERROR: poppler-utils não instalado. Rode: apt-get install -y poppler-utils"
  exit 1
}

echo "[ocr_pdf.sh] Processando $INPUT → $OUTPUT (lang=$LANG)"
time ocrmypdf \
  -l "$LANG" \
  --skip-text \
  --deskew \
  --clean \
  --output-type pdf \
  "$INPUT" \
  "$OUTPUT"

# Verifica saída
PAGES=$(pdfinfo "$OUTPUT" | awk '/^Pages:/ {print $2}')
TXT=$(pdftotext "$OUTPUT" - | wc -c)
echo "[ocr_pdf.sh] OK: $PAGES páginas, $TXT chars extraídos"