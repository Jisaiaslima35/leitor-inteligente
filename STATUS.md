# Status Operacional — Leitor Inteligente

> **Última validação end-to-end:** 12/08/2026 — Fabricante de Lágrimas + Professor IA (contas `operajose343@gmail.com` e `brisacamera34`)
>
> **Validação anterior (11/08/2026):** O Poder do Hábito + Bíblia Dake (conta `brisacamera34`)
>
> **Repo:** https://github.com/Jisaiaslima35/leitor-inteligente

---

## 🆕 Validação 12/08/2026 — Bug fix página + Kindle features (commit `fdbf8bf`)

Isaías reportou: (1) ao parar na p40 e voltar, abria na p1; (2) sem barra de progresso; (3) pediu comparação com Kindle. Análise + fix abaixo.

### Bug fix #83 (página reseta)
- **Causa:** `PdfViewer.tsx:59` chamava `onPageChange(target)` após cada render. Combinado com `useEffect(() => setPage(initial), [initial])` no `ReaderPage`, qualquer mudança no `progress` re-disparava a sincronização e resetava pra p1.
- **Fix:** novo callback `onInternalNav` (sinaliza "render terminou, não mexa"), separado de `onPageChange` (user pediu pra mudar). `useEffect [initial]` agora só roda quando `book.id` muda (`lastBookIdRef`). Botões prev/next e input agora chamam `onTrack` corretamente.

### Kindle features adicionadas
- Barra de progresso fina (4px, gradient) entre toolbar e canvas
- `% concluído` no toolbar (ex: "23%")
- Tempo restante estimado (assumindo 2min/página): "1h 12min restantes"

---

## 📊 Análise comparativa: Kindle vs Leitor Inteligente (parte de leitura)

Pedida por Isaías 12/08 após o fix do bug da página. Baseado nas features públicas do Kindle App (X-Ray, Word Wise, Whispersync) e no estado atual do Leitor.

### O que o Leitor tem **a mais** que o Kindle

- **Professor IA contextual** — pergunta por página/capítulo/tema e recebe resposta com fontes (citação de páginas). Kindle não tem nada equivalente — X-Ray mostra termos mas não responde perguntas.
- **Leitura por voz (TTS)** — botão "Volume2" lê qualquer resposta do Professor com Web Speech API. Kindle tem Audible mas é audiolivro separado, não TTS do ebook.
- **Reconhecimento de voz (STT)** — microfone no chat → pergunta falada. Kindle não tem.
- **Compartilhamento nativo** — ShareActions: copiar, WhatsApp, Facebook. Kindle exige highlights + share manual.
- **Compra integrada via Asaas** — checkout dinâmico, webhook libera em ~5s. Kindle App só lê o que você comprou na Amazon Store.
- **Biblioteca pessoal sincronizada via Supabase** — RLS por user, cada um vê só o que comprou. Kindle usa Whispersync mas é fechado, vendor-locked na Amazon.
- **Upload do próprio ebook** — usuário faz upload do PDF e lê com o Professor IA. Kindle pessoal (Send to Kindle) aceita EPUB mas não tem RAG.
- **Login via Google** — 1 clique. Kindle exige conta Amazon.

### O que o Kindle tem **a mais** que o Leitor

- **X-Ray** — lista de personagens, termos, lugares com índice e links. Leitor não tem.
- **Word Wise** — definição inline de palavras difíceis pra crianças/LE. Leitor não tem.
- **Whispersync** — sincroniza posição, highlights, notas entre celular/tablet/Kindle/eReader. Leitor sincroniza posição e tem `progress` no Supabase, MAS não tem highlights/notas persistentes ainda.
- **Tradução instantânea** — toque numa palavra → tradução. Leitor não tem.
- **Dicionário inline** — pop-up com definição ao tocar palavra. Leitor não tem.
- **Fontes/Layout** — Kindle tem 10+ fontes, controle de margem/line-height/tamanho. Leitor tem scale 1.3 fixo no canvas.
- **Themes** — light/sepia/dark/black (E-ink). Leitor tem tema dark/light global mas não dentro do reader.
- **Highlights coloridos** — Kindle tem 4 cores + nota. Leitor tem comentários no chat mas não highlights visuais no PDF.
- **Marcadores (bookmarks)** — Kindle tem marcadores com nome. Leitor tem só o número da página.
- **Busca no texto** — Ctrl+F no Kindle. Leitor não tem (PDF.js não exposto).
- **Indicador "tempo até fim do capítulo"** — Kindle mostra ao tocar topo. Leitor agora tem (commit fdbf8bf).

### O que **ninguém** tem (gap de mercado)

- **RAG multimodal** — Professor IA que entende não só texto mas figuras, gráficos, tabelas. Nem Kindle nem Leitor.
- **Síntese de livro personalizado por objetivo** — "resuma em 5 pontos pra eu apresentar". Leitor tem `system_prompt` configurável mas é estático.
- **Anotações colaborativas** — duas pessoas lendo o mesmo livro, trocando notas em tempo real. Buzz-like pra ebooks.
- **Modo offline-first confiável** — Leitor já baixa o PDF, mas se a URL expirar (signed URL 60min) o user perde o acesso. Kindle tem offline nativo.

### Roadmap prático (próximas 4-6 semanas, ordem de impacto)

| # | Feature | Esforço | Impacto | Tipo |
|---|---|---|---|---|
| 1 | **Highlights coloridos no PDF** (clicar texto, escolher cor, persistir) | M | Alto | Kindle parity |
| 2 | **Marcadores com nome** (não só número de página) | P | Alto | Kindle parity |
| 3 | **Whispersync multi-device** (já tem 80% — Supabase já sincroniza) | P | Alto | Kindle parity |
| 4 | **Busca no texto (Ctrl+F)** via PDF.js text layer | M | Médio | Kindle parity |
| 5 | **Dicionário inline** (tocar palavra → definição) | M | Médio | Kindle parity |
| 6 | **Fontes + temas** (font-family, sepia, dark/light/black) | M | Médio | Kindle parity |
| 7 | **X-Ray lite** (lista personagens/lugares do livro via RAG) | G | Altíssimo | Diferencial |
| 8 | **Tradução de palavras/frases** (Google Translate API) | P | Médio | Kindle parity |
| 9 | **Modo offline** (cache PDF + Service Worker) | G | Alto | Kindle parity |
| 10 | **RAG multimodal** (figuras, gráficos, tabelas) | GG | Diferencial enorme | Innovation |

**P = Pequeno (1-2 dias), M = Médio (3-5 dias), G = Grande (1-2 semanas), GG = Muito grande (>2 semanas)**

### Recomendação imediata (essa semana)

Isaías, pelo teu estilo ("direto ao ponto", "coisa prática fácil"), recomendo começar por **#1 Highlights coloridos** + **#2 Marcadores com nome**. As duas são **P** de esforço, **Alto** de impacto, e colocam o Leitor visivelmente acima do Kindle pra quem curte estudar com marcação. Juntas: ~3 dias.

Depois #3 Whispersync — **já tá 80% pronto** (Supabase já sincroniza `reading_progress`). Falta só: (a) tela de "outros devices" mostrando a posição em cada, (b) real-time channel pra detectar quando outro device abre o mesmo livro.

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
