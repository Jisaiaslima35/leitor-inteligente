# Supabase Integration — Receita Completa (Etapa 1: Storage + DB + Embeddings)

Receita validada em <28/07/2026> na sessão "integra com meu Supabase agora". Stack: Supabase Cloud (Free plan), `supabase-py` para SDK Python, `openai` Python SDK apontando pra gateway Hermes 8642 OU OpenAI direta, `psycopg2`/`postgres:17-alpine` pra rodar o schema SQL.

## TL;DR do fluxo

1. Isaías cria projeto em https://supabase.com/dashboard → te passa URL + service_role key
2. Você cria `supabase/schema.sql` (3 tabelas: `ebooks`, `ebook_pages`, `reading_progress`) + aplica via `psql`
3. Roda `scripts/migrate_book.py` — faz upload do PDF pro Storage, insere metadata do ebook, migra páginas pra `ebook_pages` com `chapter_number`+`title`, e popula embeddings em batch
4. Smoke test: 3 queries SQL contam páginas, embeddings nulos, capítulos
5. Reporta pra Isaías em 2-3 linhas

## Inputs que você precisa pedir (UMA mensagem, NUNCA em sequência)

Copie este bloco e cole pro Isaías assim que ele pedir integração:

```
Beleza! Pra eu sair codando agora, me manda:

1. **Project URL**: https://<ref>.supabase.co (Dashboard → ⚙️ Settings → API → Project URL)
2. **service_role key** (NÃO a anon): mesma tela, campo `service_role`. ATENÇÃO: essa chave bypassa TODA Row Level Security, então vou guardar em /root/.hermes/secrets/leitor-supabase.env (chmod 600) e JAMAIS usar no frontend.

Não cria nenhuma tabela no projeto — eu rodo o schema SQL na ordem certa.

Se preferir outro caminho:
- Reusar um projeto Supabase existente: manda só URL + service_role dele
- Self-hosted na VPS (~30min): fala que eu subo

Mais alguma restrição (região, plano, domínio custom)?
```

> **Pitfall** (sinal de aprendizado 19): NÃO fazer 2 `clarify()` em sequência. Isaías respondeu frustrado "Já fiz uma integração com você há dois dias atrás verifica aí" porque eu pedi "qual Supabase?" + "qual escopo?" em separado. Sempre ofereça os 3 caminhos pré-fabricados e peça tudo de uma vez.

## Env vars (servidor)

Salvar em `/root/.hermes/secrets/leitor-supabase.env` (chmod 600):

```bash
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...               # ~200 chars, role=service_role
SUPABASE_ANON_KEY=eyJhbGc...                       # ~200 chars, role=anon (vai pro frontend)
SUPABASE_DB_PASSWORD=<senha>                       # se for usar DATABASE_URL direta
SUPABASE_DB_URL=postgresql://postgres.<ref>:<senha_url_encoded>@aws-0-sa-east-1.pooler.supabase.com:6543/postgres
HERMES_API_KEY=hermes-isa...2026                   # API_SERVER_KEY do /root/.hermes/.env (porta 8642)
OPENAI_API_KEY=sk-...                              # se for usar text-embedding-3-small direto
```

**URL-encoding na senha** (Pitfall real 26/07, DeskcommCRM): senha `Agosto1251987#` → `Agosto1251987%23`. Caracteres que precisam encoding: `#` `!` `@` `$` `&` `(` `)`. Comando:

```bash
python3 -c "import urllib.parse; print(urllib.parse.quote(open('/dev/stdin').read().strip()))" <<<"$SENHA"
```

## Schema SQL completo (3 tabelas + RLS)

Arquivo: `/root/projetos/leitor-inteligente/supabase/schema.sql`

```sql
-- Extensões necessárias (vector em public para usar em embeddings)
CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;

-- Catálogo de livros
CREATE TABLE public.ebooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  title text NOT NULL,
  author text,
  cover_url text,
  pdf_path text NOT NULL,
  total_pages integer NOT NULL,
  price_cents integer NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Páginas com embeddings (RAG semântico)
CREATE TABLE public.ebook_pages (
  id bigserial PRIMARY KEY,
  ebook_id uuid REFERENCES public.ebooks(id) ON DELETE CASCADE,
  page_number integer NOT NULL,
  chapter_number integer,
  chapter_title text,
  text text NOT NULL,
  embedding vector(1536),
  UNIQUE (ebook_id, page_number)
);

-- Índice vetorial (ivfflat — bom pra <1M vetores; pra escala, troca por HNSW)
CREATE INDEX ebook_pages_embedding_idx ON public.ebook_pages
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Progresso de leitura por usuário
CREATE TABLE public.reading_progress (
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  ebook_id uuid REFERENCES public.ebooks(id) ON DELETE CASCADE,
  page_number integer NOT NULL DEFAULT 1,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, ebook_id)
);

-- RLS: ebooks/páginas leitura pública; progresso só do próprio user
ALTER TABLE public.ebooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ebook_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reading_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ebooks read" ON public.ebooks FOR SELECT TO anon USING (true);
CREATE POLICY "ebook_pages read" ON public.ebook_pages FOR SELECT TO anon USING (true);
CREATE POLICY "reading_progress own" ON public.reading_progress
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Trigger de updated_at
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
CREATE TRIGGER reading_progress_touch BEFORE UPDATE ON public.reading_progress
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
```

**Aplicar schema:**

```bash
set -a; source /root/.hermes/secrets/leitor-supabase.env; set +a
docker run --rm -i postgres:17-alpine \
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;" \
  -f /root/projetos/leitor-inteligente/supabase/schema.sql
```

> **Pitfall** do `supabase-self-host-restore`: extensions precisam estar em schema certo ANTES do baseline. Como esse schema é pequeno e caseiro, `vector SCHEMA public` antes da `CREATE TABLE ebook_pages` resolve. Se quebrar em `type public.vector does not exist`, recriar com `CREATE EXTENSION vector SCHEMA extensions` e ajustar schema.

## Script de migração

Arquivo: `/root/projetos/leitor-inteligente/scripts/migrate_book.py`

```python
#!/usr/bin/env python3
"""Migra um PDF + JSON já existentes pra Supabase (Storage + DB + embeddings).

Uso:
    set -a && source /root/.hermes/secrets/leitor-supabase.env && set +a
    python3 scripts/migrate_book.py

Assume:
    - /root/projetos/leitor-inteligente/public/books/o-poder-do-habito.pdf
    - /root/projetos/leitor-inteligente/data/o-poder-do-habito-pages.json
    - Supabase Storage bucket 'ebooks' já criado (fazer no dashboard OU via API)
"""
import os, json, sys, time
from pathlib import Path
from supabase import create_client, Client
from openai import OpenAI

ROOT = Path('/root/projetos/leitor-inteligente')
SLUG = 'o-poder-do-habito'
BUCKET = 'ebooks'
EMBED_MODEL = os.environ.get('EMBED_MODEL', 'text-embedding-3-small')
EMBED_BASE = os.environ.get('EMBED_BASE', 'https://api.openai.com/v1')  # ou http://127.0.0.1:8642/v1
HERMES_KEY = os.environ.get('HERMES_API_KEY', os.environ.get('OPENAI_API_KEY'))

sb: Client = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])
embed_client = OpenAI(api_key=HERMES_KEY, base_url=EMBED_BASE)


def ensure_bucket():
    """Cria bucket 'ebooks' se não existir (idempotente)."""
    try:
        sb.storage.create_bucket(BUCKET, {'public': False, 'fileSizeLimit': 50*1024*1024})
    except Exception as e:
        if 'already exists' not in str(e).lower():
            raise


def upload_pdf():
    pdf_path = ROOT / f'public/books/{SLUG}.pdf'
    print(f'1. Upload PDF: {pdf_path} ({pdf_path.stat().st_size//1024} KB)...')
    with open(pdf_path, 'rb') as f:
        sb.storage.from_(BUCKET).upload(
            f'{SLUG}/livro.pdf',
            f.read(),
            {'content-type': 'application/pdf', 'upsert': 'true'}
        )
    print('   ✓ uploaded')


def insert_ebook(total_pages, price_cents=2990):
    print('2. Insere ebook em public.ebooks...')
    existing = sb.table('ebooks').select('id').eq('slug', SLUG).execute()
    if existing.data:
        eid = existing.data[0]['id']
        print(f'   ✓ já existe (id={eid})')
        return eid
    eb = sb.table('ebooks').insert({
        'slug': SLUG,
        'title': 'O Poder do Hábito',
        'author': 'Charles Duhigg',
        'pdf_path': f'{SLUG}/livro.pdf',
        'total_pages': total_pages,
        'price_cents': price_cents,
    }).execute()
    eid = eb.data[0]['id']
    print(f'   ✓ criado (id={eid})')
    return eid


def chapter_of(page_num, chapters):
    """Resolve chapter_number+chapter_title pra page_num. chapters = [(num, title, start, end), ...]"""
    for n, t, s, e in chapters:
        if s <= page_num <= e:
            return n, t
    return None, None


def insert_pages(ebook_id, chapters):
    json_path = ROOT / f'data/{SLUG}-pages.json'
    pages = json.loads(json_path.read_text(encoding='utf-8'))
    print(f'3. Insere {len(pages)} páginas em public.ebook_pages...')
    BATCH = 50
    inserted = 0
    for i in range(0, len(pages), BATCH):
        chunk = []
        for p in pages[i:i+BATCH]:
            cn, ct = chapter_of(p['page'], chapters)
            chunk.append({
                'ebook_id': ebook_id,
                'page_number': p['page'],
                'chapter_number': cn,
                'chapter_title': ct,
                'text': p['text'][:8000],  # truncar pra embeddings
            })
        sb.table('ebook_pages').insert(chunk).execute()
        inserted += len(chunk)
        print(f'   - {inserted}/{len(pages)}')
    print(f'   ✓ {inserted} páginas inseridas')


def embed_pages(ebook_id):
    """Loop sequencial + retry. ~3-5min pra 354 páginas."""
    print('4. Gera embeddings...')
    rows = sb.table('ebook_pages').select('page_number,text').eq('ebook_id', ebook_id).order('page_number').execute()
    total = 0; failed = []
    for row in rows.data:
        pn = row['page_number']
        text = row['text'][:8000]
        if not text.strip():
            failed.append((pn, 'texto vazio')); continue
        ok = False
        for attempt in range(3):
            try:
                resp = embed_client.embeddings.create(model=EMBED_MODEL, input=text)
                emb = resp.data[0].embedding
                sb.table('ebook_pages').update({'embedding': emb}).eq('ebook_id', ebook_id).eq('page_number', pn).execute()
                total += 1; ok = True; break
            except Exception as e:
                wait = 2 ** attempt
                print(f'   retry p{pn} attempt {attempt+1}/3 (sleep {wait}s): {type(e).__name__}: {str(e)[:80]}')
                time.sleep(wait)
        if not ok:
            failed.append((pn, 'max retries'))
        if total % 20 == 0 and total > 0:
            print(f'   - {total}/{len(rows.data)}')
    print(f'   ✓ {total}/{len(rows.data)} embeddings')
    if failed:
        print(f'   ✗ {len(failed)} falhas: {failed[:10]}...')
    return total, failed


# CHAPTERS list (mesma do api/server.py) — copiar do código existente
CHAPTERS = [
    # (num, title, start_page, end_page) — Ajustar conforme o livro
    (0, 'Prólogo', 6, 14),
    (1, 'O loop do hábito', 16, 41),
    (2, 'O cérebro que anseia por hábito', 42, 70),
    # ... completar com greps em /tmp/livro.txt
]


def main():
    json_path = ROOT / f'data/{SLUG}-pages.json'
    pages = json.loads(json_path.read_text(encoding='utf-8'))
    total_pages = len(pages)
    print(f'=== Migrate {SLUG}: {total_pages} páginas ===\n')
    ensure_bucket()
    upload_pdf()
    ebook_id = insert_ebook(total_pages)
    insert_pages(ebook_id, CHAPTERS)
    ok, failed = embed_pages(ebook_id)
    print(f'\n=== DONE: {ok}/{total_pages} embeddings, {len(failed)} falhas ===')
    sys.exit(0 if not failed else 1)


if __name__ == '__main__':
    main()
```

**Dependências Python:**

```bash
pip install supabase openai  # supabase-py + openai SDK (reaproveita pro gateway)
```

**Modelo de embedding — qual usar:**

| Opção | Custo | Velocidade | Quando usar |
|---|---|---|---|
| `text-embedding-3-small` (OpenAI direto) | ~$0.02/1M tokens (354 pgs ≈ $0.02) | ~1s/pg | **Padrão**, melhor qualidade pra RAG |
| `text-embedding-3-large` (OpenAI) | ~$0.13/1M tokens | ~1.5s/pg | Só se small for insuficiente |
| Hermes 8642 | grátis | depende do que tá exposto | Se Isaías quiser 100% self-hosted — **conferir `/v1/embeddings` ANTES** (`curl http://127.0.0.1:8642/v1/models -H "Authorization: Bearer $KEY"`) |

Pra trocar o modelo, basta mudar `EMBED_MODEL` + `EMBED_BASE` env vars (sem mudar o script).

## Geração do CHAPTERS list (regex no pdftotext)

```bash
# 1. Extrai texto
pdftotext -layout /root/projetos/leitor-inteligente/public/books/o-poder-do-habito.pdf /tmp/livro.txt

# 2. Acha marcações de capítulo (ajustar regex pro padrão do livro)
grep -nE '^(CAP[ÍI]TULO|PARTE|INTRODU[ÇC][ÃA]O|EP[ÍI]LOGO|PR[ÓO]LOGO)\s' /tmp/livro.txt | head -40

# 3. Pra cada match, página = numero de \f antes da linha + 1
python3 <<'PY'
import re
text = open('/tmp/livro.txt').read()
chunks = text.split('\f')
def page_of(line_no):
    cum, page = 0, 1
    for i, c in enumerate(chunks):
        if cum + len(c) + 1 >= line_no:
            return i + 1
        cum += len(c) + 1
    return len(chunks)
for n, t, s, e in CHAPTERS:
    pass  # auto-derivado dos matches do grep
PY
```

## Smoke tests (rodar depois do migrate_book.py)

```bash
set -a; source /root/.hermes/secrets/leitor-supabase.env; set +a

# 1. Total de páginas (esperado: 354)
docker run --rm postgres:17-alpine psql "$SUPABASE_DB_URL" -c \
  "SELECT count(*) FROM ebook_pages WHERE ebook_id = (SELECT id FROM ebooks WHERE slug='o-poder-do-habito');"

# 2. Embeddings nulos (esperado: 0)
docker run --rm postgres:17-alpine psql "$SUPABASE_DB_URL" -c \
  "SELECT count(*) FROM ebook_pages WHERE ebook_id = (SELECT id FROM ebooks WHERE slug='o-poder-do-habito') AND embedding IS NULL;"

# 3. Capítulos detectados
docker run --rm postgres:17-alpine psql "$SUPABASE_DB_URL" -c \
  "SELECT chapter_number, chapter_title, min(page_number) AS start, max(page_number) AS end, count(*) AS n FROM ebook_pages WHERE ebook_id = (SELECT id FROM ebooks WHERE slug='o-poder-do-habito') GROUP BY 1,2 ORDER BY 1;"

# 4. Storage (esperado: 200)
curl -sS -o /dev/null -w 'pdf=%{http_code}\n' \
  "$SUPABASE_URL/storage/v1/object/ebooks/o-poder-do-habito/livro.pdf" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

## Relatório final pra Isaías (template curto)

```
Migrei o livro:
✓ 354 páginas pra public.ebook_pages
✓ PDF no bucket ebooks/o-poder-do-habito/livro.pdf
✓ 354 embeddings gerados (text-embedding-3-small)
✓ 14 capítulos mapeados
✗ 0 falhas

Próxima etapa: Auth real (@supabase/supabase-js no PWA)? Ou primeiro fazer a UI de admin pra cadastrar livros?
```

## Próximas etapas (depois da etapa 1 OK)

- **Etapa 2 — Auth**: instalar `@supabase/supabase-js` no projeto Vite, criar `src/lib/supabase.ts`, página `/login` com magic link (Supabase Auth), persistir sessão em localStorage.
- **Etapa 3 — Migração localStorage → Supabase**: primeira visita após login, push progress local → backend (UPSERT no `reading_progress`).
- **Etapa 4 — Painel admin**: form em `AdminPage.tsx` que faz upload PDF + insere ebook, protegido por `is_admin` flag (no `auth.users.app_metadata`).
- **Etapa 5 — Checkout real**: webhook Cakto/Kiwify → `service_role` insere em tabela `purchases(user_id, ebook_id, paid_at)` e policy RLS libera ebook em `user_library`.

## Versões das libs Python testadas nesta sessão

> Não capturar como constraint — só referência de uma execução

- `supabase==2.5.0` (supabase-py)
- `openai==1.40.0` (OpenAI SDK, suporta `base_url` override)
- `postgres:17-alpine` (psql client)

## Pitfalls consolidados (Supabase + PWA estático)

1. **Senha com `#` no DATABASE_URL** → URL-encode (`%23`). Caso real 26/07 DeskcommCRM.
2. **`CREATE EXTENSION vector` precisa vir ANTES da tabela com `vector(...)`**, senão falha em `type public.vector does not exist`.
3. **service_role ignora RLS** — usar APENAS no backend Python, NUNCA no frontend (usar `VITE_SUPABASE_ANON_KEY` em prod).
4. **`import.meta.env.SUPABASE_*` é undefined** se não tiver prefixo `VITE_`. Sempre `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.
5. **PWA com PWA habilitado (`disable: false`) + Supabase Storage = CORS issues se Storage for cross-origin** — Storage do Supabase Cloud é cross-origin por padrão; o bucket PRECISA ter CORS liberado (`sb.storage.create_bucket(..., {'allowedMimeTypes': [...]}')` ou no Dashboard → Storage → Configuration → Allowed origins).
6. **Embeddings são 1536 dims fixos** — se mudar modelo (`text-embedding-3-large` = 3072, `cohere-embed-v3` = 1024), `DROP INDEX` + `ALTER TABLE ebook_pages ALTER COLUMN embedding TYPE vector(<nova_dim>)` + recriar índice.
7. **Não confunda modelo `hermes-agent` com `text-embedding-3-small`** — são namespaces diferentes. Modelo de chat pode não ter endpoint `/v1/embeddings`. Conferir antes com `curl /v1/models`.
8. **Embeddings gerados antes de popular capítulos** — se rodar `embed_pages` antes de `insert_pages`, embeddings ficam nulos; ordem do `main()` importa.
