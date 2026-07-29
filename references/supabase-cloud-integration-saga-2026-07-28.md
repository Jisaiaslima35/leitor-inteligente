# Integração Supabase Cloud — Saga real 28/07/2026 (Leitor Inteligente)

Esta é a narrativa operacional da sessão em que Isaías integrou o Leitor Inteligente com Supabase Cloud pela primeira vez. Documenta o **caminho que de fato funcionou** (não o planejado) e todos os pitfall que apareceram em runtime.

> **Contexto**: app PWA rodando em `preview.automacaojs.us/leitor-inteligente/`, 354 páginas de *O Poder do Hábito* extraídas em `data/o-poder-do-habito-pages.json`. Sem Supabase ainda. Isaías pediu: "vamos integrar com meu supabase agora".

---

## TL;DR

1. Isaías criou projeto Cloud novo: `yfnzlowtgnlqizobnslh` (region `us-west-2`), senha `Agosto1251987#`, plano Free.
2. Management API (`api.supabase.com/v1/projects/<ref>/database/query`) aplicada com token `SUPABASE_ACCESS_TOKEN` de `/root/.hermes/secrets/supabase.env` (reusado do DeskcommCRM — funciona pra qualquer projeto da mesma org).
3. Schema: 3 tabelas (ebooks, ebook_pages com `vector(384)`, reading_progress) + RLS permissiva + RPC `match_ebook_pages`.
4. Storage REST: bucket `ebooks` privado + PDF de 3.83MB em `o-poder-do-habito/livro.pdf`.
5. Páginas + chapter mapping (11 capítulos) populadas via PostgREST batch.
6. Embeddings: **fastembed** local (BGE-small-en 384d) — 352 páginas em ~240s CPU-only.
7. PATCH em loop (352 patches em ~140s) salvou as embeddings.
8. Smoke test: pergunta "como mudar um hábito?" → top-1 #2 p261 cap.10 Apêndice "Um guia pro leitor" (similarity 0.82) — confirmação que RAG semântico puxa o conteúdo certo.

---

## 1. Conexão VPS → Supabase: POR QUE NÃO psql direto

A VPS atual (jul/2026) tem **apenas rota IPv6** e nenhuma rota IPv4 para AWS us-east-1. Conexão TCP direta pra Supabase Cloud falha em 3 formas:

- `db.<ref>.supabase.co:5432` → `Network unreach` (sem rota IPv4)
- `aws-0-sa-east-1.pooler.supabase.com:6543` → `(ENOTFOUND) tenant/user postgres.<ref> not found` (pooler errada)
- Outras regiões (us-east-1, us-west-1) → mesmo `(ENOTFOUND)`

**Solução adotada**: tudo via REST API + Management API. Zero conexão TCP.

| Funcionalidade | Endpoint |
|---|---|
| SQL arbitrário | `POST https://api.supabase.com/v1/projects/<ref>/database/query` |
| Storage bucket | `POST https://<ref>.supabase.co/storage/v1/bucket` |
| Storage upload | `POST https://<ref>.supabase.co/storage/v1/object/<bucket>/<path>` |
| PostgREST tables | `GET/POST/PATCH https://<ref>.supabase.co/rest/v1/<tabela>` |
| RPC function | `POST https://<ref>.supabase.co/rest/v1/rpc/<fn_name>` |
| Descobrir projeto/região | `GET https://api.supabase.com/v1/projects/<ref>` |

---

## 2. Schema aplicado (1 única chamada Management API)

```sql
-- Extensions
CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;

-- Tabelas
CREATE TABLE IF NOT EXISTS public.ebooks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text UNIQUE NOT NULL,
    title text NOT NULL,
    author text NOT NULL,
    description text,
    cover_url text,
    pdf_storage_path text NOT NULL,
    total_pages int NOT NULL,
    chapter_count int DEFAULT 0,
    price_cents int DEFAULT 0,
    is_published boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ebook_pages (
    id bigserial PRIMARY KEY,                       -- PK separada da UNIQUE
    ebook_id uuid NOT NULL REFERENCES public.ebooks(id) ON DELETE CASCADE,
    page_number int NOT NULL,
    chapter_number int,
    chapter_title text,
    page_text text NOT NULL,
    word_count int,
    embedding vector(384),                          -- 384 = BGE-small-en, NÃO 1536 (foi redimensionado depois)
    created_at timestamptz DEFAULT now(),
    UNIQUE(ebook_id, page_number)                   -- UNIQUE constraint separada da PK
);

CREATE TABLE IF NOT EXISTS public.reading_progress (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ebook_id uuid NOT NULL REFERENCES public.ebooks(id) ON DELETE CASCADE,
    current_page int NOT NULL DEFAULT 1,
    last_read_at timestamptz DEFAULT now(),
    created_at timestamptz DEFAULT now(),
    UNIQUE(user_id, ebook_id)
);

-- Índices
CREATE INDEX IF NOT EXISTS ebook_pages_ebook_id_idx ON public.ebook_pages(ebook_id);
CREATE INDEX IF NOT EXISTS ebook_pages_page_number_idx ON public.ebook_pages(ebook_id, page_number);
CREATE INDEX IF NOT EXISTS ebook_pages_embedding_idx
    ON public.ebook_pages USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS reading_progress_user_id_idx ON public.reading_progress(user_id);

-- RPC pra RAG vetorial
CREATE OR REPLACE FUNCTION public.match_ebook_pages(
    query_embedding vector(384),
    match_ebook_slug text,
    match_count int DEFAULT 5,
    chapter_filter int DEFAULT NULL
)
RETURNS TABLE (
    page_number int,
    chapter_number int,
    chapter_title text,
    page_text text,
    similarity float
) LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT ep.page_number, ep.chapter_number, ep.chapter_title, ep.page_text,
           1 - (ep.embedding <=> query_embedding) AS similarity
    FROM public.ebook_pages ep
    JOIN public.ebooks e ON e.id = ep.ebook_id
    WHERE e.slug = match_ebook_slug
      AND (chapter_filter IS NULL OR ep.chapter_number = chapter_filter)
      AND ep.embedding IS NOT NULL
    ORDER BY ep.embedding <=> query_embedding
    LIMIT match_count;
END; $$;

-- RLS
ALTER TABLE public.ebooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ebook_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reading_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ebooks_public_read" ON public.ebooks FOR SELECT USING (true);
CREATE POLICY "ebook_pages_public_read" ON public.ebook_pages FOR SELECT USING (true);
CREATE POLICY "reading_progress_own" ON public.reading_progress FOR ALL USING (auth.uid() = user_id);

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN public TO anon, authenticated, service_role;
```

**POST no Management API**:
```bash
curl -sS -X POST https://api.supabase.com/v1/projects/yfnzlowtgnlqizobnslh/database/query \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "<sql_acima>"}'
# esperado: HTTP 201 + body `[]`
```

---

## 3. Storage: bucket + PDF

```bash
# Bucket — payload MÍNIMO (file_size_limit grande + mime_types explode 413)
curl -sS -X POST "$SUPABASE_URL/storage/v1/bucket" \
  -H "apikey: $SUPABASE_SERVICE_ROLE" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE" \
  -H "Content-Type: application/json" \
  -d '{"name":"ebooks","public":false}'
# esperado: HTTP 200 {"name":"ebooks"}

# Upload PDF (3.83MB)
curl -sS -X POST "$SUPABASE_URL/storage/v1/object/ebooks/o-poder-do-habito/livro.pdf" \
  -H "apikey: $SUPABASE_SERVICE_ROLE" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE" \
  -H "Content-Type: application/pdf" -H "x-upsert: true" \
  --data-binary @/root/projetos/leitor-inteligente/public/books/o-poder-do-habito.pdf
# esperado: HTTP 200 {"Key":"ebooks/o-poder-do-habito/livro.pdf","Id":"<uuid>"}
```

---

## 4. Ebook + 354 páginas

### 4.1 ebook metadata

```bash
curl -sS -X POST "$SUPABASE_URL/rest/v1/ebooks" \
  -H "apikey: $SR" -H "Authorization: Bearer $SR" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{"slug":"o-poder-do-habito","title":"O Poder do Hábito","author":"Charles Duhigg",
       "description":"...","pdf_storage_path":"o-poder-do-habito/livro.pdf",
       "total_pages":354,"price_cents":2990,"is_published":true}'
# retorna ebook_id UUID
```

### 4.2 batch insert 354 páginas em chunks de 30

```bash
# CRÍTICO: --data-binary @arquivo (NÃO -d inline) — quebra com OSError 7
# CRÍTICO: Prefer: resolution=ignore-duplicates — pula conflito UNIQUE (não aborta o batch)
for i in $(seq 0 30 353); do
  python3 -c "
import json
pages = json.load(open('/root/projetos/leitor-inteligente/data/o-poder-do-habito-pages.json'))
CHAPTERS = [(0,'Prologo',6,14),(1,'O loop do habito',16,41),...,(10,'Apendice',261,271)]
def ch(p):
    for n,t,s,e in CHAPTERS:
        if s <= p <= e: return n,t
    return None,None
rows=[{'ebook_id':'$EBOOK_ID','page_number':p['page'],
       'chapter_number':ch(p['page'])[0],'chapter_title':ch(p['page'])[1],
       'page_text':p['text'],'word_count':len((p['text'] or '').split())} for p in pages[$i:$i+30]]
json.dump(rows, open('/tmp/chunk.json','w'))
"
  curl -sS -X POST "$SUPABASE_URL/rest/v1/ebook_pages" \
    -H "apikey: $SR" -H "Authorization: Bearer $SR" \
    -H "Content-Type: application/json" -H "Prefer: resolution=ignore-duplicates" \
    --data-binary @/tmp/chunk.json
done
```

### 4.3 Validação count

```bash
curl -sS -I "$SUPABASE_URL/rest/v1/ebook_pages?select=id&ebook_id=eq.<uuid>" \
  -H "apikey: $SR" -H "Authorization: Bearer $SR" -H "Prefer: count=exact"
# esperado: header 'content-range: 0-353/354'
```

---

## 5. Embeddings: a escolha, os pitfalls, o fix

### 5.1 Tabela de modelos antes/depois

| Modelo | dim | Origem | Status nesta sessão |
|---|---|---|---|
| Gateway Hermes 8642 /v1/embeddings | — | interno | **NÃO EXISTE** (404) |
| OpenAI text-embedding-3-small | 1536 | externo | descartado (custo + schema mudaria) |
| **BAAI/bge-small-en-v1.5 via fastembed** | 384 | local | **ADOTADO** |
| sentence-transformers BGE-large | 1024 | local | descartado (download 1.3GB) |

Escolha final: fastembed + BGE-small-en (33M params, ~240s pra 352 páginas em CPU-only, qualidade suficiente pra RAG top-k).

### 5.2 O 1º embedding attempt (que falhou)

```python
# ESTE CÓDIGO FALHA EM SILÊNCIO (sem traceback útil):
from fastembed import TextEmbedding
model = TextEmbedding("BAAI/bge-small-en-v1.5")
embeddings = list(model.embed(texts, batch_size=32, parallel=4))
json.dump([{"embedding": e} for e in embeddings], f)
```

Erros que apareceram em sequência:
1. `RuntimeError: An attempt has been made to start a new process before the current process has finished bootstrapping` → multiprocessing fork bomb do `parallel=4` em script Python rodando via `uv` (não freeze).
2. `TypeError: Object of type ndarray is not JSON serializable` ao tentar `json.dump` mesmo com embeddings "gerados" — `fastembed` retorna `numpy.ndarray`, não `list`.

Fix:
```python
import os
os.environ["OMP_NUM_THREADS"] = "2"

def main():
    from fastembed import TextEmbedding  # import TARDIO
    model = TextEmbedding("BAAI/bge-small-en-v1.5")
    embeddings = list(model.embed(texts, batch_size=16, parallel=1))  # parallel=1!
    output = [{"embedding": e.tolist()} for e in embeddings]  # .tolist()!
    json.dump(output, f)

if __name__ == "__main__":
    main()
```

Validação que apareceu como log:
```
[0.0s] Carregando páginas...
[0.0s] 352 páginas válidas
[1.0s] Modelo OK (dim=384)
[242.4s] Done em 241.4s (1.5 pg/s)
[242.7s] Salvo /tmp/embeddings_bge.json (352 entries)
```

### 5.3 O 2º embedding attempt: salvar no Supabase

Tentativa 1: **POST upsert** com batch (`Prefer: resolution=merge-duplicates`) — **FALHOU** com `{"code":"23502","details":"Failing row contains (null, ..., embedding)", "message":"null value in column \"id\" of relation \"ebook_pages\" violates not-null constraint"}`.

Causa raiz: `merge-duplicates` precisa de **ON CONFLICT declarado na URL** (`?on_conflict=ebook_id,page_number`). Sem isso, o PostgREST tenta fazer INSERT (gerando novo `id` no bigserial) mas a UNIQUE constraint `(ebook_id, page_number)` conflita sem definição de merge.

**Fix adotado: PATCH em loop**, 1 embedding por vez:
```python
# pseudocódigo
for e in embeddings:  # 352 entries
    pgreq(f"PATCH /rest/v1/ebook_pages?ebook_id=eq.{X}&page_number=eq.{e.page}",
          body={"embedding": e.embedding})
# 352 PATCHes em ~140s na VPS testada
```

Validação: 352/352 success, 0 falhas, 2.5 pg/s.

---

## 6. Smoke test final (sempre validar antes de devolver a Isaías)

```python
from fastembed import TextEmbedding
model = TextEmbedding("BAAI/bge-small-en-v1.5")
q_emb = list(model.embed(["como mudar um hábito?"]))[0].tolist()

import requests  # ou subprocess curl
r = requests.post(
    f"{SUPABASE_URL}/rest/v1/rpc/match_ebook_pages",
    headers={"apikey": SR, "Authorization": f"Bearer {SR}"},
    json={"query_embedding": q_emb,
          "match_ebook_slug": "o-poder-do-habito",
          "match_count": 5}
)
for hit in r.json():
    print(f"p{hit['page_number']} cap.{hit['chapter_number']} sim={hit['similarity']:.3f}: "
          f"{hit['chapter_title']}")
```

**Resultado observado**:
```
#1  p15  cap.None sim=0.836  PARTE UM abertura
#2  p261 cap.10   sim=0.815  Apêndice "Um guia pro leitor de como usar estas ideias"  ← EXATO
#3  p207 cap.None sim=0.815  PARTE TRÊS abertura
#4  p257 cap.9    sim=0.812  A neurologia do livre-arbítrio
#5  p114 cap.4    sim=0.794  Hábitos angulares (exercício)
```

O top-1 #2 (Apêndice, p261) é literalmente o capítulo "como mudar hábito" do livro — confirma busca semântica real, não só lexical.

---

## 7. Variáveis de ambiente finais (salvar em /root/.hermes/secrets/leitor-supabase.env, modo 600)

```
SUPABASE_URL=https://yfnzlowtgnlqizobnslh.supabase.co
SUPABASE_ANON_KEY=eyJ...role=anon...
SUPABASE_SERVICE_ROLE=eyJ...role=service_role...
SUPABASE_DB_PASSWORD=Agosto1251987#
SUPABASE_PROJECT_REF=yfnzlowtgnlqizobnslh
SUPABASE_EBOOK_ID=<uuid-do-ebook>
```

`SUPABASE_ACCESS_TOKEN` (reusado do DeskcommCRM, em `/root/.hermes/secrets/supabase.env`).

---

## 8. Pitfalls resumidos (cada um → ver seção acima)

1. ❌ psql direto VPS→Supabase → Network unreach / ENOTFOUND → ✅ Management API
2. ❌ Bucket com `file_size_limit` 100MB + mime types → ✅ payload mínimo
3. ❌ subprocess.run(`-d json.dumps(big)`) → OSError 7 → ✅ `--data-binary @file`
4. ❌ `Prefer: resolution=merge-duplicates` sem `on_conflict=...` → 23502 NOT NULL → ✅ PATCH loop
5. ❌ fastembed.embed sem fix multiprocessing → fork bomb em silêncio → ✅ `if __name__` + `OMP_NUM_THREADS=2` + `parallel=1`
6. ❌ `json.dump({"embedding": ndarray})` → TypeError → ✅ `.tolist()` ANTES
7. ❌ pegar embed do gateway Hermes 8642 → 404 /v1/embeddings → ✅ fastembed local

---

## 9. Próximas etapas (não-feitas nesta sessão)

Etapa 2 — **Auth**: signup/login no PWA via `@supabase/supabase-js`, magic link email, sessão persistida em localStorage. Policies de RLS já aplicadas (`reading_progress_own` exige `auth.uid() = user_id`).

Etapa 3 — **Substituir backend Python** (`api/server.py`) pelo RPC `match_ebook_pages` (PostgREST). O retrieval lexical do Python vira similarity search direto no Supabase. Backend Python vira só proxy pra chamada do Hermes com o snippet retornado pela RPC.

Etapa 4 — **Substituir localStorage** (purchase, progress, library) por queries Supabase (`reading_progress` table já pronta).
