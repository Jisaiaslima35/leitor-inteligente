# SPEC Técnica — Leitor Inteligente v16 SaaS White-Label Multi-Tenant

> 23/09/2026. Acompanha o PRD. Esta é a Fase 0 — **zero código aplicado** até aprovação explícita do Isaías.

## 1. Modelagem de dados no Supabase

### 1.1 Nova tabela `public.tenants`

```sql
create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,                 -- 'devocional', 'raiz', 'academico-isa'
  name text not null,                        -- 'Rádio Devocional 12', 'Leitor Raiz'
  -- Tema/whitelabel
  theme jsonb not null default '{}'::jsonb,  -- { logo_url, primary_color, accent_color, font_family }
  -- Modo da versão (qual das três o tenant habilita)
  edition text not null default 'common'
    check (edition in ('common', 'radio_embed', 'academic_premium')),
  -- Para Embed: domínio(s) onde o iframe pode aparecer (CSP allowlist)
  embed_allowlist text[] not null default '{}',
  -- Para Embed/Acadêmico: rádio Liquidsoap deste tenant (opcional)
  radio_mount text null,                     -- '/studio-devocional', ex.
  radio_liquidsoap_host text null,           -- '127.0.0.1' (default) ou IP dedicado
  radio_liquidsoap_port int null,            -- 8001 default
  radio_liquidsoap_password text null,       -- armazenado off-band se possível (v2)
  -- Dono (Pra admin UI do próprio tenant)
  owner_user_id uuid null references auth.users(id) on delete set null,
  -- Metadados
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz null
);
create index if not exists idx_tenants_slug on public.tenants(slug);
-- RLS: leitura aberta (selects estão ok pra auth); escrita só via service_role
alter table public.tenants enable row level security;
create policy tenants_read_all on public.tenants for select using (true);
create policy tenants_no_write on public.tenants for insert with check (false);
create policy tenants_no_update on public.tenants for update using (false);
create policy tenants_no_delete on public.tenants for delete using (false);
-- Service role bypassa RLS — mesmos microserviços Python que já rodam
```

**Tenant raiz**: inserção manual via psql na primeira migration, slug=`raiz`, edition=`common`, sem `embed_allowlist`, sem `radio_mount`.

### 1.2 Adicionar `tenant_id` (com default seguro) nas tabelas existentes

Todas as migrations abaixo seguem o padrão `add column if not exists ... default 'raiz'::uuid not null; backfill; alter column drop default;` — preserva dados V1 e V15 sem disrupção.

```sql
-- Tabelas-alvo:
--   ebooks (catálogo)
--   user_library (biblioteca pessoal)
--   payments / purchases
--   quiz_scores       (single-player; v15 mantém pra histórico pessoal)
--   academic_evaluations (Sala de Aula — owner natural do tenant)
--   collab_snapshots  (texto do editor Yjs persistido)
--   highlights        (v2 futuro)
alter table public.ebooks          add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
alter table public.user_library    add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
alter table public.payments        add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
alter table public.quiz_scores     add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
alter table public.academic_evaluations add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
alter table public.collab_snapshots  add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
-- backfill para tenant raiz via subquery
update public.ebooks          set tenant_id = (select id from public.tenants where slug='raiz') where tenant_id is null;
-- (mesmo padrão pros outros 5)
-- depois dropar default
```

### 1.3 RLS policies por tenant

Estratégia: cada tabela ganha policy que checa `tenant_id` e compara com **a claim JWT `tenant_id`**. Pra V1 (sem claim), política relaxada: `tenant_id = (select id from public.tenants where slug='raiz')`. Pra usuários multi-tenant (login em mais de um), a `auth.jwt() -> 'tenants'` é um array (claims enrichment, feito via Auth Hook pós-Supabase).

```sql
-- Padrão: cada tabela fica assim
create policy ebooks_isolation on public.ebooks
  for all to authenticated
  using (tenant_id = any( coalesce(auth.jwt() -> 'tenants', jsonb_build_array(
              (select id::text from public.tenants where slug='raiz')
           ))::text[]::uuid[]) )
  with check (tenant_id = any( coalesce(auth.jwt() -> 'tenants', jsonb_build_array(
              (select id::text from public.tenants where slug='raiz')
           ))::text[]::uuid[]) );
```

**Service role key bypassa RLS** automaticamente (igual hoje). Os microserviços Python continuam usando service_role e podem ler/escrever cross-tenant (é por isso que o RAG e o quiz_save funcionam hoje).

**Auth Hook no Supabase**: custom_access_token_hook adiciona claim `tenants []uuid` baseada em `auth.users → user_tenants (tabela de associação)`. Sem isso, JWT só enxerga o tenant raiz.

### 1.4 Tabela `public.user_tenants` (ligação N:N)

```sql
create table if not exists public.user_tenants (
  user_id uuid not null references auth.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  role text not null default 'student'
    check (role in ('student', 'teacher', 'admin', 'owner')),
  joined_at timestamptz not null default now(),
  primary key (user_id, tenant_id)
);
```

Owner (gestor do tenant) ganha `role='owner'` e UI admin.

### 1.5 Backfill V1

- Insert manual do `tenant_raiz` na primeira migration (slug `raiz`).
- Backfill de todas as tabelas com `tenant_id = raiz`.
- Usuários existentes viram `user_tenants` com `role='student'` pra `raiz`.

## 2. Roteamento no frontend

### 2.1 3 estratégias (decisão em aberto na seção 5)

- **(A) Subdomínio** `leitor.radio-cliente.com` → CNAME via CF Tunnel. Mais "branded". Mais caro (cada novo tenant = rota tunnel nova).
- **(B) Path** `preview.automacaojs.us/leitor-inteligente/t/:slug/...`. Mais barato (uma rota nginx atende todos). Esconde branding.
- **(C) Query string** `?tenant=slug&mode=embed`. Mais flexível, mas frgil em SEO e em iframe cross-origin.

Recomendação base: **(B) path** como caminho canônico + **(C) query** como override opcional (embed usa sempre query pq URL fica no iframe do cliente e o cliente é quem controla).

### 2.2 Detecção no Vite/React

```ts
// novo arquivo src/lib/tenant.ts
export type TenantContext = {
  slug: string
  edition: 'common' | 'radio_embed' | 'academic_premium'
  theme: { logo_url?: string; primary_color?: string; accent_color?: string }
  embed_allowlist: string[]
  radio_mount?: string | null
}

// Path (B): extrai de /t/:slug/...
function detectTenantFromPath(): string | null {
  const m = window.location.pathname.match(/^\/leitor-inteligente\/t\/([^/]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

// Query (C): pega de ?tenant=...&mode=...
function detectTenantFromQuery(): { slug: string | null, mode: 'app' | 'embed' } { ... }

// Embed detection: postMessage handshake com parent
//  - parent envia 'collab-resize-height' quando nosso iframe carrega
//  - respondemos com altura calculada de MutationObserver
```

O `tenant` vira parte do `AuthContext` e propaga via Provider pra `Topbar`, `StorePage`, `LibraryPage`, `CheckoutModal`, `PaymentServer` (no payload), `CollabPanel` (passa pro `academic_evaluations` no quiz_save).

### 2.3 UI simplificada no embed

`mode=embed` esconde: `Topbar` menu admin/dev/upload, `AdminPage` inteira, ranking acadêmico, `MentorSkillsPanel`, **transmissão live-PTT fica só pra tenants com `radio_mount`**.

Componente `EmbedFrame.tsx` (novo): escuta `window.parent.postMessage({type:'embed-resize', height})` do site pai, ajusta altura do iframe via CSS. Mostra header do tenant (`logo_url` + `primary_color`) em vez do "Leitor Inteligente".

## 3. Segurança iframe/embed

### 3.1 CSP + X-Frame-Options — nginx

```nginx
# /etc/nginx/sites-enabled/preview (trecho NOVO para /leitor-inteligente/t/*)
location ^~ /leitor-inteligente/t/ {
  # X-Frame-Options: ALLOW-FROM é deprecado em browsers novos. Usamos CSP frame-ancestors dinâmico.
  # Como allowlist é por tenant, geramos o header numa chamada upstream (subrequest /api/nginx/csp-allow?slug=...)
  # ou — mais simples — usamos um endpoint PHP/Python que devolve header apropriado.
  # Para Fase 1: suportamos allowlist estática via map:
  map $tenant_slug $csp_frame_ancestors {
    default       "'self'";
    devocional    "radio.automacaojs.us devocional12.com.br";
    raiz          "'self' leitorinteligente.automacaojs.us";
    # expandido por tenant dinamicamente num arquivo gerado pelo admin
    ~^[a-z0-9-]+  "'self'";   # fallback genérico: bloqueia embed p/ outros
  }
  add_header Content-Security-Policy "frame-ancestors $csp_frame_ancestors" always;
  add_header X-Content-Type-Options "nosniff" always;
  # proxy_pass pro static do Leitor (que detecta via JS o slug)
  try_files $uri $uri/ /leitor-inteligente/index.html;
}
```

`map $tenant_slug` é extraído de `?tenant=` na URL. O arquivo `tenants.map.conf` (gerado pelo admin-script a partir de `public.tenants.embed_allowlist`) lista cada slug e sua allowlist. Recarregado via `nginx -s reload` (sem downtime).

### 3.2 postMessage API (cliente ↔ parent do iframe)

```ts
// HANDSHAKE: parent → iframe
{ type: 'embed-init', height: number, theme: { primary, accent } }
// RESPONSE: iframe → parent (após mount)
{ type: 'embed-resize', height: number }
// Iframe → parent (events opcionais)
{ type: 'embed-quiz-result', payload: { score: 10 } }   // V3 acadêmica
{ type: 'embed-purchase', payload: { bookId, status } }
```

Permitido só com `window.parent.origin` validar contra `embed_allowlist[tenant]`. Se o parent não bater, ignora silenciosamente.

## 4. Injeção de áudio do Professor IA na transmissão (PRIORIDADE #1)

### 4.1 Estado atual

- `voice_session.py` (tts_server pra Hermes/Dograh 9137) sintetiza fala MiniMax via 9Router.
- Áudio fica no cliente só (toBlob → `<audio src>`).
- Transmissão web rádio: PTT do usuário usa `broadcast.ts` → `lib/broadcast.ts` fan-out no `collab_server.py:2006` → stream do Liquidsoap via socket/ICY.

### 4.2 Proposta

Estende o `voice_session.py` ou cria `teacher_broadcast.py:9138` (serviço novo) que:

1. Recebe `(text, tenant_slug)` ou `(audioBlobUrl, tenant_slug)`.
2. Procura em `tenants.radio_mount` o destino.
3. Encaminha via `socat`/`ffmpeg` para `icecast://user:pass@host:port/mountpoint` daquele tenant.
4. Opcionalmente aplica ducking (atenuar música ambiente) e pré-anúncio "🌀 Resposta do Professor no ar".

```bash
# fluxo simplificado
echo "$audioBlob" | ffmpeg -f wav -i pipe:0 \
  -ac 2 -ar 44100 -b:a 128k \
  -f mp3 -content_type audio/mpeg \
  "icecast://source:$PASSWORD@$HOST:$PORT$MOUNT"
```

### 4.3 Acoplamento com `broadcast.ts`

- Atual: `dispatchPttActive(userId)` é chamado quando PTT é pressionado.
- Novo: `dispatchTeacherBroadcast(audioUrl, tenantSlug)` é chamado quando Professor IA termina de locutar.
- Mesmo fan-out no `collab_server.py` (handshake WS) — adiciona tipo `'teacher-tts'` na mensagem broadcast.

### 4.4 YouTube Live (mapeado, não priorizado)

Ver `OUTROS.md` → seção "Live streaming tools open-source". Existe o **OBS Studio + obs-websocket plugin + Custom RTMP** (não precisa de plugin de terceiro; OBS pushando já funciona), e o **StreamYard Self-Hosted** (overlay web mas pago). O caminho de menor atrito é **documentar** um botão "Transmitir pra YouTube" no painel admin que copia credenciais e abre OBS pré-configurado (template `.json`). Não bloqueia Fase 1 — só entrega no roadmap.

## 5. Decisões em aberto (preciso da aprovação do Isaías)

| # | Decisão | Opções | Recomendação | Bloqueia Fase 1? |
|---|---|---|---|---|
| 5.1 | Estratégia de roteamento | (A) subdomínio CNAME / (B) path /t/:slug / (C) query ?tenant= | **(B)+(C)**: path canônico, query pro embed | Sim |
| 5.2 | Tema/branding padrão | JSON simples vs CMS externo | **JSON** (não temos CMS, manter of现状) | Não |
| 5.3 | Auth Hook: como enriquecer JWT com `tenants[]` | Custom access token hook (Postgres function) | **Hook** (`custom_access_token_hook`) | Sim |
| 5.4 | DNS para tenants novos | Subdomínio grátis preview.automacaojs.us + path /t/ | Conforme 5.1 | Sim |
| 5.5 | Plano Free vs Pago por tenant | Um único plano free na Fase 1 | Free pra todos (vender upgrade depois) | Não |
| 5.6 | Locução professor IA injetada no ar é opt-in ou opt-out? | opt-in (default off, usuário ativa) | **opt-in** com toggle admin | Sim |
| 5.7 | Upload admin: limitar tamanho/tipo por tenant? | Hard-cap global (R$ 10 piso) já existe | Manter como está por enquanto | Não |
| 5.8 | `embed_allowlist` editável pelo owner? | Sim, via UI admin em V1.5 | Sim, com revogação imediata | Não |
| 5.9 | Plano de isolamento: quando endurecer RLS service_role? | A partir de V2 (acadêmico) | **Manter service_role bypass** até V2 | Não |
| 5.10 | Universidade dos alunos (multi-tenant em Colab) | Sala cruzando tenants? | **Bloqueado V1** (sala só dentro do tenant) | Não |

## 6. Riscos técnicos (com plano de contingência)

- **Migration na ordem errada** quebra versões antigas. Mitigação: testes com cópia do banco antes de cada migration; `if not exists` em DDL; trigger de fail-safe.
- **Service role key vaza em log** = game-over multi-tenant. Continua sendo tratado como hoje (não commit, cofre Hermes, validar via `.env` 600).
- **Embed mode = vetor de clickjacking**. Mitigação: allowlist por domínio + `frame-ancestors` (CSP nível 2 substitui `X-Frame-Options`).
- **Número de partições RAG cresce por tenant** → custo de embedding. Mitigação: cada `tenant_id + bookSlug` vira namespace separado; reusar embeddings entre tenants se o livro é o mesmo (caberá decisão V2).

## 7. Fora do escopo (não Fase 1)

- Funcionalidade nº 4 (chat estruturado) — backlog, vamos priorizar áudio Professor IA primeiro.
- Funcionalidade nº 6 (YouTube Live um clique) — só pesquisa, não implementação.
- Versão 3 Acadêmica completa (gestor vê tudo) — Fase 2 após a Fase 1 + áudio Professor IA.
- Painel de billing/Cobrança B2B — só quando tiver cliente pagante.

---

**Próximo passo**: gera artefato da arquitetura proposta via skill `archify` (este PRD/SPEC vem junto). Aguardo aprovação de qualquer um destes 10 pontos (especialmente 5.1, 5.3, 5.6) pra começar a Fase 1.
