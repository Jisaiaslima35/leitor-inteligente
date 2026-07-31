#!/usr/bin/env python3
"""Leitor IA - RAG Semantico (BGE-small-en via Supabase + Hermes).
Roda na porta 9131 separado do server.py legacy.
"""
import json, re, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from functools import lru_cache

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

def lexical_page_lookup(page_num: int, book_slug: str = BOOK_SLUG, k: int = 3):
    """Fallback: lê páginas exatas do JSON local (pra 'página N' explícita).
    book_slug escolhe qual corpus (sem isso, sempre caía no Hábito)."""
    corpus_path = LEXICAL_PATHS.get(book_slug)
    if not corpus_path:
        print(f'[lexical_page_lookup] slug "{book_slug}" sem corpus local', flush=True)
        return []
    try:
        from pathlib import Path
        pages = json.loads(Path(corpus_path).read_text())
    except Exception as e:
        print(f'[lexical_page_lookup] erro lendo {corpus_path}: {e}', flush=True)
        return []

    candidates = [page_num, page_num - 1, page_num + 1]
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

def detect_explicit_page(question: str):
    """Detecta 'página N' na pergunta."""
    m = re.search(r'p[áa]gina\s+(\d+)', question, re.IGNORECASE)
    if m:
        return int(m.group(1))
    m = re.search(r'\bp\s*(\d{1,3})\b', question, re.IGNORECASE)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 500:
            return n
    return None

def semantic_retrieve(question: str, book_slug: str = BOOK_SLUG, k: int = 5):
    # Se pergunta menciona página explícita, usa lexical direto (evita alucinação)
    explicit = detect_explicit_page(question)
    if explicit:
        hits = lexical_page_lookup(explicit, book_slug)
        if hits:
            print(f'[semantic-ask] lexical_page_lookup (página explícita) retornou {len(hits)} hits', flush=True)
            return hits

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

def semantic_answer(question: str, current_page: int = 1, book_slug: str = BOOK_SLUG, k: int = 5):
    hits = semantic_retrieve(question, book_slug, k)
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
    system = (
        'Você é o Professor IA do livro O Poder do Hábito, de Charles Duhigg. '
        'Responda em português do Brasil, didático e fiel ao livro. '
        'Use SOMENTE o contexto fornecido (cada trecho vem de uma página específica do PDF). '
        'Se a pergunta mencionar página ou capítulo, responda especificamente sobre ele. '
        'Cite no fim as páginas PDF usadas no formato "Fontes: pX, pY, pZ". '
        'Se o contexto não contiver a resposta, diga claramente que não encontrou naquele conteúdo.'
    )
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
        else:
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
            print(f'[semantic-ask] q="{q[:60]}" page={p} bookSlug="{slug}"', flush=True)
            if not q:
                return self.send_json(400, {'error': 'Pergunta vazia'})
            self.send_json(200, semantic_answer(q, p, book_slug=slug))
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