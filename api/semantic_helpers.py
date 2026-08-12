"""Shared helpers para servidores semânticos do Leitor Inteligente.

Centraliza:
- Detecção de página explícita na pergunta
- Detecção de intenção de página ATUAL (essa página, to lendo, etc)
- Lookup lexical (consulta página exata)
- Validação de contexto de livro

Pitfall: importações circulares. Não importar nada dos servidores daqui.
"""
import json
import re
from pathlib import Path
from urllib.request import Request, urlopen
from functools import lru_cache

CURRENT_PAGE_TRIGGERS = [
    'essa página', 'esta página', 'essa pagina', 'esta pagina',
    'página atual', 'pagina atual', 'página que eu tô', 'pagina que eu to',
    'página que to', 'o que eu tô lendo', 'o que to lendo',
    'tô lendo', 'to lendo', 'me explica', 'me descreve',
    'essa parte', 'esta parte', 'esse trecho', 'este trecho',
    'resuma', 'resumo', 'essa cena', 'esta cena',
    'o que tá acontecendo aqui', 'o que ta acontecendo aqui',
    'explica esse trecho', 'descreve esse trecho',
    'analisa essa página', 'fala sobre essa página',
]


def detect_explicit_page(question: str) -> int | None:
    """Detecta 'página N' ou 'p. N' na pergunta."""
    m = re.search(r'p[áa]gina\s+(\d+)', question, re.IGNORECASE)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 700:
            return n
    m = re.search(r'\bp\s*(\d{1,3})\b', question, re.IGNORECASE)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 700:
            return n
    return None


def is_current_page_intent(question: str) -> bool:
    """Detecta quando o usuário quer descrição/análise da página ATUAL
    (sem citar número de página).

    Args:
        question: texto da pergunta

    Returns:
        True se a pergunta parece pedir a página que o usuário tá lendo
    """
    q = question.lower().strip()
    if len(q) < 4:
        return False
    return any(t in q for t in CURRENT_PAGE_TRIGGERS)


def detect_chapter_intent(question: str) -> int | None:
    """Detecta 'capítulo N' na pergunta."""
    m = re.search(r'cap[íi]tulo\s+(\d+)', question, re.IGNORECASE)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 200:
            return n
    return None


def lexical_page_lookup_supabase(
    page_num: int,
    book_slug: str,
    supabase_url: str,
    supabase_sr: str,
    k: int = 3,
) -> list:
    """Busca páginas EXATAS no Supabase por page_number.

    Args:
        page_num: número da página (1-indexed)
        book_slug: slug do ebook
        supabase_url: URL do projeto Supabase
        supabase_sr: service role key
        k: máximo de páginas a retornar (page_num, page_num-1, page_num+1)

    Returns:
        Lista de dicts {page_number, page_text, similarity} ou [] se não achou
    """
    candidates = [page_num, page_num - 1, page_num + 1]
    candidates = [p for p in candidates if p >= 1]

    # Resolve ebook_id
    try:
        ebook_id = _resolve_ebook_id(supabase_url, supabase_sr, book_slug)
        if not ebook_id:
            return []
        ids = ','.join(str(x) for x in candidates)
        path = (
            f'/rest/v1/ebook_pages?select=page_number,page_text'
            f'&ebook_id=eq.{ebook_id}&page_number=in.({ids})&order=page_number'
        )
        req = Request(
            f'{supabase_url}{path}',
            headers={'apikey': supabase_sr, 'Authorization': f'Bearer {supabase_sr}'},
        )
        with urlopen(req, timeout=10) as r:
            rows = json.loads(r.read())
        out = []
        for row in rows:
            txt = (row.get('page_text') or '').strip()
            if txt and len(txt) > 10:
                out.append({
                    'page_number': row['page_number'],
                    'chapter_number': None,
                    'chapter_title': None,
                    'page_text': txt,
                    'similarity': 1.0,
                })
        return out[:k]
    except Exception:
        return []


@lru_cache(maxsize=64)
def _resolve_ebook_id(supabase_url: str, supabase_sr: str, book_slug: str) -> str | None:
    """Resolve slug → UUID. Cacheado pra evitar query repetida."""
    import urllib.parse
    try:
        path = '/rest/v1/ebooks?select=id&slug=eq.' + urllib.parse.quote(book_slug) + '&limit=1'
        req = Request(
            f'{supabase_url}{path}',
            headers={'apikey': supabase_sr, 'Authorization': f'Bearer {supabase_sr}'},
        )
        with urlopen(req, timeout=10) as r:
            rows = json.loads(r.read())
        if rows:
            return rows[0]['id']
    except Exception:
        pass
    return None