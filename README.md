# Leitor Inteligente — PWA de Leitura com Professor IA

PWA que permite ler livros (PDF) e perguntar ao **Professor IA** sobre o conteúdo página por página, capítulo por capítulo, ou por busca semântica (RAG).

**Stack:** Vite + React 19 + TypeScript (frontend) · Python BaseHTTP (6 microserviços) · Supabase (Postgres + Auth + Storage) · FastEmbed BGE-small-en (embeddings)

---

## 🏗️ Arquitetura

```
┌──────────────────────────────────────────────────────────────────┐
│                         FRONTEND (Vite/React)                    │
│  /leitor-inteligente/  →  Static build servido via nginx 9121   │
└──────────────────────────────────────────────────────────────────┘
                                │
                ┌───────────────┼────────────────┐
                ▼               ▼                ▼
        ┌──────────┐    ┌──────────┐    ┌──────────────┐
        │ nginx    │    │ Supabase │    │ APIs Python  │
        │ 9121     │    │ Postgres │    │ (6 microssv) │
        │          │    │ + Storage│    │ portas       │
        │          │    │ + Auth   │    │ 9130-9135    │
        └──────────┘    └──────────┘    └──────────────┘
```

### Frontend (Vite + React 19 + TS)
- `src/App.tsx` — router hash-based (`#/library`, `#/reader/{slug}`, `#/upload`...)
- `src/pages/ReaderPage.tsx` — visualizador PDF + chat Professor IA
- `src/pages/UploadPage.tsx` — upload de PDF com ETA honesto + polling
- `src/pages/LibraryPage.tsx` — livros do user (JOIN user_library + ebooks)
- `src/pages/ProfessorPage.tsx` — chat standalone por slug do livro
- `src/pages/AdminPage.tsx` — admin: ver catálogo, reset library
- `src/lib/supabaseStorage.ts` — bridge entre Storage layer e Supabase
- `src/lib/AuthContext.tsx` — auth Supabase (magic link)

### Backend (6 microserviços Python `BaseHTTPRequestHandler`)

| Porta | Serviço | Responsabilidade |
|-------|---------|------------------|
| 9130  | `server.py` | **Hardcoded "O Poder do Hábito"** — system prompt legado |
| 9131  | `semantic_server.py` | Genérico — usa `bookSlug` do body pra escolher system prompt |
| 9132  | `streak_server.py` | Tracking de streak diário de leitura |
| 9133  | `signed_url_server.py` | Gera signed URL temporária pra um ebook que user comprou |
| 9134  | `upload_book.py` | Pipeline completo: upload → OCR → extract → embeddings → user_library |
| 9135  | `fabricante_server.py` | Específico do **Fabricante de Lágrimas** (653 páginas, tem `detect_explicit_page`) |

Cada serviço roda como **systemd unit** (`/etc/systemd/system/leitor-*-api.service`).

### Banco (Supabase Postgres)

| Tabela | Função |
|--------|--------|
| `ebooks` | Catálogo: id, slug, title, author, cover_url, pdf_storage_path, total_pages, owner_user_id, is_published |
| `ebook_pages` | Texto página-por-página + embedding BGE 384d (`vector(384)`) |
| `user_library` | Compras do user (user_id, ebook_id, payment_status) |
| `progress` | Última página lida por user por livro |

**RLS** ativo em todas as tabelas → user só vê/processa seus próprios dados.

### Storage (Supabase Storage)

- Bucket `ebooks`:
  - `{user_id}/tmp/{ts}_{filename}.pdf` — uploads em processamento
  - `{user_id}/{ebook_id}/livro.pdf` — PDF final do ebook (lido pelo Reader)

---

## 🚀 Como rodar

### Frontend

```bash
cd /root/projetos/leitor-inteligente
npm install
npm run dev          # dev server com HMR
npm run build        # build de produção
sudo rsync -a --delete dist/ /var/www/preview/leitor-inteligente/
```

### Backend (cada serviço em seu terminal)

```bash
python3 api/fabricante_server.py   # 9135
python3 api/semantic_server.py    # 9131
python3 api/server.py             # 9130
python3 api/streak_server.py      # 9132
python3 api/signed_url_server.py  # 9133
python3 api/upload_book.py        # 9134
```

### Variáveis de ambiente

Frontend (Vite — `import.meta.env`):
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Backend (Python — `/root/.hermes/secrets/leitor-supabase.env`):
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE`

Copie `.env.example` para `.env.production` e preencha.

---

## 🐛 Pitfalls históricos (não repetir)

| # | Sintoma | Causa | Fix |
|---|---------|-------|-----|
| 70 | nginx 502 | Conflito docker-proxy Coolify em 9121 | Usar `preview-only.conf` separada |
| 71 | MIME `text/html` em `.mjs` | `types{}` em server block **sobrescreve** mime.types | Usar **http block** |
| 72 | ExecReload não aceita `-g` | systemd limitation | Só `nginx -s reload` |
| 73 | Texto bichado tipo `cri­a­da` | `pdftotext -layout` insere ~166k **soft hyphens** U+00AD | `re.sub(r'[\u00AD]', '', text)` + juntar hifens ANTES de embeddings |
| 74 | Chat cita livro errado | Frontend mandava URL hardcoded `/semantic-api/` (porta 9131 genérica) | Sempre usar `/<book.id>/semantic-api/...` (inclui slug) |
| 75 | Upload `URL can't contain control characters` | Filename com acentos rejeitado pelo Storage | NFKD → ascii → `re.sub(r'[^a-zA-Z0-9._-]', '_', fn)` |
| 76 | `fastembed` ImportError | Não instalado no venv do Hermes | `pip install fastembed` |
| 77 | `multiprocessing RuntimeError` | fastembed parallel sem `if __name__ == '__main__'` | Envolver em main() + `parallel=0` |
| 78 | Livro da biblioteca abre vazio | `activeBook = CATALOG.find(...)` não cobre livros uploaded | Tentar catalog → fallback Supabase via `loadEbookBySlug(slug)` → tela de erro amigável |

---

## 📂 Estrutura de pastas

```
leitor-inteligente/
├── api/                          # Microserviços Python
│   ├── server.py                 # 9130 - hardcoded "O Poder do Hábito"
│   ├── semantic_server.py        # 9131 - genérico (bookSlug no body)
│   ├── streak_server.py          # 9132 - streak diário
│   ├── signed_url_server.py      # 9133 - signed URL Supabase Storage
│   ├── upload_book.py            # 9134 - pipeline upload completo
│   ├── fabricante_server.py      # 9135 - Fabricante de Lágrimas (específico)
│   └── book_meta.py              # Helper compartilhado - metadata + system prompts parametrizados
├── src/
│   ├── App.tsx                   # Router principal
│   ├── main.tsx                  # Entry point
│   ├── components/               # UI reutilizável
│   ├── domain/                   # Lógica de negócio
│   ├── lib/                      # Wrappers externos
│   ├── pages/                    # Páginas principais
│   ├── styles/global.css         # Tema dark mobile-first
│   └── vite-env.d.ts
├── data/                         # Cache local de indexação (NÃO versionado)
├── public/books/                 # PDFs estáticos
├── tests/                        # Vitest
└── README.md                     # Este arquivo
```

---

## 🔐 Segurança

- **RLS** ativo no Supabase: cada user só vê seus próprios livros/progresso.
- **JWT** Supabase validado nas APIs Python via decode do payload (sem round-trip).
- **Signed URLs** com TTL de 60min.
- **Service Role key** usada apenas nas APIs Python (nunca no frontend).
- **Filenames** sanitizados para ASCII puro.

---

## 📜 Licença

Proprietary — © Isaías Lima / AutomaçãoJS
