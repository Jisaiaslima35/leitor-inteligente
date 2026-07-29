# Multi-book validation saga (v10) — 28/07/2026

Knowledge bank da primeira sessão onde o Leitor rodou com 2 livros (Hábito + Gálatas)
simultaneamente e os 2 bugs novos que apareceram.

## Contexto

Antes da v10, o Leitor Inteligente funcionava com 1 único livro
(*O Poder do Hábito*) no catálogo. v8-v9 adicionaram pipeline pra
adicionar livros novos, mas o backend RAG ainda tinha constantes
hardcoded do livro original. Quando Isaías adicionou o segundo livro
(Bíblia Dake — Gálatas via OCR/signed URL pipeline), o comportamento
quebrou de duas formas.

## Bug 1: `BOOK_SLUG` hardcoded em `semantic_server.py`

### Sintoma

- Isaías abre o livro de Gálatas (adicionado via v8 pipeline).
- Faz pergunta "faça o resumo da introdução" no Professor IA.
- Resposta volta com fontes de **O Poder do Hábito**, não de Gálatas.

### Causa

`semantic_server.py` (porta 9131) tinha:

```python
BOOK_SLUG = 'o-poder-do-habito'
# ...
def semantic_retrieve(question: str, k: int = 5):
    payload = {
        'query_embedding': q_emb,
        'match_ebook_slug': BOOK_SLUG,  # ← sempre Hábito
        'match_count': k,
    }
```

Independente do `bookId` que o front mandava no request, o backend
consultava embeddings do Hábito no Supabase e devolvia esses chunks.

### Por que demorou pra ser detectado

- O endpoint retornava 200, não quebrava
- Os chunks do Hábito eram "plausíveis" — relevante pra pergunta genérica
- Só Isaías lendo um livro DIFERENTE notou que as fontes citadas
  não eram do livro aberto

### Fix aplicado

```python
def semantic_retrieve(question: str, book_slug: str = BOOK_SLUG, k: int = 5):
    payload = {
        'query_embedding': q_emb,
        'match_ebook_slug': book_slug,  # ← veio do request
        'match_count': k,
    }

# Handler HTTP:
slug = str(data.get('bookSlug') or data.get('book_slug') or BOOK_SLUG).strip()
self.send_json(200, semantic_answer(q, p, book_slug=slug))
```

### Validação pós-fix

Smoke test com 2 livros:
- Pergunta "fale sobre o livro" + slug=`o-poder-do-habito` → sources
  p272, p259, p275, p262, p30 (todas do Hábito) ✅
- Pergunta "fale sobre o livro" + slug=`biblia-dake-galatas` → "Não
  encontrei trechos relevantes" (porque Gálatas ainda não tinha
  embeddings nesse momento) ✅ — comportamento correto

Depois rodei embeddings do Gálatas (12 páginas, 2.2s CPU-only), RAG
passou a responder corretamente sobre Gálatas.

### Lição durável (pitfall #60 do SKILL.md)

> Backend RAG **NUNCA** hardcode qual livro tá atendendo. Sempre
> recebe do front/state do app via parâmetro.

Mesmo quando só tem 1 livro, **o design assume multi-livro desde
o início**. Single-use constants viram bugs silenciosos quando você
escala. Toda vez que criar endpoint novo que consulta `ebooks`/`ebook_pages`,
faça `book_slug` vir **sempre** como parâmetro com default sensato
(vai funcionar com catálogo existente), nunca constante.

## Bug 2: Fetch sem `Authorization` em signed-url-api

### Sintoma

Depois de mover PDF fetching pra signed URL (v7), frontend chamava
`/signed-url-api/sign` sem header JWT. Backend exigia JWT pra extrair
`user_id` da sessão. Resultado:

```
Não consegui carregar o PDF: Sessão inválida. Faça login.
```

Aparecia mesmo o usuário logado (Topbar mostrava "Olá, Isaías").

### Causa

```ts
fetch(`${BASE_URL}signed-url-api/sign`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  // ← falta Authorization
  body: JSON.stringify({ slug: book.id }),
})
```

Backend (`signed_url_server.py`) faz `auth_header.split('Bearer ')[1]`,
recebe `Authorization` ausente → `None` → return 401.

### Fix aplicado em `ReaderPage.tsx`

```ts
supabase.auth.getSession().then(({ data: sessionData }) => {
  const accessToken = sessionData.session?.access_token
  if (!accessToken) {
    setPdfError('Sessão inválida. Faça login.')
    return
  }
  return fetch(`${BASE_URL}signed-url-api/sign`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ slug: book.id }),
  })
})
.then((r) => r ? r.json().then(j => ({ status: r.status, body: j })) : null)
// ... resto igual
```

### Lição durável (pitfall #61 do SKILL.md)

> Quando adicionar endpoint backend que valida sessão Supabase, o
> fetch do front DEVE incluir `Authorization: Bearer ${access_token}`.
> Helper `getAccessToken()` deveria ser co-localizado com o endpoint
> no schemas Supabase pra evitar ter que lembrar disso.

Não confiar só no cookie/sessão do browser — backend precisa do JWT
explícito via header pra validar. Front deve sempre passar pro
backend o token que tem em `supabase.auth.getSession()`.

## Pipeline de ingestão v8 — usado em produção

Bíblia Dake — Gálatas (12 páginas, OCR):

1. `ocrmypdf -l por --skip-text --deskew --clean` → PDF híbrido (28s)
2. `pdftotext -layout` → 12 páginas × ~1072 palavras = 12.859 palavras
3. Upload pro Supabase Storage `ebooks/biblia-dake-galatas/livro.pdf`
   (3.3MB final)
4. INSERT na `ebooks` com `slug=biblia-dake-galatas`
5. Compra pro user de teste `aaa3fb43-...`
6. (depois do fix do BOOK_SLUG) embeddings BGE-small-en (2.2s)
7. Capa enviada como imagem pelo Isaías → uploaded pro Storage como
   `capa.jpg`, signed URL de 1 ano, `UPDATE ebooks.cover_url`
8. Edit `src/domain/catalog.ts` adicionando nova entry (manual,
   rebuild, deploy)
9. Book aparecendo em home/loja/biblioteca com capa correta

Total: ~5min do upload do PDF até o deploy com livro navegável.

## Pré-requisitos de ambiente (validado na VPS)

Para v8 funcionar, **tudo isso** precisa estar instalado
(conferido antes de rodar):

```bash
for cmd in tesseract pdftoppm unpaper ocrmypdf pdftotext python3; do
  command -v $cmd >/dev/null && echo "✓ $cmd" || echo "✗ $cmd MISSING"
done

tesseract --list-langs 2>&1 | grep por  # PT-BR instalado
# esperado: por

pip show ocrmypdf fastembed 2>&1 | grep -E "^Name|^Version"
# esperado: Name: ocrmypdf, Name: fastembed
```

Sem `unpaper` ou `tesseract-ocr-por` → `ocrmypdf` falha com mensagem
vaga tipo "command not found". Validar **antes** de fazer upload.

## Multi-book workflow (Isaías pediu, agora confirmado)

ISAÍA: adicionar livro novo = **[ele me manda o PDF ou capa por aqui mesmo]**

Fluxo completo:

```bash
# 1. (opcional) Ele já manda capa por imagem
# 2. Salvar PDF no caminho temporário
# 3. Rodar pipeline v8:
bash /root/.hermes/skills/pwa-leitor-inteligente/scripts/ingest_book.sh \
  /tmp/livro.pdf "slug-do-livro" "Título" "Autor" 2990

# 4. (se mandou capa) Upload capa:
# - signed URL 1 ano (capa cacheável, melhor que 60min)
# - UPDATE ebooks.cover_url

# 5. Adicionar entry no catalog.ts manualmente
# 6. Build + deploy
npm run build && rsync -a --delete dist/ /var/www/preview/leitor-inteligente/

# 7. Validar:
# - Capa aparece na home/loja/biblioteca
# - Signed URL gera com JWT (autenticado)
# - RAG responde com fontes do livro certo (não do anterior)
# - Bibliotecar abre com capa colorida correta
```

## Pitfalls consolidados que vieram junto

A v10 não trouxe só 2 bugs — trouxe também:

- **Pitfall #58 (URL truncada)** apareceu novamente na hora de colar
  a cover_url signed URL de 1 ano no catalog.ts. Display do sandbox
  truncou o JWT no `eyJraW...UrDQ`, eu colei sem perceber, capa ficou
  400 bad request. Confirmado: o pitfall continua válido, vale
  manter a regra "validar via curl antes de patchar".

- **Catalog estático (vs dinâmico do DB)** é uma trade-off consciente.
  Pra catálogo pequeno (≤10 livros), manter no código é OK e permite
  rebuild + deploy com TypeScript types estáveis. Quando passar de
  50 livros, migrar pra buscar `ebooks` direto do banco no
  `HomePage`/`StorePage` via PostgREST.

## Resumo de lições

1. **Backend RAG nunca hardcode livro** — sempre `book_slug` como
   parâmetro com default
2. **Fetch autenticado sempre leva `Authorization`** — endpoint que
   valida sessão precisa do JWT explícito
3. **URLs de signed URL precisam `/storage/v1` no path** — Supabase
   retorna relativo mas o endpoint é `/storage/v1/object/sign/...`
4. **Validar JWT antes de patchar** — display sempre trunca
5. **Multi-livro desde o dia 1** — design assume N livros no
   catálogo, mesmo funcionando com 1
