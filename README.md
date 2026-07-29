# 📚 Leitor Inteligente — Skill

PWA de ebooks com Professor IA conversacional baseado em RAG vetorial.

**Origem:** knowledge bank consolidado de uma sessão de desenvolvimento
intensa (28/07/2026) onde o sistema foi construído do zero e validado em
produção com 2 livros reais (O Poder do Hábito + Bíblia Dake — Gálatas).

---

## ⚡ TL;DR

```bash
# 1. Setup VPS
apt-get install -y tesseract-ocr tesseract-ocr-por poppler-utils unpaper ghostscript
pip install ocrmypdf fastembed

# 2. Provisionar Supabase Cloud
#    - Criar projeto em https://supabase.com/dashboard
#    - Rodar SQL de SKILL.md → "Setup v1 — primeira vez"
#    - Guardar SUPABASE_URL + SUPABASE_SERVICE_ROLE em /root/.hermes/secrets/leitor-supabase.env

# 3. Frontend
cd ~/projetos/leitor-inteligente
npm install && npm test && npm run build
rsync -a --delete dist/ /var/www/preview/leitor-inteligente/

# 4. Backend services (systemd)
#    - semantic_server.py (porta 9131, RAG semântico)
#    - streak_server.py    (porta 9132, streak de leitura)
#    - signed_url_server.py(porta 9133, signed URL PDF)
#    Ver recipes em references/

# 5. Smoke test
curl https://preview.automacaojs.us/leitor-inteligente/semantic-api/health
```

---

## 📂 Estrutura do repositório

```
.
├── SKILL.md          # Sumário executivo + decision trees + pitfalls 1-61
├── README.md         # Este arquivo (quickstart)
├── references/       # Knowledge bank narrativo por versão
│   ├── supabase-cloud-integration-saga-2026-07-28.md
│   ├── v5-semantic-rag-2026-07-28.md
│   ├── v6-reading-streak-2026-07-28.md
│   ├── v7-signed-url-pdf-2026-07-28.md
│   ├── v8-ingest-pipeline-ocr-2026-07-28.md
│   ├── v9-recurring-bugs-and-ux-patterns-2026-07-28.md
│   ├── v10-multi-book-validation-2026-07-28.md
│   └── v11-reproduction-discipline-2026-07-28.md
├── scripts/          # Wrappers bash/Python reutilizáveis
│   ├── fastembed_pages.py    # Gerar embeddings BGE-small-en
│   ├── patch_embeddings.py   # PATCH loop Supabase
│   ├── ocr_pdf.sh            # OCR com tesseract PT-BR
│   └── ingest_book.sh        # Pipeline completo de novo livro
└── templates/        # Snippets copy-paste pra novos projetos
    ├── AuthContext.tsx
    ├── supabase.ts
    ├── semantic_server.py
    ├── streak_server.py
    ├── signed_url_server.py
    └── ocr_pdf.py
```

---

## 🎯 Pra que serve cada coisa

| Se você quer... | Olhe em... |
|---|---|
| Entender a arquitetura completa | `SKILL.md` → "Architecture (validated 28/07/2026)" |
| Replicar do zero (Google Studio, novo dev, etc) | `SKILL.md` → "Setup (v8)" + `references/v8-ingest-pipeline-ocr-2026-07-28.md` |
| Adicionar novo livro | `scripts/ingest_book.sh` + `SKILL.md` → "Recipe: adicionar novo livro (v8)" |
| Configurar OCR pra PDFs escaneados | `templates/ocr_pdf.py` + `references/v8-ingest-pipeline-ocr-2026-07-28.md` |
| Entender o RAG semântico | `references/v5-semantic-rag-2026-07-28.md` |
| Adicionar streak de leitura | `references/v6-reading-streak-2026-07-28.md` |
| Migrar pra signed URL (privacidade) | `references/v7-signed-url-pdf-2026-07-28.md` |
| Não cair nos bugs que caímos | `references/v9-recurring-bugs-and-ux-patterns-2026-07-28.md` + `v10-multi-book-validation-2026-07-28.md` |
| Padronizar workflow de teste (não declarar "corrigido" sem E2E) | `references/v11-reproduction-discipline-2026-07-28.md` |

---

## 🚦 Status (validado 28/07/2026)

| Feature | Status |
|---|---|
| PWA store + library + reader | ✅ |
| Login/cadastro Supabase Auth | ✅ |
| Multi-livro (validado com 2 livros) | ✅ |
| RAG semântico (BGE-small-en 384d + pgvector) | ✅ |
| OCR de PDFs escaneados (Tesseract PT-BR) | ✅ |
| PDFs via signed URL Supabase Storage | ✅ |
| Streak de leitura | ✅ |
| RAG híbrido (vetorial + fallback lexical) | ✅ |
| Retry de OCR com `ocrmypdf` | ✅ |
| Pipeline de ingestão completo | ✅ |
| Pagamento real (Cakto/Kiwify) | ⏳ demo |
| Painel admin pra cadastrar livros | ⏳ manual |
| Suporte EPUB/MOBI | ⏳ PDF only |

---

## 🧠 Padrões de workflow (do Isaías)

Documentado em `SKILL.md` → "Workflow preferences":

1. **WP-1:** Decisão arquitetural ANTES de codificar (apresentar opções + recomendação)
2. **WP-2:** Código morto — listar ANTES de deletar, esperar aprovação
3. **WP-3:** Defaults sensatos + pergunta apenas o que importa
4. **WP-4:** Confirmar ANTES em mudanças estruturais

E o **reproduction discipline workflow** (v11):
> "Não declarar 'corrigido' sem ter reproduzido você mesmo o teste completo em browser real — não só confirmar no código."

---

## 📝 Licença

MIT (knowledge bank aberto pra replicação e adaptação)