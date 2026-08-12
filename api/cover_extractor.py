#!/usr/bin/env python3
"""Capa automática a partir do PDF (PyMuPDF).

Auto-detecta se a p1 é 'vazia' (folha de rosto, sumário, quase branca)
e pula pra p2/p3/etc. Retorna None se nada servir (PDF sem capa visível).

Uso:
    from cover_extractor import extract_cover
    cover_path = extract_cover('/tmp/foo.pdf')  # str(png) ou None

Thresholds (ajustáveis abaixo):
- WHITE_MEAN_THRESHOLD = 240   # se brightness média > 240 = "quase branca"
- WHITE_STD_THRESHOLD  = 15    # se desvio RGB < 15 = "sem variação"
- MIN_WHITE_RATIO      = 0.85  # se >=85% pixels são "quase brancos" = vazia
- MAX_PAGES_TO_TRY     = 5     # tenta até 5 páginas até achar uma válida
"""
from __future__ import annotations

import os
import random
from pathlib import Path

try:
    import pymupdf as fitz  # PyMuPDF 1.24+ preferiu pymupdf
except ImportError:
    import fitz  # type: ignore  # PyMuPDF <1.24

from PIL import Image
import io


# Heurística: "página vazia/clara demais"
WHITE_MEAN_THRESHOLD = 240      # brightness média (0-255) acima disso = muito clara
WHITE_STD_THRESHOLD = 15        # desvio padrão RGB abaixo disso = sem variação
WHITE_PIXEL_THRESHOLD = 235     # pixel >= isso conta como "branco"
MIN_WHITE_RATIO = 0.85          # ratio mínimo de pixels brancos pra classificar como vazia
SAMPLE_SIZE = 1500              # quantos pixels sampleamos (rápido, suficiente)

# Output
COVER_WIDTH_PX = 600            # largura padrão da capa (height proporcional)
COVER_DPI = 144                 # DPI do render do PyMuPDF

# Varredura
MAX_PAGES_TO_TRY = 5            # tenta até 5 páginas
RENDER_SCALE = COVER_DPI / 72   # PyMuPDF render usa escala 72dpi base


def _is_blank_or_lighted_page(page: fitz.Page, sample_size: int = SAMPLE_SIZE) -> bool:
    """Sample aleatório de pixels do pixmap. Retorna True se página é 'quase vazia'.

    Critério: >=MIN_WHITE_RATIO dos pixels sampled são >=WHITE_PIXEL_THRESHOLD
    E a média geral é >WHITE_MEAN_THRESHOLD.
    """
    pix = page.get_pixmap(matrix=fitz.Matrix(0.5, 0.5))  # half-res pra ser rápido
    width, height = pix.width, pix.height
    n = pix.n  # bytes per pixel
    samples = pix.samples

    rng = random.Random(42)  # determinístico — mesmas caps sempre
    pixel_indices = rng.sample(range(width * height), min(sample_size, width * height))

    n_white = 0
    total_brightness = 0
    n_sampled = len(pixel_indices)

    for idx in pixel_indices:
        offset = idx * n
        r = samples[offset]
        g = samples[offset + 1] if n > 1 else r
        b = samples[offset + 2] if n > 2 else r
        brightness = (r + g + b) // 3
        total_brightness += brightness
        if brightness >= WHITE_PIXEL_THRESHOLD:
            n_white += 1

    white_ratio = n_white / n_sampled if n_sampled else 0
    mean_brightness = total_brightness / n_sampled if n_sampled else 0
    return white_ratio >= MIN_WHITE_RATIO and mean_brightness >= WHITE_MEAN_THRESHOLD


def extract_cover(pdf_path: str, output_path: str | None = None,
                  max_pages: int = MAX_PAGES_TO_TRY) -> str | None:
    """Extrai a capa do PDF usando PyMuPDF.

    Estratégia:
    - Itera pelas primeiras `max_pages` páginas
    - Renderiza a primeira que NÃO for classificada como "vazia/clara demais"
    - Se todas as testadas forem vazias, usa a p1 mesmo (fallback)
    - Salva como PNG (mantém qualidade) ou JPEG se output terminar em .jpg/.jpeg

    Retorna o path do arquivo salvo, ou None se falhar (PDF sem páginas, etc).
    """
    pdf_path = Path(pdf_path)
    if not pdf_path.exists():
        return None

    if output_path is None:
        output_path = str(pdf_path.with_suffix('').with_name(f'{pdf_path.stem}-cover.png'))
    output_path = str(output_path)

    try:
        doc = fitz.open(str(pdf_path))
    except Exception as e:
        print(f'[cover] erro abrindo PDF: {e}', flush=True)
        return None

    n_pages = doc.page_count
    if n_pages == 0:
        return None

    chosen_page_idx = 0  # fallback: p1
    for i in range(min(max_pages, n_pages)):
        page = doc.load_page(i)
        try:
            is_blank = _is_blank_or_lighted_page(page)
        except Exception as e:
            print(f'[cover] erro avaliando p{i+1}: {e}', flush=True)
            is_blank = False
        if not is_blank:
            chosen_page_idx = i
            break
        print(f'[cover] p{i+1} classificada como vazia/clara, pulando...', flush=True)

    print(f'[cover] usando p{chosen_page_idx+1} como capa (de {n_pages} páginas)', flush=True)

    # Renderiza a capa numa resolução boa, mas com cap de pixels
    page = doc.load_page(chosen_page_idx)
    # Calcula scale pra caber em COVER_WIDTH_PX de largura
    page_width_pt = page.rect.width
    scale = RENDER_SCALE * (COVER_WIDTH_PX / (page_width_pt * RENDER_SCALE)) if page_width_pt > 0 else RENDER_SCALE
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    img_bytes = pix.tobytes('png')

    # Otimiza pra web via Pillow
    img = Image.open(io.BytesIO(img_bytes))
    if img.mode != 'RGB':
        img = img.convert('RGB')

    out_lower = output_path.lower()
    if out_lower.endswith(('.jpg', '.jpeg')):
        img.save(output_path, 'JPEG', quality=85, optimize=True, progressive=True)
    else:
        img.save(output_path, 'PNG', optimize=True)

    doc.close()
    return output_path


if __name__ == '__main__':
    import sys
    if len(sys.argv) < 2:
        print('Uso: cover_extractor.py <pdf_path> [output_path]')
        sys.exit(1)
    pdf = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else None
    result = extract_cover(pdf, out)
    if result:
        size = os.path.getsize(result)
        print(f'OK: {result} ({size:,} bytes)')
    else:
        print('FAIL: nenhum cover extraído')
        sys.exit(1)
