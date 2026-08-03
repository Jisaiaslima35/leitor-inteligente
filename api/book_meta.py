#!/usr/bin/env python3
"""Helper compartilhado pra microservicos do Leitor Inteligente.

Busca metadata de ebooks no Supabase (com cache LRU) e gera system prompts
parametrizados por livro. Usado por semantic_server.py, fabricante_server.py,
poder_do_habito_server.py, etc.

Uso:
    from book_meta import get_book_meta, build_system_prompt
    meta = get_book_meta("o-poder-do-habito")
    prompt = build_system_prompt(meta, creator="Charles Duhigg")
"""
import json
from functools import lru_cache
from pathlib import Path

SUPABASE_ENV = {}
for line in Path('/root/.hermes/secrets/leitor-supabase.env').read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        SUPABASE_ENV[line.split('=', 1)[0]] = line.split('=', 1)[1]

SUPABASE_URL = SUPABASE_ENV.get('SUPABASE_URL', '')
SUPABASE_SR = SUPABASE_ENV.get('SUPABASE_SERVICE_ROLE', '')


def _supabase_get(path):
    """GET helper pro Supabase REST."""
    from urllib.request import Request, urlopen
    req = Request(
        f'{SUPABASE_URL}{path}',
        headers={
            'apikey': SUPABASE_SR,
            'Authorization': f'Bearer {SUPABASE_SR}',
        },
        method='GET',
    )
    with urlopen(req, timeout=15) as r:
        return json.loads(r.read())


@lru_cache(maxsize=128)
def get_book_meta(slug: str) -> dict | None:
    """Cacheia metadata do livro por 1h. Retorna dict {title, author, total_pages} ou None."""
    try:
        rows = _supabase_get(f'/rest/v1/ebooks?select=slug,title,author,total_pages&slug=eq.{slug}&limit=1')
        if rows:
            return rows[0]
    except Exception as e:
        print(f'[book_meta] erro buscando slug "{slug}": {e}', flush=True)
    return None


def build_system_prompt(meta: dict | None, fallback_title: str = "este livro") -> str:
    """Monta o system prompt contextualizado a partir dos metadados do livro.

    O modelo se comporta como Professor IA ESPECÍFICO do livro (não genérico).
    """
    if meta:
        title = meta.get('title', fallback_title)
        author = meta.get('author', '').strip()
        author_clause = f', de {author}' if author else ''
    else:
        title = fallback_title
        author_clause = ''

    return (
        f'Você é o Professor IA especialista na obra "{title}"{author_clause}. '
        'Sua linguagem é a de um professor universitário experiente: clara, acessível, '
        'sem jargão desnecessário e sem floreio retórico. '
        'Responda SEMPRE em português do Brasil.\n\n'
        'REGRAS DE OURO:\n'
        '1. Use EXCLUSIVAMENTE o contexto fornecido (cada trecho vem de uma página específica do PDF). '
        'Não invente, não use conhecimento externo, não preencha lacunas com suposição.\n'
        '2. Se o contexto não contiver a resposta, diga exatamente: '
        '"Não encontrei esse ponto nos trechos selecionados do livro." '
        'Em seguida sugira reformular a pergunta ou indicar a página/capítulo.\n'
        '3. Ao final de CADA resposta, liste as páginas PDF consultadas no formato: '
        '"Fontes: p. 42, p. 87, p. 103".\n'
        '4. Seja objetivo: respostas detalhadas o bastante para ensinar, '
        'mas sem parágrafos inflados. Prefira frases curtas a parágrafos longos.\n'
        '5. Quando citar um conceito, indique naturalmente a página entre parênteses, '
        'ex.: "(p. 42)". Use o formato "p. N" (com ponto abreviado).\n'
        '6. Se a pergunta mencionar página ou capítulo, responda especificamente sobre ele, '
        'citando o trecho relevante entre aspas.\n'
        '7. Termine com uma frase de convite: "Quer que eu aprofunde algum ponto?" '
        'ou "Posso explicar X com mais detalhes?" — encorajando continuidade da leitura.\n\n'
        'POSTURA: você é um professor que ama o livro e quer que o aluno saia entendendo. '
        'Tom profissional, caloroso, sem ser informal demais. Trate o leitor como alguém '
        'inteligente que apenas precisa de orientação.'
    )
