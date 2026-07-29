#!/usr/bin/env python3
"""Leitor IA - RAG Semantico (BGE-small-en via Supabase + Hermes).
Roda numa porta (default 9131) separado do server.py legacy (lexical).

PADRÃO pra copiar pra novo ebook:
  - Trocar BOOK_SLUG
  - Trocar porta (se já tiver 9131 ocupado)
  - systemd service com venv Python (Pitfall #44)
  - nginx location /<slug>/semantic-api/ → 127.0.0.1:<porta>

Pitfalls incorporados:
  - #43 fastembed v0.8 retorna generator — use next(...)
  - #44 venv Python no systemd — usar /usr/local/lib/hermes-agent/venv/bin/python3
  - #45 lexical fallback pra "página N" — regex ANTES do embed
  - #46 @lru_cache precisa hashable — tuple em vez de list
  - #47 lazy-import + warmup daemon — systemd-friendly startup
  - #48 não usar fastembed.TextEmbedding direto no top
"""
import json, re, threading, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from functools import lru_cache

# === CONFIG — substituir pra cada livro novo ===
SUPABASE_ENV = {}
for line in Path('/root/.hermes/secrets/leitor-supabase.env').read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        SUPABASE_ENV[line.split('=', 1)[0]] = line.split('=', 1)[1]

SUPABASE_URL = SUPABASE_ENV.get('SUPABASE_URL', '')
SUPABASE_SR = SUPABASE_ENV.get('SUPABASE_SERVICE_ROLE', '')
BOOK_SLUG = 'o-poder-do-habito'  # <-- TROCAR pra cada novo livro
EMBED_MODEL = 'BAAI/bge-small-en-v1.5'
EMBED_DIM = 384
PORT = 9131  # <-- TROCAR pra não conflitar (9132, 9133, ...)

# === Embeddings (lazy, com lock pra thread-safety) ===
_EMBEDDER = None
_EMBED_LOCK = threading.Lock()

def embedder():
    global _EMBEDDER
    if _EMBEDDER is None:
        with _EMBED_LOCK:
            if _EMBEDDER is None:
                from fastembed import TextEmbedding  # Pitfall #47+48: lazy import
                print('[semantic] carregando modelo...', flush=True)
                _EMBEDDER = TextEmbedding(model_name=EMBED_MODEL)
                print(f'[semantic] modelo pronto (dim={EMBED_DIM})', flush=True)
    return _EMBEDDER

@lru_cache(maxsize=512)
def cached_embed(question: str):
    # Pitfall #43: embed() v0.8 retorna generator, NÃO list/ndarray
    # Pitfall #46: @lru_cache precisa retorno hashable → tuple em vez de list
    return tuple(next(embedder().embed([question])).tolist())

# === Supabase RPC ===
def detect_explicit_page(question: str):
    """Pitfall #45: detectar 'página N' ANTES do embed pra não alucinar."""
    m = re.search(r'p[áa]gina\s+(\d+)', question, re.IGNORECASE)
    if m:
        return int(m.group(1))
    m = re.search(r'\bp\s*(\d{1,3})\b', question, re.IGNORECASE)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 500:
            return n
    return None

def lexical_page_lookup(page_num: int, pages_json_path: str, k: int = 3):
    """Lê páginas [n-1, n, n+1] do JSON local (filtrando vazias)."""
    try:
        pages = json.loads(Path(pages_json_path).read_text(encoding='utf-8'))
    except Exception:
        return []
    candidates = [page_num, page_num - 1, page_num + 1]
    out = []
    for p in candidates:
        if 1 <= p <= len(pages):
            txt = pages[p - 1]['text']
            if txt and txt.strip():
                out.append({
                    'page_number': p,
                    'chapter_number': None,
                    'chapter_title': None,
                    'page_text': txt,
                    'similarity': 1.0,
                })
    return out[:k]

def semantic_retrieve(question: str, pages_json_path: str, k: int = 5):
    explicit = detect_explicit_page(question)
    if explicit:
        hits = lexical_page_lookup(explicit, pages_json_path)
        if hits:
            return hits

    q_emb = list(cached_embed(question))
    payload = {
        'query_embedding': q_emb,
        'match_ebook_slug': BOOK_SLUG,
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

# === Hermes ===
def hermes_key() -> str:
    for path in ['/root/.hermes/.env']:
        for line in Path(path).read_text(errors='ignore').splitlines():
            if line.startswith('API_SERVER_KEY='):
                return line.split('=', 1)[1].strip().strip('"').strip("'")
    raise RuntimeError('API_SERVER_KEY ausente em /root/.hermes/.env')

KEY = hermes_key()

def semantic_answer(question: str, pages_json_path: str, current_page: int = 1, k: int = 5):
    hits = semantic_retrieve(question, pages_json_path, k)
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
        return {
            'answer': 'Não encontrei trechos relevantes no livro. Tente reformular ou pergunte sobre um capítulo/página específica.',
            'sources': [],
        }

    context = '\n\n'.join(
        f'[FONTE: {s["title"]}, PDF página {s["page"]} — similaridade {s["similarity"]:.2f}]\n{s["text"][:6000]}'
        for s in sources
    )
    system = (
        'Você é o Professor IA do livro indexado no banco. Responda em português do Brasil, '
        'didático e fiel ao livro. Use SOMENTE o contexto fornecido (cada trecho vem de uma página '
        'específica do PDF). Se a pergunta mencionar página ou capítulo, responda especificamente '
        'sobre ele. Cite no fim as páginas PDF usadas no formato "Fontes: pX, pY, pZ". Se o contexto '
        'não contiver a resposta, diga claramente que não encontrou naquele conteúdo.'
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

# === HTTP ===
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
            self.send_json(200, {
                'status': 'ok',
                'mode': 'semantic',
                'slug': BOOK_SLUG,
                'embedder': EMBED_MODEL,
                'dim': EMBED_DIM,
            })
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
            if not q:
                return self.send_json(400, {'error': 'Pergunta vazia'})
            pages_json = data.get('pages_json_path', f'/root/projetos/leitor-{BOOK_SLUG}/data/{BOOK_SLUG}-pages.json')
            self.send_json(200, semantic_answer(q, pages_json, p))
        except Exception as e:
            self.send_json(500, {'error': str(e)[:500]})

if __name__ == '__main__':
    def warmup():
        try:
            embedder()
            cached_embed('warmup')
        except Exception as e:
            print(f'[semantic] warmup falhou: {e}', flush=True)
    threading.Thread(target=warmup, daemon=True).start()

    print(f'Leitor IA Semantic API ({BOOK_SLUG}): porta {PORT}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
