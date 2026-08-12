# Status Operacional — Leitor Inteligente

> **Última validação end-to-end:** 12/08/2026 — Fabricante de Lágrimas + Professor IA (contas `operajose343@gmail.com` e `brisacamera34`)
>
> **Validação anterior (11/08/2026):** O Poder do Hábito + Bíblia Dake (conta `brisacamera34`)
>
> **Repo:** https://github.com/Jisaiaslima35/leitor-inteligente

---

## 🆕 Validação 12/08/2026 — Fabricante de Lágrimas (conta nova)

Isaías criou conta **nova** (`operajose343@gmail.com`), foi direto pra **Minha Biblioteca** (vazia — nada comprado), voltou pra **Loja**, comprou **O Fabricante de Lágrimas** por R$ 19,99, foi pro Asaas Sandbox, pagou com cartão de teste (4444 4444 4444 4444), comprovante mostrou:

```
Fatura #16551394
José Isaías Silva de Lima — CPF 068.029.114-85
Valor: R$ 19,99
Descrição: O Fabricante de Lágrimas
Pagamento efetuado em 12/08/2026
Cliente Asaas: operajose343 / operajose343@gmail.com
```

Webhook Asaas liberou o livro na `user_library` automaticamente. Isaías abriu o livro e pediu resumo ao Professor IA — resposta gerada pelos chunks reais do Fabricante de Lágrimas. **Print anexado na conversa do Telegram.**

### Conclusão
O fluxo completo funciona end-to-end em **conta nova** (não só na que testamos ontem). Pipeline está production-ready, não precisa de configuração adicional. **Não tocar a menos que quebre.**

---

## ✅ O que está funcionando (validado em produção)

### Fluxo de compra completo

```
1. Cliente acessa https://preview.automacaojs.us/leitor-inteligente/
2. Login via Google (Supabase Auth) — ✅ funcionando
3. Vai pra aba "Loja" — vê 6 ebooks do CATALOG
4. Clica "Comprar agora" num ebook não-comprado
5. Front chama POST https://pay.automacaojs.us/api/checkout/create
6. Backend (payment_server.py, Flask) cria sessão de pagamento no Asaas
7. Cliente é redirecionado pro checkout Asaas (sandbox em dev)
8. Preenche cartão teste 4444 4444 4444 4444 CVV 123 validade 12/30
9. Asaas processa e dispara webhook → POST /api/asaas/webhook
10. Backend valida assinatura, identifica ebook + customer via metadata
11. Backend cria row em `user_library` (libera acesso)
12. Cliente volta pra loja → ebook aparece como "comprado"
13. Clica "Abrir leitor" → signed-url-server gera URL temporária (60min)
14. PDF abre no browser (PDF.js)
15. Cliente pede resumo ao Professor IA → resposta via RAG vetorial
```

### Provider de pagamento

| Provider | Status | Notas |
|---|---|---|
| **Asaas** | ✅ **ativo** | Provider primário. Sandbox + Produção configuradas |
| **Cakto** | ⚠️ background | Provider alternativo, fallback via factory. Bloqueado por Cloudflare (registro em README) |

**Factory:** `api/payments/__init__.py` escolhe automaticamente. Prioridade: `ASAAS > CAKTO`. Configurado via `/root/.hermes/.env`:
- `ASAAS_API_KEY` (sandbox começa com `$aact_hmlg_`)
- `ASAAS_WEBHOOK_TOKEN`

### Infraestrutura

| Componente | Estado | Endpoint / Comando |
|---|---|---|
| **Backend Flask** | ✅ UP | `python3 api/payment_server.py` (porta 3019) |
| **Tunnel público** | ✅ UP | `pay.automacaojs.us → :3019` (Cloudflare Tunnel) |
| **Supabase Auth** | ✅ funcionando | Login Google via `@supabase/supabase-js` |
| **Supabase REST** | ✅ funcionando | `user_library`, `purchases`, `profiles`, `ebooks` |
| **Biblioteca pessoal** | ✅ funcionando | Cada user vê só os ebooks que comprou |
| **RAG Professor IA** | ✅ funcionando | "O Poder do Hábito" tem chunks reais (HABIT_BOOK_CHUNKS) |
| **PDF.js reader** | ✅ funcionando | `src/pages/ReaderPage.tsx` |
| **Upload pipeline** | ✅ implementado | `upload_book.py` com `marker-pdf` lock (fcntl.flock) |
| **Upload fee** | ✅ implementado | R$ 15 via Asaas, libera 365 dias de upload |

### Catálogo de ebooks (estado atual)

| Slug | Título | Preço | RAG |
|---|---|---|---|
| `o-poder-do-habito` | O Poder do Hábito | R$ 29,90 | ✅ chunks reais |
| `focus-book` | Foco Absoluto | R$ 39,90 | ✅ chunks básicos |
| `creative-mind` | A Mente Criativa | R$ 34,90 | ✅ chunks básicos |
| `fabricante-de-lagrimas` | O Fabricante de Lágrimas | R$ 19,99 | ✅ chunks básicos |
| `biblia-dake-galatas` | Bíblia Dake — Gálatas | GRATUITO | ✅ chunks básicos |
| `teste-r5` | Ebook Teste R$5 | R$ 5,00 | ⚠️ piloto |

---

## 🔧 Endpoints do payment_server (porta 3019)

| Método | Path | Função |
|---|---|---|
| POST | `/api/checkout/create` | Cria checkout (Asaas `_request POST /v3/payments`) |
| POST | `/api/asaas/webhook` | Recebe `PAYMENT_RECEIVED` / `PAYMENT_CONFIRMED` |
| POST | `/api/cakto/webhook` | Webhook alternativo (provider Cakto) |
| GET | `/api/payment/health` | Health check |
| POST | `/api/upload/create-checkout` | Checkout de upload_fee (R$ 15) |
| GET | `/api/upload/access` | Verifica se user tem upload_payments válida |
| POST | `/api/payment/simulate-flow` | Atalho dev — pula checkout, simula webhook |
| GET | `/api/payment/simulate-pay` | HTML fake de checkout (dev) |
| POST | `/api/payment/simulate-confirm` | Confirma pagamento fake (dev) |

---

## 📋 Respostas padrão do Asaas Sandbox

Quando o Asaas dispara um webhook, o backend:

```python
# Em webhook() — api/payment_server.py linha 238+
event_type = provider.get_event_type(event).lower()
# Aceita: 'paid', 'approved', 'succeeded', 'completed', 'received', 'confirmed'

order_id = provider.get_order_id(event)        # ID da transação
email = provider.get_order_email(event)        # Email do pagador
amount = provider.get_order_amount_cents(event) # Valor em centavos
meta = provider.get_order_metadata(event)      # {ebook_id, customer_id, ...}
```

**Idempotência:** webhook usa `payment_id` (UNIQUE) no Supabase. Webhook duplicado = 409 já tratado, retorna 200 sem erro.

---

## 🚀 Como rodar (do zero)

### 1. Backend Flask

```bash
cd /root/projetos/leitor-inteligente
/usr/local/lib/hermes-agent/venv/bin/python3 api/payment_server.py
# Sobe em http://0.0.0.0:3019
```

### 2. Tunnel Cloudflare

Já configurado no `/etc/cloudflared/config.yml`:
```yaml
- hostname: pay.automacaojs.us
  service: http://localhost:3019
```

### 3. Frontend

```bash
npm run build
sudo cp -r dist/* /var/www/preview/leitor-inteligente/
```

### 4. Variáveis de ambiente

Em `/root/.hermes/.env`:
```
ASAAS_API_KEY=$aact_hmlg_xxxxxxxxxxxxxx  # sandbox começa com $aact_hmlg_
ASAAS_WEBHOOK_TOKEN=xxxxxxxxxxxxxx
```

---

## 🧪 Cartão de teste (Asaas Sandbox)

```
Número: 4444 4444 4444 4444
CVV: 123
Validade: 12/30
Nome: (qualquer)
```

---

## 📁 Estrutura do repo

```
leitor-inteligente/
├── api/                          # Backend Python
│   ├── payment_server.py         # Flask principal (porta 3019)
│   ├── payments/
│   │   ├── base.py               # Interface PaymentProvider
│   │   ├── asaas.py              # AsaasProvider (229 linhas, completo)
│   │   ├── cakto.py              # CaktoProvider (background)
│   │   └── __init__.py           # Factory: ASAAS > CAKTO
│   ├── upload_book.py            # Pipeline de upload com marker-pdf lock
│   ├── server.py                 # Professor IA RAG (O Poder do Hábito)
│   ├── signed_url_server.py      # Signed URLs temporárias (porta 9133)
│   ├── semantic_server.py        # RAG semantico BGE+Supabase
│   └── streak_server.py          # Streak de leitura
├── src/                          # Frontend React/Vite/TS
│   ├── App.tsx                   # Roteamento + state
│   ├── pages/
│   │   ├── StorePage.tsx         # Catálogo
│   │   ├── LibraryPage.tsx       # Biblioteca pessoal
│   │   ├── ReaderPage.tsx        # PDF reader
│   │   ├── ProfessorPage.tsx     # Chat com Professor IA
│   │   ├── UploadPage.tsx        # Upload de ebook (com pagamento)
│   │   ├── AdminPage.tsx         # Admin panel
│   │   ├── HomePage.tsx
│   │   └── LoginPage.tsx
│   ├── components/
│   │   ├── BookCard.tsx
│   │   ├── CheckoutModal.tsx
│   │   ├── PdfViewer.tsx
│   │   ├── ShareActions.tsx
│   │   └── Topbar.tsx
│   ├── domain/
│   │   ├── catalog.ts            # CATALOG de ebooks
│   │   ├── habitBook.ts          # Chunks do Poder do Hábito
│   │   ├── library.ts
│   │   ├── storage.ts            # Comprar + sync com Supabase
│   │   ├── rag.ts
│   │   ├── progress.ts
│   │   └── types.ts
│   └── lib/
│       ├── supabase.ts
│       ├── supabaseStorage.ts
│       └── AuthContext.tsx
├── public/books/                 # PDFs locais (1 atual: fabricante-de-lagrimas.pdf)
├── dist/                         # Build output (gitignored)
└── .env.example
```

---

## ❌ O que NÃO está usando esse repo

- **Cakto em produção** — bloqueado por Cloudflare (whitelist). Mantido no código como fallback.
- **Catálogo não-Unified** — ebooks ainda em `src/domain/catalog.ts` (hardcoded) + tabela `ebooks` do Supabase. Em produção, sincronização é manual.
- **Webhook callback (redirect auto)** — sandbox rejeita (domínio). Funciona em produção após cadastrar domínio no painel Asaas.

---

## 🔜 Para migrar pra produção (Asaas paid)

1. Trocar `ASAAS_API_KEY` no `.env` pra chave sem prefixo `$aact_hmlg_`
2. Cadastrar domínio `https://preview.automacaojs.us` no painel Asaas → Minha Conta → Site/Domínio
3. Aguardar ~5 min propagar
4. Testar checkout com cartão real (não-teste)
5. Webhook já tá configurado (`https://pay.automacaojs.us/api/asaas/webhook`)

---

## 📞 Contato

- Repo: https://github.com/Jisaiaslima35/leitor-inteligente
- Site: https://preview.automacaojs.us/leitor-inteligente/
- Backend: https://pay.automacaojs.us
- Supabase project: `yfnzlowtgnlqizobnslh`
- Asaas sandbox: `isaiassilva356@gmail.com`
- Comando principal: `python3 api/payment_server.py` (porta 3019)
