#!/usr/bin/env python3
"""OCR Pipeline para PDFs escaneados.

Usa ocrmypdf (tesseract + unpaper) para extrair camada de texto de PDFs
que não têm texto embutido (scans). Gera PDF híbrido (texto OCR + imagens
originais) que pode ser renderizado pelo PDF.js E processado pelo RAG.

Uso:
    python3 ocr_pdf.py <input.pdf> <output.pdf> [lang]

Dependências (Ubuntu/Debian):
    apt-get install -y tesseract-ocr tesseract-ocr-por poppler-utils unpaper
    pip install ocrmypdf

Tempo médio: ~2-5s/página CPU. Pra 354 páginas = ~15min.
"""
import subprocess
import sys
import time
from pathlib import Path


def ocr_pdf(input_path: str, output_path: str, lang: str = 'por') -> None:
    in_p = Path(input_path)
    out_p = Path(output_path)
    if not in_p.exists():
        raise FileNotFoundError(f'PDF de entrada não existe: {in_p}')

    # Validação prévia: checa se o PDF tem texto extraível
    probe = subprocess.run(
        ['pdftotext', '-f', '1', '-l', '3', str(in_p), '-'],
        capture_output=True, text=True, timeout=30,
    )
    avg_chars = len(probe.stdout) // 3  # média das 3 primeiras páginas
    if avg_chars > 200:
        print(
            f'[ocr_pdf] AVISO: PDF já tem camada de texto '
            f'(média {avg_chars} chars/página nas 3 primeiras). '
            'OCR pode ser desnecessário — passar --skip-text se quiser.',
            flush=True,
        )

    cmd = [
        'ocrmypdf',
        '-l', lang,         # PT-BR por padrão
        '--skip-text',      # se já tiver texto, só completa o que faltar
        '--deskew',         # corrige páginas tortas
        '--clean',          # usa unpaper pra limpar antes do OCR
        '--output-type', 'pdf',
        str(in_p),
        str(out_p),
    ]
    print(f'[ocr_pdf] rodando: {" ".join(cmd)}', flush=True)
    t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if proc.returncode != 0:
        print(f'[ocr_pdf] STDERR:\n{proc.stderr}', flush=True)
        raise RuntimeError(f'ocrmypdf falhou (rc={proc.returncode})')
    print(f'[ocr_pdf] OK — saída em {out_p}', flush=True)

    # Confere texto extraído
    verify = subprocess.run(
        ['pdftotext', '-layout', str(out_p), '-'],
        capture_output=True, text=True, timeout=30,
    )
    pages = verify.stdout.split('\f')
    nonzero = [p for p in pages if len(p.strip()) > 50]
    print(
        f'[ocr_pdf] {len(nonzero)}/{len(pages)} páginas com texto '
        f'({sum(len(p) for p in pages)} chars totais)',
        flush=True,
    )
    print(f'[ocr_pdf] total: {time.time() - t0:.1f}s', flush=True)


if __name__ == '__main__':
    if len(sys.argv) not in (3, 4):
        print('Uso: python3 ocr_pdf.py <input.pdf> <output.pdf> [lang]', file=sys.stderr)
        sys.exit(1)
    lang = sys.argv[3] if len(sys.argv) == 4 else 'por'
    ocr_pdf(sys.argv[1], sys.argv[2], lang)