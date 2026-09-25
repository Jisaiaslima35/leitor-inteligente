# PRD — Leitor Inteligente v16 SaaS White-Label Multi-Tenant

> Isaías, 23/09/2026. Documento de aprovação **antes de qualquer código**. Esta é a Fase 0 (PRD/SPEC/diagrama). Aguardo luz verde pra Fase 1 (implementação).

## 1. Problema & oportunidade

O Leitor Inteligente hoje é um produto único com dono claro (Isaías). Toda a infraestrutura — Supabase, microserviços Python 9130-9135 + collab_server 2006 + quiz_server 3021, nginx 9121, deploy em `preview.automacaojs.us/leitor-inteligente/` — foi pensada pra um único catálogo de livros operado por uma pessoa. Isso já não cabe mais: três clientes (eu mesmo, devocional12, e em breve um colégio) querem coisas diferentes da mesma base. Forjar três produtos separados do zero triplica manutenção; reutilizar a base sem isolamento transforma o catálogo de cada cliente em problema de privacidade e de governança.

A oportunidade é virar essa base num SaaS white-label com **isolamento forte por tenant** desde a primeira fatia, e três "sabores" de produto na mesma UI:

- **Comum** (a Lojinha de hoje).
- **Web Rádio / Embed** (Rádio Devocional 12, etc — o Leitor vira um widget dentro do site do cliente, mantendo a transmissão pra web rádio que já existe).
- **Acadêmico/Premium** (gestor enxerga os alunos, "quiz" passa a se chamar "avaliação", ranking e notas viram face do gestor).

A grande alavanca é que **as três versões compartilham 90% do código**; só mudam (a) quais telas aparecem na home, (b) quem enxerga quais dados, (c) quais hooks de transmissão estão ativos.

## 2. Casos de uso por versão

### Versão 1 — Comum (já existe, vira o "tenant raiz")

Catálogo de ebooks, checkout (Mercado Pago), biblioteca pessoal, leitor no navegador, login Google, Professor IA via RAG, transmissor pro **canal geral** da Rádio Devocional/Libertação já existente. Sem isolamento — funciona como hoje.

### Versão 2 — Web Rádio / White-Label Embed

O Leitor aparece embutido dentro do site do cliente (Rádio Devocional 12 primeiro) via iframe, ativado por `?tenant=devocional12&mode=embed`. Na prática o iframe carrega `preview.automacaojs.us/leitor-inteligente/?tenant=devocional12&mode=embed` dentro de um slot no site do cliente. **UI simplifica**: na home só "Minha Biblioteca" e "Loja de Livros" — tira dev playground, painel de admin, upload, ranking, quiz acadêmico etc. Compra via Mercado Pago libera o livro automaticamente na biblioteca do **usuário dentro daquele tenant** (sem poluir a conta do usuário noutros tenants). **Mantém transmissão pra web rádio** que já existe no Leitor (o áudio PTT do usuário entra no Liquidsoap da rádio do tenant), e o envio de áudio via PTT continua como hoje.

### Versão 3 — Acadêmico/Premium

Quem controla é o **gestor** (anfitrião da sala), não o aluno. Já temos o painel colaborativo, o quiz com score, a tabela `academic_evaluations`, o pódio Top 3. Agora: gestor vê acertos/erros de cada aluno, nota visível no ranking, terminologia "quiz" vira "avaliação" (mesma mecânica de `+10/-5`, mesmo modal, só rebrandem os textos). Gestor também vê em que página cada aluno está (o awareness do `currentPage` que já roda, só renderiza na visão dele).

## 3. Escopo da Fase 1 (MVP multi-tenant)

Pra minimizar regressão, a Fase 1 entrega **só o esqueleto multi-tenant + modo embed + gestão de acervo**, e as três versões convivem já com isolamento real. É o mínimo que destrava todo o resto:

1. **Isolamento de dados** — tabela `tenants` no Supabase, coluna `tenant_id` em todas as tabelas que tocam biblioteca/livro/usuário (`ebooks`, `user_library`, `quiz_scores`, `academic_evaluations`, `collab_snapshots`, `payments`), RLS policies garantindo "tudo vê tudo do mesmo tenant e nada de outros", trigger que dá fallback automático pro tenant raiz quando a coluna é null (preserva a V1 funcionando sem quebrar).
2. **Modo Embed** — renderização simplificada (`?mode=embed` esconde navegação/sidebars), CSP/X-Frame-Options com allowlist de domínios (radio.automacaojs.us, devocional12.com etc) pra iframe seguro, postMessage API pra o site pai atualizar altura do iframe.
3. **Gestão de acervo por tenant** — UI admin enxuta: gestor adiciona/remove/edita livros do seu próprio acervo (reusa o `upload_book.py` existente, só envelopa com tenant_id), upload via admin é parte da V1 pra owners.
4. **Resolução de tenant no frontend** — 3 estratégias equivalentes: (a) subdomínio `leitor.radio-cliente.com`, (b) path `/t/radio-cliente/`, (c) query `?tenant=radio-cliente`. Decisão em aberto (seção 6 da SPEC).
5. **Roteamento de áudio PTT → web rádio do tenant** — quando o usuário fala no PTT dentro de um tenant com rádio configurada, o áudio vai pro Liquidsoap **daquele tenant** (já tem infra, falta o roteador saber pra qual `/stream` mandar).

## 4. Critérios de aceite (Fase 1)

- ✅ Criar dois tenants de teste no Supabase (ex: `tenant-raiz` e `tenant-devocional`). Cada um só enxerga os próprios livros, usuários, scores, evaluations, payments.
- ✅ Versão 1 continua funcionando pixel-equivalente a hoje (nenhum usuário V1 perdeu acesso a livro; nenhum dado anterior misturado).
- ✅ Carregar `?tenant=devocional&mode=embed` num iframe dentro de `radio.automacaojs.us` (ou via teste local) mostra só "Biblioteca" + "Loja".
- ✅ CSP/X-Frame-Options permite iframe só dos domínios da allowlist. Bloqueia tentar embedar `leitor` direto em site terceiro qualquer.
- ✅ Upload de livro como admin do `tenant-devocional` cria ebook com `tenant_id = devocional` automaticamente; aparece só na home desse tenant.
- ✅ PTT num tenant com rádio configurada injeta áudio no Liquidsoap **correto** (verificável por pacote chegando no stream respectivo).

## 5. Riscos de quebra / regressão nas funcionalidades existentes

- **RLS mal escrita = vazamento entre tenants**. Mitigação: testes de integração criando 2 tenants, populando, validando que SELECT cross-tenant sempre retorna vazio. Service role key continua bypassando RLS pros microserviços Python (já é o padrão hoje).
- **Embed pode ser alvo de clickjacking** se CSP for genérico demais. Mitigação: allowlist explícita por domínio, documentada, revisável.
- **Yjs/Monaco continua single-tenant no MVP** — salas Colab são separadas por `roomId` já; só vou garantir que scores persistidos associem ao tenant (não tem ainda, vai entrar na V2 acadêmica com migração controlada).
- **Professora IA via RAG** já é single-tenant hoje (filete por `bookSlug`); como livros passam a ter tenant, o índice RAG precisa `tenant_id + bookSlug` como chave — risco de cross-tenant search. Mitigação: filtrar `WHERE tenant_id = ?` em qualquer query do RAG no `semantic_server.py`.
- **Injeção de áudio do Professor IA na transmissão** é o #1 do PRD e não é Fase 1 — só desbloqueada na Fase 2. Sem ela, o áudio do Professor IA fica só no cliente (experiência degrada pra embed).
- **Schema migrations sem `if not exists` na coluna nova** podem rodar em ambiente que ainda não tem a tabela — uso `add column if not exists` e defaults seguros em todas as migrations.
