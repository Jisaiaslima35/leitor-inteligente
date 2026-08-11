# 📚 Leitor Inteligente

> Plataforma de leitura digital com RAG (Retrieval-Augmented Generation), Professor IA por livro, biblioteca pessoal e checkout dinâmico via Asaas.

---

## ✨ Status atual (ago/2026)

| Funcionalidade | Status |
|---|---|
| Login Google (Supabase Auth) | ✅ Funcionando |
| Catálogo de ebooks | ✅ 5 livros + 1 teste |
| Loja + Checkout dinâmico Asaas | ✅ Funcionando |
| Webhook Asaas (libera automática) | ✅ Funcionando |
| Biblioteca pessoal por usuário | ✅ Funcional |
| RAG Professor IA (O Poder do Hábito) | ✅ Funcionando |
| Google Sheets export | ✅ Funcional |
| 1 SITE entry point | ✅ (preview.automacaojs.us/leitor-inteligente) |
| Webhook callback (redirect auto) | ⚠️ Sandbox rejeita (domínio) |
| Pagamentos Cakto | ⚠️ Bloqueado pelo Cloudflare |

---

## 🛠 Stack

### Frontend
- **Vite** + **React** + **TypeScript**
- **Tailwind CSS** (utility classes via global.css)
- **Supabase** (`@supabase/supabase-js`) — auth + DB + storage
- **PDF.js** — leitor no browser
- **lucide-react** — ícones

### Backend
- **Flask** (Python 3.11+) — payment server
- **Asaas API** (`api-sandbox.asaas.com`) — gateway de pagamento
- **Supabase REST** (`/rest/v1`) — DB pra `user_library`, `purchases`, `profiles`

### Infra
- **Nginx** — serving static frontend (`/var/www/preview/leitor-inteligente/`)
- **Cloudflare Tunnel** (`pay.automacaojs.us → :3019`) — webhook URL pública

---

## 📁 Estrutura

```
leitor-inteligente/
├── src/
│   ├── App.tsx                  # Roteamento + state (Home/Loja/Biblioteca/Login)
│   ├── pages/                   # HomePage, StorePage, LibraryPage, ReaderPage, LoginPage
│   ├── components/              # CheckoutModal, BookCard, etc
│   ├── domain/                  # catalog.ts, storage.ts, library.ts, habitBook.ts
│   ├── lib/
│   │   ├── supabase.ts          # Cliente Supabase + provider
│   │   ├── supabaseStorage.ts   # addRemotePurchase, loadRemoteLibrary
│   │   └── AuthContext.tsx      # signInWithGoogle
│   └── styles/global.css
├── api/
│   ├── payment_server.py        # Flask app (porta 3019)
│   ├── book_meta.py             # Helper de metadata de livros
│   └── payments/
│       ├── base.py              # PaymentProvider abstract class
│       ├── asaas.py             # ✅ Provider ativo
│       ├── cakto.py             # ⚠️  Background (bloqueado Cloudflare)
│       └── __init__.py          # Factory: ASAAS > CAKTO
├── public/                      # Static files
├── dist/                        # Build output (gitignored)
└── .env.example                 # Veja "Setup" abaixo
```

---

## 🚀 Como rodar

### 1. Instalar deps

```bash
cd /root/projetos/leitor-inteligente
npm install
```

### 2. Configurar .env

```bash
cp .env.example .env.local
# Editar .env.local com seus valores reais
```

Ou, no VPS Isaías: edite `/root/.hermes/secrets/leitor-supabase.env` (caminho hardcoded no `api/book_meta.py`).

### 3. Supabase

Execute a migration em `supabase/migrations/` no dashboard:
```sql
-- Cria tabelas: profiles, ebooks, user_library, purchases
-- (schema versionado pelas migrations)
```

Veja [`supabase/README.md`](supabase/README.md) pra detalhes do schema.

### 4. Build + deploy

```bash
npm run build
sudo cp -r dist/* /var/www/preview/leitor-inteligente/
```

### 5. Iniciar payment server

```bash
cd /root/projetos/leitor-inteligente
python3 api/payment_server.py
```

Servidor sobe em `http://0.0.0.0:3019`. Túnel Cloudflare expõe em `https://pay.automacaojs.us`.

---

## 💳 Integração Asaas

### Endpoints

- `POST /api/checkout/create` — Cria payment com `billingType: UNDEFINED` (mostra todas opções)
- `POST /api/asaas/webhook` — Recebe `PAYMENT_RECEIVED` + `PAYMENT_CONFIRMED`
- `GET /api/payment/health` — Health check
- `POST /api/payment/simulate-flow` — Simula fluxo completo (modo dev)

### Sandbox vs Produção

| Recurso | Sandbox | Produção |
|---|---|---|
| URL API | `api-sandbox.asaas.com/v3` | `api.asaas.com/v3` |
| Callback (redirect) | ❌ Bloqueado por whitelist | ✅ Funciona (com domínio cadastrado) |
| Webhook (liberação) | ✅ Funciona | ✅ Funciona |
| Cartão de teste | `4444 4444 4444 4444` CVV `123` validade `12/30` | N/A |

### Cadastro de webhook no Asaas

```bash
curl -X POST -H "access_token: $ASAAS_API_KEY" \
  https://api-sandbox.asaas.com/v3/webhooks \
  -d '{
    "name": "Leitor Inteligente",
    "url": "https://pay.automacaojs.us/api/asaas/webhook",
    "email": "seu@email.com",
    "sendType": "SEQUENTIALLY",
    "events": ["PAYMENT_RECEIVED","PAYMENT_CONFIRMED","PAYMENT_REFUNDED","PAYMENT_OVERDUE"]
  }'
```

Salve o `authToken` retornado em `ASAAS_WEBHOOK_TOKEN` no `.env`.

### Cadastro de domínio (pra callback)

Em produção, **obrigatório**:
1. Asaas sandbox → Minha Conta → aba Informações → campo Site/Domínio
2. Cadastrar: `https://preview.automacaojs.us` (domínio raiz, sem path)
3. Aguardar ~5 min propagar

---

## 🧩 Como adicionar novo ebook

### 1. Cadastrar no Supabase

```sql
INSERT INTO ebooks (slug, title, author, description, price_cents, total_pages, is_published)
VALUES ('meu-livro', 'Meu Livro', 'Autor', 'Descrição...', 2990, 200, true);
```

### 2. Adicionar no CATALOG (`src/domain/catalog.ts`)

```typescript
{
  id: 'meu-livro',
  title: 'Meu Livro',
  author: 'Autor',
  description: 'Descrição...',
  price: 2990,
  totalPages: 200,
  cover: '',
  highlights: ['...'],
  chunks: [],  // RAG real chunks (opcional)
},
```

### 3. Build + deploy

```bash
npm run build
sudo cp -r dist/* /var/www/preview/leitor-inteligente/
```

---

## 🔐 Segurança

- **Nenhum segredo** deve ser commitado. Use `.env.local` ou `/root/.hermes/secrets/`.
- **Supabase service_role key** é SÓ pra backend (NUNCA pro frontend).
- **Asaas webhook token** valida cada request via header `asaas-access-token`.
- **Row Level Security (RLS)** ativo no Supabase: usuários só veem suas próprias compras.

---

## 📞 Contato

- Repo: https://github.com/Jisaiaslima35/leitor-inteligente
- Site em produção: https://preview.automacaojs.us/leitor-inteligente/
- Backend (túnel): https://pay.automacaojs.us
- Supabase project: `yfnzlowtgnlqizobnslh` (anon — público)
- Domínio Asaas (sandbox): `isaiassilva356@gmail.com`

---

## 📜 Licença

Projeto proprietário. Não distribua sem autorização.
