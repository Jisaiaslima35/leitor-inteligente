#!/usr/bin/env python3
"""Leitor IA - RAG Semantico (BGE-small-en via Supabase + Hermes).
Roda na porta 9131 separado do server.py legacy.
"""
import json, re, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from functools import lru_cache
sys.path.insert(0, str(Path(__file__).parent))
from book_meta import get_book_meta, build_system_prompt  # noqa: E402
from semantic_helpers import (  # noqa: E402
    detect_explicit_page,
    is_current_page_intent,
    lexical_page_lookup_supabase,
)

# --- Config ---
SUPABASE_ENV = {}
for line in Path('/root/.hermes/secrets/leitor-supabase.env').read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        SUPABASE_ENV[line.split('=', 1)[0]] = line.split('=', 1)[1]

SUPABASE_URL = SUPABASE_ENV.get('SUPABASE_URL', '')
SUPABASE_SR = SUPABASE_ENV.get('SUPABASE_SERVICE_ROLE', '')
BOOK_SLUG = 'o-poder-do-habito'

# --- Embeddings ---
_EMBEDDER = None
_EMBED_LOCK = threading.Lock()

def embedder():
    global _EMBEDDER
    if _EMBEDDER is None:
        with _EMBED_LOCK:
            if _EMBEDDER is None:
                from fastembed import TextEmbedding
                print('[semantic] carregando BGE-small-en...', flush=True)
                _EMBEDDER = TextEmbedding(model_name='BAAI/bge-small-en-v1.5')
                print('[semantic] modelo pronto (dim=384)', flush=True)
    return _EMBEDDER

@lru_cache(maxsize=512)
def cached_embed(question: str):
    # fastembed 0.8 retorna generator; convertemos pra tuple pra ficar hashable
    return tuple(next(embedder().embed([question])).tolist())

# --- Supabase RPC ---
LEXICAL_PATHS = {
    'o-poder-do-habito': '/root/projetos/leitor-inteligente/data/o-poder-do-habito-pages.json',
    'biblia-dake-galatas': '/root/projetos/leitor-inteligente/data/biblia-dake-galatas-pages.json',
}

# Cache de slug→ebook_id (evita query repetida no Supabase)
@lru_cache(maxsize=64)
def _resolve_ebook_id(book_slug: str) -> str | None:
    """Resolve slug do ebook → UUID do ebook (cacheado)."""
    try:
        from urllib.request import Request, urlopen
        import urllib.parse
        path = '/rest/v1/ebooks?select=id&slug=eq.' + urllib.parse.quote(book_slug) + '&limit=1'
        req = Request(
            f'{SUPABASE_URL}{path}',
            headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}'},
        )
        with urlopen(req, timeout=10) as r:
            rows = json.loads(r.read())
        if rows:
            return rows[0]['id']
    except Exception as e:
        print(f'[_resolve_ebook_id] erro slug={book_slug}: {e}', flush=True)
    return None


def lexical_page_lookup(page_num: int, book_slug: str = BOOK_SLUG, k: int = 3):
    """Busca páginas EXATAS no Supabase por page_number (funciona pra QUALQUER livro).
    Pitfall #81: antes só funcionava pra 2 livros hardcoded em LEXICAL_PATHS.
    Agora consulta Supabase direto — cobre uploaded books tbm.
    Schema real: ebook_pages tem ebook_id (FK) + page_number + page_text.
    """
    candidates = [page_num, page_num - 1, page_num + 1]
    ebook_id = _resolve_ebook_id(book_slug)
    if not ebook_id:
        print(f'[lexical_page_lookup] ebook_id não encontrado pra slug={book_slug}', flush=True)
    else:
        try:
            ids = ','.join(str(x) for x in candidates if x >= 1)
            from urllib.request import Request, urlopen
            path = f'/rest/v1/ebook_pages?select=page_number,page_text&ebook_id=eq.{ebook_id}&page_number=in.({ids})&order=page_number'
            req = Request(
                f'{SUPABASE_URL}{path}',
                headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}'},
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
            if out:
                print(f'[lexical_page_lookup] Supabase retornou {len(out)} hits pra p{page_num} (slug={book_slug})', flush=True)
                return out[:k]
        except Exception as e:
            print(f'[lexical_page_lookup] erro Supabase: {e}', flush=True)

    # Fallback: JSON local (pros livros originais que têm corpus local)
    corpus_path = LEXICAL_PATHS.get(book_slug)
    if not corpus_path:
        print(f'[lexical_page_lookup] slug "{book_slug}" sem corpus local nem Supabase', flush=True)
        return []
    try:
        pages = json.loads(Path(corpus_path).read_text())
    except Exception as e:
        print(f'[lexical_page_lookup] erro lendo {corpus_path}: {e}', flush=True)
        return []
    out = []
    for p in candidates:
        if 1 <= p <= len(pages):
            txt = pages[p - 1]['text']
            if txt.strip():
                out.append({
                    'page_number': p,
                    'chapter_number': None,
                    'chapter_title': None,
                    'page_text': txt,
                    'similarity': 1.0,
                })
    return out[:k]

def semantic_retrieve(question: str, book_slug: str = BOOK_SLUG, current_page: int = 0, k: int = 5):
    # 1. Pergunta cita página explícita → lookup exato
    explicit = detect_explicit_page(question)
    if explicit:
        hits = lexical_page_lookup_supabase(explicit, book_slug, SUPABASE_URL, SUPABASE_SR)
        if hits:
            print(f'[semantic-ask] lexical (página explícita {explicit}) → {len(hits)} hits', flush=True)
            return hits

    # 2. Pergunta é sobre a página ATUAL (sem citar número) → lookup exato na current_page
    # Pitfall: sem isso, embedding search retornava páginas aleatórias com palavras
    # similares ("essa página", "to lendo") → LLM alucinava resumo.
    if current_page and current_page >= 1 and is_current_page_intent(question):
        hits = lexical_page_lookup_supabase(current_page, book_slug, SUPABASE_URL, SUPABASE_SR)
        if hits:
            print(f'[semantic-ask] lexical (página atual {current_page}) → {len(hits)} hits', flush=True)
            return hits

    # 3. Fallback: embedding semântico
    q_emb = list(cached_embed(question))
    print(f'[semantic-ask] embedding dim={len(q_emb)}; RPC match_ebook_slug="{book_slug}"', flush=True)
    payload = {
        'query_embedding': q_emb,
        'match_ebook_slug': book_slug,
        'match_count': k,
    }
    req = Request(
        f'{SUPABASE_URL}/rest/v1/rpc/match_ebook_pages',
        data=json.dumps(payload).encode(),
        headers={
            'apikey': SUPABASE_SR,
            'Authorization': f'Bearer {SUPABASE_SR}',
            'Content-Type': 'application/json',
        },
        method='POST',
    )
    with urlopen(req, timeout=30) as r:
        return json.loads(r.read())

# --- Hermes ---
def hermes_key() -> str:
    for path in ['/root/.hermes/.env']:
        for line in Path(path).read_text(errors='ignore').splitlines():
            if line.startswith('API_SERVER_KEY='):
                return line.split('=', 1)[1].strip().strip('"').strip("'")
    raise RuntimeError('API_SERVER_KEY ausente')

KEY = hermes_key()

# --- Skills (Mentor Mode) ---
# Procura skills geradas em /root/.hermes/profiles/leitor-inteligente/skills/<slug>/
SKILLS_ROOT = Path('/root/.hermes/profiles/leitor-inteligente/skills')

@lru_cache(maxsize=8)
def _load_skill(slug: str) -> dict | None:
    """Carrega SKILL.md + patterns.md de uma skill gerada, se existir.
    Retorna dict {skill_md, patterns_md, slug} ou None.
    Cacheado em memória — reinicia com o serviço.
    """
    skill_dir = SKILLS_ROOT / slug
    skill_md = skill_dir / 'SKILL.md'
    if not skill_md.exists():
        return None
    try:
        skill_text = skill_md.read_text(encoding='utf-8')
    except Exception as e:
        print(f'[_load_skill] erro lendo {skill_md}: {e}', flush=True)
        return None
    patterns_text = ''
    patterns_md = skill_dir / 'patterns.md'
    if patterns_md.exists():
        try:
            patterns_text = patterns_md.read_text(encoding='utf-8')
        except Exception as e:
            print(f'[_load_skill] erro lendo {patterns_md}: {e}', flush=True)
    return {'slug': slug, 'skill_md': skill_text, 'patterns_md': patterns_text}


def has_skill(slug: str) -> bool:
    """Retorna True se existe skill gerada pro slug (SKILL.md presente)."""
    return _load_skill(slug) is not None


def mentor_system_prompt(slug: str) -> str | None:
    """Monta o system prompt do "Mentor" pra primeira pessoa.
    Retorna None se a skill não existir pra esse slug.
    """
    skill = _load_skill(slug)
    if skill is None:
        return None
    # Extrai o título do livro do frontmatter da SKILL.md (linha "# <titulo>")
    title_line = ''
    for ln in skill['skill_md'].splitlines():
        if ln.startswith('# ') and not ln.startswith('##'):
            title_line = ln[2:].strip()
            break
    book_title = title_line or slug
    return (
        f"Você é o **Mentor do {book_title}** — uma personificação do conhecimento e dos frameworks "
        f"deste livro. Você NÃO é o autor real (não diga que é Charles Duhigg ou qualquer outra pessoa real). "
        f"Você é uma persona didática que DOMINA profundamente os princípios do livro e fala com a autoridade "
        f"e a intimidade de quem viveu e ensinou esse método a vida toda.\n\n"
        f"REGRAS DE VOZ:\n"
        f"- SEMPRE em primeira pessoa (\"eu\", \"meu\", \"na minha experiência\"). NUNCA em terceira pessoa (\"o autor diz\", \"Duhigg escreveu\").\n"
        f"- Tom de mentor sábio: próximo, caloroso, mas firme. Como um professor particular que já viu muita gente aplicar o método.\n"
        f"- Use os frameworks do livro pra RACIOCINAR antes de responder. Não decore trechos — pense pelo framework.\n"
        f"- Quando citar algo do livro, cite o capítulo/seção (ex: 'no Capítulo 3, sobre a Regra de Ouro…') e valide com o contexto fornecido.\n"
        f"- Se a pergunta não tiver a ver com o livro, redirecione com elegância pra algo do tema.\n"
        f"- Frases curtas, parágrafos pequenos. PT-BR coloquial mas erudito.\n"
        f"- NÃO invente citações literais. Se não lembrar a frase exata, parafraseie e diga 'em essência, o livro ensina que…'.\n\n"
        f"FRAMEWORKS DISPONÍVEIS (do livro {book_title}):\n\n"
        f"---\n{skill['skill_md']}\n---\n\n"
        f"PATTERNS DE AÇÃO (do livro {book_title}):\n\n"
        f"---\n{skill['patterns_md']}\n---\n\n"
        f"Lembre-se: você responde como Mentor, raciocinando pelos frameworks acima e validando com o CONTEXTO DO LIVRO fornecido em cada mensagem. "
        f"Se a pergunta do usuário for genérica demais, escolha o framework mais relevante da tabela de decisão e aplique."
    )


def semantic_answer(question: str, current_page: int = 1, book_slug: str = BOOK_SLUG, k: int = 5, modo_mentor: bool = False):
    hits = semantic_retrieve(question, book_slug, current_page, k)
    sources = []
    for h in hits:
        ch_title = h.get('chapter_title') or ''
        ch_num = h.get('chapter_number')
        if ch_num:
            title = f'Capítulo {ch_num} — {ch_title}'
        else:
            title = f'Página {h["page_number"]}'
        sources.append({
            'page': h['page_number'],
            'title': title,
            'text': h.get('page_text', ''),
            'similarity': h.get('similarity', 0.0),
        })

    if not sources:
        return {'answer': 'Não encontrei trechos relevantes no livro. Tente reformular.', 'sources': []}

    context = '\n\n'.join(
        f'[FONTE: {s["title"]}, PDF página {s["page"]} — similaridade {s["similarity"]:.2f}]\n{s["text"][:6000]}'
        for s in sources
    )
    # System prompt parametrizado pelo slug real do livro (Pitfall #74 + #79)
    # Se modo_mentor ativo E existe skill pro slug, troca pela persona Mentor
    if modo_mentor:
        mentor_p = mentor_system_prompt(book_slug)
        if mentor_p:
            print(f'[semantic-ask] MODO MENTOR ativo pra slug="{book_slug}"', flush=True)
            system = mentor_p
        else:
            print(f'[semantic-ask] modo_mentor pedido mas skill ausente pra slug="{book_slug}", usando prompt padrão', flush=True)
            meta = get_book_meta(book_slug)
            system = build_system_prompt(meta, fallback_title='o livro atual')
    else:
        meta = get_book_meta(book_slug)
        system = build_system_prompt(meta, fallback_title='o livro atual')
    payload = json.dumps({
        'model': 'hermes-agent',
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': f'Pergunta do leitor: {question}\nPágina atual no leitor: {current_page}\n\nCONTEXTO DO LIVRO:\n{context}'},
        ],
        'temperature': 0.2,
        'max_tokens': 900,
    }).encode()
    req = Request(
        'http://127.0.0.1:8642/v1/chat/completions',
        data=payload,
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {KEY}'},
        method='POST',
    )
    with urlopen(req, timeout=120) as r:
        data = json.loads(r.read())
    text = data['choices'][0]['message']['content'].strip()
    return {
        'answer': text,
        'sources': [
            {
                'id': f"p{s['page']}",
                'title': s['title'],
                'page': s['page'],
                'excerpt': s['text'][:240],
                'similarity': round(s['similarity'], 4),
            }
            for s in sources
        ],
    }

# --- HTTP ---
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'POST,GET,OPTIONS')
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self.send_json(200, {'status': 'ok', 'mode': 'semantic', 'embedder': 'bge-small-en', 'dim': 384})
            return
        if self.path.startswith('/has-skill'):
            # /has-skill?bookSlug=X  →  {has_skill: bool, slug: X}
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            slug = (qs.get('bookSlug') or qs.get('slug') or [BOOK_SLUG])[0]
            self.send_json(200, {'slug': slug, 'has_skill': has_skill(slug)})
            return
        self.send_json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/semantic-ask':
            return self.send_json(404, {'error': 'not found'})
        try:
            n = int(self.headers.get('Content-Length', '0'))
            data = json.loads(self.rfile.read(n))
            q = str(data.get('question', '')).strip()
            p = int(data.get('currentPage', 1))
            # bookSlug do front (pode ser slug do catálogo); fallback pro default
            slug = str(data.get('bookSlug') or data.get('book_slug') or BOOK_SLUG).strip()
            modo_mentor = bool(data.get('modo_mentor', False))
            print(f'[semantic-ask] q="{q[:60]}" page={p} bookSlug="{slug}" modo_mentor={modo_mentor}', flush=True)
            if not q:
                return self.send_json(400, {'error': 'Pergunta vazia'})
            self.send_json(200, semantic_answer(q, p, book_slug=slug, modo_mentor=modo_mentor))
        except Exception as e:
            print(f'[semantic-ask] ERROR: {e}', flush=True)
            self.send_json(500, {'error': str(e)[:500]})

if __name__ == '__main__':
    # Pré-carrega o modelo em background pra primeira request ser rápida
    def warmup():
        try:
            embedder()
            cached_embed('warmup')
        except Exception as e:
            print(f'[semantic] warmup falhou: {e}', flush=True)
    threading.Thread(target=warmup, daemon=True).start()

    print('Leitor IA Semantic API: porta 9131', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 9131), Handler).serve_forever()