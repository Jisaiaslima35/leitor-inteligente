# v5 — RAG Semântico com Supabase pgvector (28/07/2026)

Patch incremental na v2 (RAG lexical) e v4 (Auth Supabase). **Escopo**: substituir o retrieval lexical do `api/server.py` (v2) por embeddings vetoriais no Supabase + Hermes, mantendo o lexical como fallback explícito.

## Arquivos adicionados

| Arquivo | Função |
|---|---|
| `api/semantic_server.py` (porta 9131) | Backend Python: embed pergunta (BGE-small-en 384d) → RPC `match_ebook_pages` no Supabase → contexto → Hermes |
| `/etc/systemd/system/leitor-semantic-api.service` | Service systemd usando o **venv interpreter do Hermes** (NÃO `/usr/bin/python3`) |
| `templates/semantic_server.py` | Template copy-paste desse servidor, parametrizável pra qualquer slug |

## Mudanças no front (1 linha)

`src/pages/ReaderPage.tsx`:
```diff
- const response = await fetch(`${import.meta.env.BASE_URL}api/ask`, {
+ const response = await fetch(`${import.meta.env.BASE_URL}semantic-api/semantic-ask`, {
```

## Nginx (location adicional)

```nginx
location /leitor-inteligente/semantic-api/ {
    proxy_pass http://127.0.0.1:9131/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_read_timeout 130s;
    proxy_send_timeout 130s;
    add_header Cache-Control "no-store";
}
```

## Pattern de detecção "página N" + "capítulo N" (essencial, não falhar nisso)

```python
def detect_explicit_page(question: str):
    m = re.search(r'p[áa]gina\s+(\d+)', question, re.IGNORECASE)
    if m: return int(m.group(1))
    m = re.search(r'\bp\s*(\d{1,3})\b', question, re.IGNORECASE)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 500: return n
    return None

def lexical_page_lookup(page_num: int, k: int = 3):
    """Fallback: lê páginas exatas do JSON local."""
    pages = json.loads(Path('/root/projetos/leitor-inteligente/data/o-poder-do-habito-pages.json').read_text())
    candidates = [page_num, page_num - 1, page_num + 1]
    out = []
    for p in candidates:
        if 1 <= p <= len(pages):
            txt = pages[p - 1]['text']
            if txt.strip():
                out.append({
                    'page_number': p, 'chapter_number': None, 'chapter_title': None,
                    'page_text': txt, 'similarity': 1.0,
                })
    return out[:k]

def semantic_retrieve(question, k=5):
    explicit = detect_explicit_page(question)
    if explicit:
        hits = lexical_page_lookup(explicit)
        if hits:
            return hits
    # ... senão, segue com embed + RPC
```

**Por quê obrigatório**: pgvector busca por similaridade. Se a pN é capa/folha de rosto (texto vazio ou poucos chars), o embedding é degenerado ou NULL, e a página NUNCA aparece em `match_ebook_pages` — Hermes vai falar "não achei" mesmo o user pedindo PÁGINA ESPECÍFICA. UX horrível. Lexical fallback resolve.

## Cache de embeddings (pattern validado)

```python
@lru_cache(maxsize=512)
def cached_embed(question: str):
    # fastembed v0.8 retorna generator → .tolist() → tuple (hashable)
    return tuple(next(embedder().embed([question])).tolist())
```

**Atenção Pitfall #43**: `embed(["..."])[0]` CRASHA (`'generator' object is not subscriptable`). Usar `next(...)`.

**Atenção Pitfall #46**: `@lru_cache` precisa retorno hashable — `tuple()` em vez de `list()`.

## Warmup lazy (systemd-friendly)

```python
_EMBEDDER = None
_EMBED_LOCK = threading.Lock()

def embedder():
    global _EMBEDDER
    if _EMBEDDER is None:
        with _EMBED_LOCK:
            if _EMBEDDER is None:
                from fastembed import TextEmbedding  # lazy import!
                print('[semantic] carregando BGE-small-en...', flush=True)
                _EMBEDDER = TextEmbedding(model_name='BAAI/bge-small-en-v1.5')
                print('[semantic] modelo pronto', flush=True)
    return _EMBEDDER

if __name__ == '__main__':
    def warmup():
        try:
            embedder()
            cached_embed('warmup')
        except Exception as e:
            print(f'[semantic] warmup falhou: {e}', flush=True)
    threading.Thread(target=warmup, daemon=True).start()
    # Servidor sobe AGORA (sem esperar modelo carregar)
    ThreadingHTTPServer(('127.0.0.1', 9131), Handler).serve_forever()
```

**Por quê**: systemd `Type=simple` só conta como `active` após o main thread subir. Se você faz `TextEmbedding(...)` no top-level do script + 10MB de download ONNX, demora 5-15s, e `curl /health` retorna connection refused. Lazy-import + daemon warmup = health 200 imediato, primeira request com latência (~2s).

## systemd template (CRÍTICO: usar venv Python)

```ini
[Unit]
Description=Leitor Inteligente - Professor IA (RAG Semantico)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/root/projetos/leitor-inteligente
ExecStart=/usr/local/lib/hermes-agent/venv/bin/python3 /root/projetos/leitor-inteligente/api/semantic_server.py
Restart=always
RestartSec=3
User=root
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

**Pitfall #44**: `/usr/bin/python3` NÃO tem `fastembed` (instalado no venv do Hermes durante sessão do agente). service sobe, primeira request falha com `No module named 'fastembed'`. Confirmar via `which python3` durante setup → retorna o venv path.

## Performance validada (medida real, 28/07/2026)

| Operação | Latência |
|---|---|
| Embed pergunta (cold) + RPC + Hermes | ~8.7s |
| Embed pergunta (warm) + RPC + Hermes | ~5s |
| Cache hit (`@lru_cache`) + RPC + Hermes | ~1-2s |
| Warmup do modelo no service start | ~1.5s |
| Embedding generation 352 páginas (batch CPU) | ~241s |

Bottleneck = Hermes (5-7s em chat cold-start). pgvector RPC é sub-100ms.

## Validação semântica (smoke test canônico)

```bash
curl -sS -X POST https://preview.automacaojs.us/leitor-inteligente/semantic-api/semantic-ask \
    -H 'Content-Type: application/json' \
    -d '{"question":"faça o resumo da página 10","currentPage":10}'
```

**Esperado** (validado 28/07/2026):
- HTTP 200
- `"answer"` com 500-1500 chars citando Conteúdo REAL do livro ("40% das ações são hábitos", pesquisa Duke University, estrutura do livro, exemplos)
- `"sources"` com 2-3 entries, `similarity: 1.0` (fallback lexical pra páginas explícitas) ou `0.6-0.85` (semântico puro)
- `[Fontes: pX, pY, pZ]` no final do `answer` (do system prompt)

## Caso "não achei" (validação negativa)

Pergunta "explique o capítulo 25" (cap. 25 não existe em "O Poder do Hábito"):
- Hermes retorna: "Esse capítulo não parece existir no livro. O livro tem 11 capítulos, posso resumir um existente?"
- Sources vazio (nada relevante)
- HTTP 200 (não retorna 404 — handler não sabe distinguir "sem match" de "ok")

Esse comportamento é aceitável, mas se quiser retornar 404 quando sources é vazio, é 1 linha no `semantic_answer`.

## Próxima evolução (não feita, opcional)

- Substituir `cached_embed(maxsize=512)` por cache persistente (Redis ou arquivo JSON) pra sobreviver a restart do service
- Adicionar "expand query" — quebrar pergunta multi-parte em K sub-queries, fazer retrieval pra cada
- Streaming do Hermes (`stream=true` em chat completions) pra TTFB mais rápido
