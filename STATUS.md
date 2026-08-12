# STATUS.md — Leitor Inteligente

Última atualização: 2026-08-12 (bug Fabricante p.235 → fix definitivo)

## 🚨 Fix recente (12/08/2026)

**Bug**: "O Fabricante de Lágrimas" retornava conteúdo de outra página quando usuário perguntava sobre a página ATUAL ("essa página que tô lendo"). Causa raiz: PDF indexado tinha paginação diferente do PDF do usuário (edição Salani vs z-lib, diferença de 2 páginas).

**Fixes aplicados (cobrem TODOS os livros):**

1. **`api/semantic_helpers.py`** — NOVO módulo compartilhado com:
   - `detect_explicit_page()` — detecta "página N" na pergunta
   - `is_current_page_intent()` — detecta "essa página", "to lendo", "me explica" (etc)
   - `lexical_page_lookup_supabase()` — busca exata por número de página
   - `detect_chapter_intent()` — detecta "capítulo N"

2. **`api/semantic_server.py` + `api/fabricante_server.py`** — refatorado pra usar helpers compartilhados. `semantic_retrieve` agora:
   - 1º: detecta página explícita → lookup exato
   - 2º: detecta intenção de página atual + usa `current_page` → lookup exato
   - 3º: fallback embedding semântico

3. **`scripts/validate_book_sync.py`** — NOVO validador PDF ↔ JSON ↔ Supabase. Detecta dessincronização automaticamente. Uso: `python3 scripts/validate_book_sync.py --slug <slug>`

4. **`api/upload_book.py`** — checagem pós-insert detecta dessinc entre páginas com texto e registros Supabase

5. **`api/fabricante_server.py`** — `/health` agora conta páginas reais do JSON (não hardcoded 653)

## 🔧 Como aplicar a fix em livros futuros

Após upload ou reindex:
```bash
python3 scripts/validate_book_sync.py --slug <slug-do-livro>
```

Se sair DESSINC:
- PDF > JSON: PDF tem páginas extras (capa, sumário)
- JSON > Supabase: reindexar (`fastembed_pages.py` + `patch_embeddings.py`)

## 📚 Livros indexados

| Slug | Páginas | Status | Notas |
|---|---|---|---|
| `fabricante-de-lagrimas` | 655 (PDF z-lib) / 653 (Supabase até 12/08) | 🔄 reindexando | Foi reindexado JSON (655p), Supabase pendente |
| `o-poder-do-habito` | - | ✅ sincronizado | |
| `biblia-dake-galatas` | - | ✅ sincronizado | |