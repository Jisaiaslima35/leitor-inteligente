# Project state reference — `leitor-inteligente` 28/07/2026 (v2)

This is the live state of the project after Isaías's first iteration request ("biblioteca digital + loja + leitor + Professor IA") and the v2 fix ("Professor IA deve conhecer qualquer página, não só 10 trechos").

## Project location

```
/root/projetos/leitor-inteligente/
```

## v1 → v2 architectural shift

| Concern | v1 (10 chunks hard-coded) | v2 (RAG backend + Hermes) |
|---|---|---|
| Professor IA logic | `domain/rag.ts` (lexical scoring client-side) | Python `api/server.py` on port 9130 |
| Corpus | `domain/habitBook.ts` with 10 manual excerpts | `data/o-poder-do-habito-pages.json` with all 354 pages |
| LLM | None (template answer) | Hermes via `http://127.0.0.1:8642/v1/chat/completions` |
| API key location | N/A | Backend reads `/root/.hermes/.env` |
| Frontend call | `answerQuestion(text, chunks)` | `POST /api/ask {question, currentPage, bookId}` |
| Chapter/Página explicit | No (only lexical scoring) | **YES** — regex match for "capítulo N" / "página N" |

## File tree (v2)

```
leitor-inteligente/
├── package.json
├── vite.config.ts                 (VitePWA COM disable: true)
├── vitest.config.ts
├── tsconfig.json
├── tsconfig.app.json
├── tsconfig.node.json
├── index.html
├── README.md
├── public/
│   ├── favicon.svg
│   ├── icon-192.svg
│   ├── icon-512.svg
│   └── books/o-poder-do-habito.pdf  (3.9 MB, 354 páginas)
├── data/                                          ← NOVO v2
│   └── o-poder-do-habito-pages.json                (809 KB, 354 pages)
├── api/                                           ← NOVO v2
│   └── server.py                                  (RAG backend, port 9130)
├── src/
│   ├── main.tsx, App.tsx, vite-env.d.ts
│   ├── styles/global.css
│   ├── domain/
│   │   ├── types.ts            (Book, BookChunk, Purchase, Progress, User)
│   │   ├── library.ts          (purchaseBook, listLibrary)
│   │   ├── progress.ts         (saveProgress, getProgress + clamp)
│   │   ├── rag.ts              (AGORA SÓ TIPOS — RagSource, RagAnswer)
│   │   ├── catalog.ts          (CATALOG: 3 livros, 1 com PDF)
│   │   └── storage.ts          (wrapper localStorage tipado)
│   ├── components/
│   │   ├── Topbar.tsx
│   │   ├── BookCard.tsx
│   │   ├── CheckoutModal.tsx
│   │   └── PdfViewer.tsx       (PDF.js + worker via import.meta.env.BASE_URL)
│   └── pages/
│       ├── HomePage.tsx        (hero comercial + vitrines)
│       ├── StorePage.tsx       (3 livros + cards + CTA)
│       ├── LibraryPage.tsx     (Minha Biblioteca + cards com retomar)
│       ├── ReaderPage.tsx      (PdfViewer + chat RAG integrado na MESMA tela)
│       └── AdminPage.tsx       (KPIs + tabela catálogo + reset)
└── tests/
    ├── library.test.ts         (compra libera + idempotência)
    ├── progress.test.ts        (retomada + clamp página inválida)
    └── rag.test.ts             (tipos RAG + contract do payload)
```

## Removed in v2

- `src/domain/habitBook.ts` (10 chunks hard-coded)
- `src/pages/ProfessorPage.tsx` (chat era em página separada, agora integrado no ReaderPage)
- `domain/rag.ts` perdeu `answerQuestion` e `retrieveContext` (servidor faz)

## Backend service

**Service:** `leitor-inteligente-api.service` em `/etc/systemd/system/`

```ini
[Unit]
Description=Leitor Inteligente - Professor IA RAG
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/root/projetos/leitor-inteligente
ExecStart=/usr/bin/python3 /root/projetos/leitor-inteligente/api/server.py
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
```

**Comandos:**
```bash
systemctl is-active leitor-inteligente-api.service
journalctl -u leitor-inteligente-api.service -f
curl -sS https://preview.automacaojs.us/leitor-inteligente/api/health
```

## Build output (production)

```
dist/
├── index.html                              0.59 kB │ gzip: 0.34 kB
├── assets/pdf.worker.min-DEtVeC4l.mjs    1,255.06 kB
├── assets/index-TV09jIqG.css               8.16 kB │ gzip: 2.43 kB
├── assets/index-tFCqY2Ae.js              645.15 kB │ gzip: 197.29 kB
├── books/o-poder-do-habito.pdf             (3.9 MB)
└── icon-192.svg, icon-512.svg, favicon.svg
```

**PWA:** desabilitado (`vite-plugin-pwa` com `disable: true`) por causa do conflito SW × dynamic import.

## Test output (verde)

```
 ✓ tests/rag.test.ts (2 tests)
 ✓ tests/progress.test.ts (2 tests)
 ✓ tests/library.test.ts (2 tests)

 Test Files  3 passed (3)
      Tests  6 passed (6)
   Duration  ~2s
```

## Deploy state

**Live URL:** https://preview.automacaojs.us/leitor-inteligente/

**Verified endpoints:**
- `GET /` → 200 (HTML válido)
- `GET /books/o-poder-do-habito.pdf` → 200 (4,011,553 bytes, application/octet-stream)
- `GET /manifest.webmanifest` → 200
- `GET /assets/index-*.js` → 200 (645KB, gzipped 197KB)
- `GET /assets/pdf.worker.min-*.mjs` → 200 (1.25MB, **`Content-Type: application/javascript`** — fix nginx)
- `GET /api/health` → 200 `{"status":"ok","pages":354,"chapters":11}`
- `POST /api/ask` → 200 com `{answer: ..., sources: [...]}`

**Cache-bust URL trick para forçar refresh do iOS/Android:**
`https://preview.automacaojs.us/leitor-inteligente/?v=N` (incrementar N após rebuild).

## Catalog state

| ID | Title | Author | Price | Pages | PDF | Chunks no RAG |
|---|---|---|---|---|---|---|
| `habit-book` | O Poder do Hábito | Charles Duhigg | R$ 29,90 | 354 | ✅ | ✅ all pages |
| `focus-book` | Foco Absoluto | Daniel Goleman | R$ 39,90 | 248 | ❌ | ❌ placeholder |
| `creative-mind` | A Mente Criativa | Tom Kelley | R$ 34,90 | 196 | ❌ | ❌ placeholder |

**Preços:** ajustados pra faixa R$ 10-35 que Isaías pediu. Os outros 2 acima da faixa — ajustar antes de vender.

## API backend — endpoints

### `GET /health`

```json
{"status":"ok","pages":354,"chapters":11}
```

### `POST /ask`

**Request:**
```json
{
  "question": "O que o capítulo 5 deste livro explica?",
  "currentPage": 130,
  "bookId": "habit-book"
}
```

**Response:**
```json
{
  "answer": "O capítulo 5, \"Starbucks e o hábito do sucesso — Quando a força de vontade se torna automática\", mostra que ...",
  "sources": [
    {"id":"p130","title":"Capítulo 5 — Starbucks e o hábito do sucesso","page":130,"excerpt":"5\n\n              STARBUCKS E O HÁBITO DO SUCESSO\n..."},
    {"id":"p131","title":"Capítulo 5 — Starbucks e o hábito do sucesso","page":131,"excerpt":"de heroína e prostituição..."},
    ...
  ]
}
```

**Retrieval logic (in `api/server.py`):**
1. **Capítulo explícito** ("capítulo 5", "cap cinco"): usa a lista `CHAPTERS` hard-coded com page ranges (1-9)
2. **Página explícita** ("página 5"): retorna essa página + adjacentes
3. **Metadados** ("Charles Duhigg", "quem escreveu", "autor"): vai pra página 3 (ficha bibliográfica)
4. **Default**: scoring lexical sobre 354 páginas + boost (+0.7) da página atual do leitor

**System prompt** força:
- Responda em PT-BR, didático, fiel ao livro
- Use SOMENTE o contexto fornecido
- Se mencionar página/capítulo, responda especificamente
- Não substitua por dicas genéricas sobre deixa/rotina/recompensa
- Cite páginas PDF no fim
- Se contexto não contiver, diga claramente

## CHAPTERS list (mapeamento manual, validado)

```python
CHAPTERS = [
    (0, 'Prólogo — A cura do hábito', 6, 14),
    (1, 'O loop do hábito', 16, 41),
    (2, 'O cérebro ansioso', 42, 70),
    (3, 'A regra de ouro da mudança de hábito', 71, 101),
    (4, 'Hábitos angulares, ou a balada de Paul O'Neill', 103, 129),
    (5, 'Starbucks e o hábito do sucesso', 130, 153),
    (6, 'O poder de uma crise', 154, 178),
    (7, 'Como a Target sabe o que você quer antes que você saiba', 179, 206),
    (8, 'A Saddleback Church e o boicote aos ônibus de Montgomery', 208, 234),
    (9, 'A neurologia do livre-arbítrio', 235, 260),
    (10, 'Apêndice — Um guia para o leitor', 261, 271),
]
```

## nginx patches em `/etc/nginx/sites-enabled/preview`

```nginx
# Patch 1 — MIME types (.mjs como application/javascript)
types {
    text/html                             html htm;
    text/css                              css;
    application/javascript                js mjs;
    image/svg+xml                         svg;
    image/png                             png;
    image/jpeg                            jpg jpeg;
    image/webp                            webp;
    font/woff                             woff;
    font/woff2                            woff2;
    application/manifest+json             webmanifest;
    application/wasm                      wasm;
    application/octet-stream              pdf;
}
default_type application/octet-stream;

location ~* \.(mjs|js|css|woff2?)$ {
    add_header Cache-Control "public, max-age=3600";
    add_header X-Content-Type-Options "nosniff";
}
location ~* \.(webmanifest|png|jpg|jpeg|svg|webp)$ {
    add_header Cache-Control "public, max-age=3600";
}

# Patch 2 — proxy para RAG backend
location /leitor-inteligente/api/ {
    proxy_pass http://127.0.0.1:9130/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_read_timeout 130s;
    proxy_send_timeout 130s;
    add_header Cache-Control "no-store";
}
```

## What's NOT in v2 (gaps a fechar antes de vender)

1. **Checkout demonstrativo** — modal simula "Pagamento confirmado". Não integra Cakto/Kiwify real.
2. **Sem login** — usuário é só um ID em localStorage. Mesmo navegador = mesmo usuário, sempre.
3. **Sem backend de catálogo** — vendas e progresso somem se limpar localStorage.
4. **Sem DRM** — PDF exposto em `/books/<slug>.pdf` é baixável direto.
5. **Bundle único 645KB** — pdf.js embutido. Aceitável pra protótipo.
6. **3 livros, só 1 com PDF** — placeholder pros outros 2.
7. **Apenas livro único (O Poder do Hábito) tem RAG backend** — outros 2 livros cairiam em "no corpus" se Isaías tentar perguntar.

## Comandos úteis pós-deploy

```bash
# Rebuild + redeploy (frontend)
cd /root/projetos/leitor-inteligente
npm run build && rsync -a --delete dist/ /var/www/preview/leitor-inteligente/

# Restart backend RAG (após mudança em api/server.py)
sudo systemctl restart leitor-inteligente-api.service

# Logs do backend
sudo journalctl -u leitor-inteligente-api.service -f

# Rodar testes
npm test

# Smoke test E2E
curl -sS https://preview.automacaojs.us/leitor-inteligente/api/health
curl -sS -X POST https://preview.automacaojs.us/leitor-inteligente/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"O que é o loop do hábito?","currentPage":32,"bookId":"habit-book"}' \
  | python3 -m json.tool
```

## Lições aprendidas nesta sessão (28/07/2026)

1. **Isaías forneceu PDF com copyright** (Editora Objetiva, 2012). Confirmou autorização. Não alertar de novo.
2. **Preço inicial R$ 49,90 estava acima da faixa R$ 10–35 que ele pediu** — ajustei pra R$ 29,90 em patch único.
3. **`vercel deploy` falhou** por falta de `VERCEL_TOKEN` no `.env`. Deploy em `preview.automacaojs.us` resolveu sem fricção.
4. **Delegação via `delegate_task(background=true)` com 1 subagent leaf** rodou 9 minutos e entregou 30 arquivos + 6 testes verdes + build. Workflow eficiente — usar de novo pra projetos desse porte.
5. **Isaías perguntou "cadê tu parou foi?"** depois do kickoff — sessões longas (>5min) merecem 1 update curto no meio ("Já criei projeto, validei PDF, escrevi testes, entrando na implementação").
6. **Página-em-branco no primeiro deploy** — Vite gerou URLs absolutas (`/assets/index-XYZ.js`) ao invés de relativos (`/leitor-inteligente/assets/index-XYZ.js`). Fix: `base: '/leitor-inteligente/'` em `vite.config.ts`. SEM este fix, o PWA nunca carrega em subpath.
7. **`vite.config.js` sombra** — tinha `vite.config.js` duplicado sem `base:`, e `vite build` preferia o `.js`. Sempre verificar que só existe `vite.config.ts` após editar.
8. **Cache do PWA service worker** servia o `vite.config.js` antigo. **Fix definitivo**: `VitePWA({ disable: true })` no `vite.config.ts`. O `vite.config.js` precisa ser deletado (não só substituído).
9. **Nginx MIME type `.mjs`** — `.mjs` retornava `application/octet-stream`. Chromium recusava `import()` dinâmico. **Load `nginx-edge-mime-types-and-modular-deployment` ANTES de deployar**. 3 patches nginx necessários: `types {}`, `default_type`, e location com cache-control.
10. **pdf.js worker version mismatch** — apontei worker pra CDN com versão errada. **Sempre** `import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'` + `${import.meta.env.BASE_URL}assets/${workerUrl.split('/').pop()}`.
11. **Service Worker × dynamic import** — mesmo com MIME correto, SW servia versão cacheada. `disable: true` no VitePWA.
12. **Isaías pediu "ele deve ter conhecimento de qualquer página"** — v1 com 10 chunks falhou completamente. v2 com RAG real + Hermes resolveu. Isaías aceitou pagamento único R$29,90, autorizou protótipo com livro com copyright ("já tenho todas as autorizações").
13. **Isaías não pede teste de UI automatizado** — testes Vitest + smoke curl no terminal bastam pra ele considerar "pronto". Mas confirmou visualmente no celular que o PDF renderizou e o chat respondia.
14. **Isaías reage mal a desculpas longas** — frase explícita: "não quero que você gostar de mim, para com isso" quando tentou avisar demais sobre copyright. Modo executor silencioso, reportar o que foi feito, sem moralização.
15. **`MIME type 403` em `/favicon.svg`** — favicon foi pro nginx mas retornava 403 (não relacionado ao MIME type, era permissão). Não bloqueou app mas fez ruído no console. Considerar trocar SVG por PNG inline em data: URI se incomodar.