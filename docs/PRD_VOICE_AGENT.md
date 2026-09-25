# PRD & Technical Specification: Agente de Voz Interativo (Mentor / Professor IA)
## Plataforma Leitor Inteligente — Ecossistema Isaías Lima
**Data:** 18 de Setembro de 2026  
**Status:** Proposta de Arquitetura para Aprovação  
**Autor:** Antigravity / Ox Alpha (AI Solutions Architect & Lead Systems Engineer)  
**Destinatário:** Isaías Lima  

---

## 1. Visão Geral e Arquitetura do Sistema

### 1.1 Objetivo do Produto
Permitir que qualquer leitor ou usuário na página inicial do **Leitor Inteligente** selecione qualquer e-book do catálogo cadastrado no Supabase e converse em tempo real por voz com uma IA ultra-especializada na obra.

A experiência substitui a frieza de um chat de texto tradicional por uma conversa falada fluida, de baixa latência, ancorada com rigor ao conteúdo do livro, oferecendo duas personas dinâmicas:
1. **Modo Mentor**: Postura socrática, prática, orientadora, provocativa e focada em resultados e reflexões da vida real (para livros com perfil de mentoria/negócios/desenvolvimento).
2. **Modo Professor IA**: Postura didática, acolhedora, explicativa, contextualizadora e de suporte conceitual (modo padrão/fallback).

---

### 1.2 Topologia e Fluxo de Dados Ponta a Ponta

O sistema integra o frontend SPA/PWA do Leitor Inteligente aos componentes de infraestrutura já consolidados e ativos na VPS de Isaías:

```
+------------------------------------------------------------------------------------+
|                                    NAVEGADOR DO USUÁRIO                            |
|                                                                                    |
|   +----------------------------------------------------------------------------+   |
|   | HomePage (React 18 + Vite)                                                 |   |
|   |                                                                            |   |
|   |  [ Dropdown: Seleção de Livro ] --------> [ Card Preview: Capa + Sumário ] |   |
|   |                                                                            |   |
|   |  [ Botão Microfone / Conexão ] <========> [ Orbe de Voz / Visualizador ]   |   |
|   |            |                                                               |   |
|   +------------|---------------------------------------------------------------+   |
|                | WebRTC / Audio Stream (Bidirecional)                              |
+----------------|-------------------------------------------------------------------+
                 |
                 v
+------------------------------------------------------------------------------------+
|                             VPS INFRASTRUCTURE (Portas Locais)                     |
|                                                                                    |
|  +------------------------------------------------------------------------------+  |
|  | 1. Camada de API & Orquestração de Sessão (FastAPI / Python stdlib)          |  |
|  |    - Endpoint: POST /api/voice/session/start                                 |  |
|  |    - Busca metadados, TOC e persona no Supabase via Service Role             |  |
|  |    - Parametriza e inicializa a sessão no Dograh Engine / WebRTC             |  |
|  +------------------------------------------------------------------------------+  |
|                                        |                                           |
|                                        v                                           |
|  +------------------------------------------------------------------------------+  |
|  | 2. Motor de Voz em Tempo Real: Dograh Engine (Porta 8001 / 3015)             |  |
|  |    - Sinalização WebRTC + Audio Gateway (Opus / RTP)                         |  |
|  |    - VAD (Voice Activity Detection) para detecção de fala e interrupção      |  |
|  |    - STT Integrado (Whisper) gerando transcrição contínua                    |  |
|  +------------------------------------------------------------------------------+  |
|              |                                        ^                            |
|              | Tokens de Entrada                      | Áudio Sintetizado          |
|              v                                        | (Stream de Baixa Latência) |
|  +---------------------------+       +------------------------------------------+  |
|  | 3. Cérebro LLM:           |       | 4. Pipeline de TTS:                      |  |
|  |    9Router Local          | ----> |    Dograh TTS / MiniMax T2A v2 Proxy     |  |
|  |    (Porta 20128)          |       |    (Porta 9137 / edge-tts fallback)      |  |
|  |    MiniMax M3 (Custo R$0) |       |    Voz Mentor: Deep-VoicedGentleman      |  |
|  |    Streaming Server-Sent  |       |    Voz Professor: Thalita / shaonv       |  |
|  +---------------------------+       +------------------------------------------+  |
+------------------------------------------------------------------------------------+
                                         ^
                                         | Contexto, Chunks & Metadados
                                         v
+------------------------------------------------------------------------------------+
|                                SUPABASE (ihwkzqjliulchfdusfcp)                      |
|  - Tabela ebooks: metadados, capa_url, toc (sumário), modo_mentor_habilitado       |
|  - Tabela ebook_pages: páginas e trechos literais para fundamentação RAG            |
+------------------------------------------------------------------------------------+
```

---

### 1.3 Como o Contexto do Livro é Injetado na Sessão de Voz

O agente de voz precisa de respostas curtas, ágeis e 100% ancoradas no livro. A injeção de contexto não pode sobrecarregar o prompt inicial com centenas de páginas, sob pena de degradar a latência da primeira fala.

**Estratégia de Injeção em 3 Camadas:**
1. **Contexto Estático de Inicialização (System Prompt)**:
   - Título, autor, categoria e descrição sintética da obra.
   - Sumário Estruturado (`toc` extraído via PyMuPDF): relação de capítulos com suas respectivas páginas-chave. O agente sabe exatamente a estrutura do livro antes do usuário falar.
2. **Hook de Abertura Proativo**:
   - Assim que o canal de áudio conecta, o backend instrui o agente a falar **primeiro**, emitindo a frase do `hook_abertura` (ou gerando uma abertura contextualizada: *"Olá! Sou o Mentor de 'O Poder do Hábito'. Você já reparou como pequenas rotinas diárias controlam mais de 40% das nossas decisões? Qual hábito você quer transformar hoje?"*).
3. **Contexto Dinâmico sob Demanda (Tools / RAG Lookup)**:
   - Se o usuário perguntar *"O que o autor fala no capítulo 3 sobre o loop do hábito?"*, o motor de diálogo aciona o lookup lexical/semântico na tabela `ebook_pages` daquele `ebook_id`, recuperando os trechos exatos para fundamentar a resposta sem alucinar.

---

## 2. Especificação do Modelo de Dados (Supabase)

### 2.1 Alterações Necessárias na Tabela `public.ebooks`

A tabela existente já possui campos essenciais (`id`, `slug`, `title`, `author`, `cover_url`, `total_pages`, `categoria`, `toc`). Adicionamos 4 novas colunas dedicadas à inteligência de voz:

```sql
-- Migration: 20260918020000_add_voice_agent_columns_to_ebooks.sql
begin;

alter table public.ebooks
  add column if not exists modo_mentor_habilitado boolean default false,
  add column if not exists prompt_mentor text,
  add column if not exists hook_abertura text,
  add column if not exists voz_id text default 'Portuguese_Deep-VoicedGentleman';

comment on column public.ebooks.modo_mentor_habilitado is 
  'Se true, o agente de voz assume a persona de Mentor Socrático. Se false, atua como Professor IA.';

comment on column public.ebooks.prompt_mentor is 
  'Diretrizes comportamentais e foco temático específico deste livro no modo mentor.';

comment on column public.ebooks.hook_abertura is 
  'Primeira fala que a IA dispara ao iniciar a sessão de áudio com o usuário.';

comment on column public.ebooks.voz_id is 
  'ID da voz MiniMax ou edge-tts configurada para o livro.';

commit;
```

### 2.2 Recuperação de Dados Performática

Para alimentar o dropdown e inicializar a sessão sem overhead:
1. **Query Leve de Vitrine (Dropdown)**:
   ```ts
   // PostgREST query direto pelo client com anon key
   const url = `${SUPABASE_URL}/rest/v1/ebooks?` +
     `is_published=eq.true` +
     `&owner_user_id=eq.${ADMIN_USER_ID}` +
     `&select=id,slug,title,author,cover_url,categoria,modo_mentor_habilitado,hook_abertura,voz_id,total_pages,toc` +
     `&order=created_at.desc&limit=100`;
   ```
2. **Payload Estimado por Livro**: ~1.2 KB (mesmo com TOC resumido). 50 livros totalizam ~60 KB transferidos, carregados em menos de 100ms.
3. **Cache de Sessão**: Armazenado em memória no hook React (`useVoiceCatalog`), sincronizado com o catálogo da Home.

---

## 3. Engenharia de Prompts e Personas (PT-BR)

### 3.1 Persona 1: Modo Mentor (Socrático, Direto, Provocador)

```text
Você é o Mentor Socrático conversando por voz em tempo real sobre a obra "{{titulo}}", escrita por {{autor}}.
Você domina cada página, conceito e aplicação prática desta obra. 

SUA MISSÃO:
Você NÃO dá aulas expositivas nem lê resumos. Você desafia, orienta e desenvolve o usuário aplicando os princípios práticos do livro à realidade dele.

REGRAS DE CONVERSAÇÃO FALADA (EXTREMAMENTE RÍGIDAS):
1. RESPOSTAS CURTAS: Fale entre 2 e 4 frases por turno (máximo 40 palavras). Nunca faça monólogos. Em áudio, quem fala demais perde o interlocutor.
2. UMA PERGUNTA POR VEZ: Termine seus turnos com exatamente UMA pergunta provocadora que faça o usuário refletir ou tomar uma decisão prática.
3. NATURALIDADE ORAL: Use português brasileiro coloquial, fluído e maduro. Pode usar contrações naturais ("né", "olha só", "vamos pensar", "tipo assim"). Proibido soar robótico ou excessivamente formal. Não use saudações pomposas ("prezado leitor", "certamente").
4. DESAFIO SOCRÁTICO: Se o usuário concordar rápido demais com um conceito do livro, provoque-o a defender ou contestar: "Na teoria é lindo, mas como você aplica isso na sua rotina amanhã de manhã?".
5. ANCORAGEM: Cite termos e exemplos do livro naturalmente, sem parecer que está lendo um índice.
```

### 3.2 Persona 2: Modo Professor IA (Didático, Acolhedor, Analítico)

```text
Você é o Professor IA especialista e tutor da obra "{{titulo}}", de {{autor}}.
Você está interagindo por voz com um estudante interessado em compreender o livro.

SUA MISSÃO:
Ensinar com clareza, paciência e didática impecável, ajudando o leitor a dominar a estrutura da obra, o contexto histórico, os conceitos fundamentais e as relações entre os capítulos.

REGRAS DE CONVERSAÇÃO FALADA (EXTREMAMENTE RÍGIDAS):
1. DIDÁTICA CONCISA: Responda em até 3 frases diretas e claras. Use analogias simples do cotidiano para conceitos complexos.
2. VALIDAÇÃO DE APRENDIZADO: A cada explicação, valide o entendimento do leitor: "Fez sentido essa distinção?", "Quer que eu dê um exemplo prático?".
3. REFERÊNCIA E SUMÁRIO: Sempre que oportuno, mencione em qual capítulo ou página aquele conceito é tratado (baseado no sumário: {{toc_resumo}}).
4. TOM PROFISSIONAL E ENCORAJADOR: Seja caloroso, paciente e articulado. Incentive a leitura dos capítulos originais.
```

### 3.3 Guarda-corpos (Guardrails) de Ancoragem e Segurança

1. **Anti-Alucinação e Escopo Fechado**:
   - *"Se o usuário fizer perguntas sobre política, receitas culinárias, outros livros ou temas não abordados em '{{titulo}}', você deve responder educadamente: 'Olha, meu foco aqui é exclusivo no livro {{titulo}}. Vamos voltar para o tema central da obra: o que você achou de [conceito-chave]?'"*.
2. **Hook de Abertura Obrigatório**:
   - Na primeira resposta da chamada, a IA obrigatoriamente menciona o nome da obra e do autor, validando para o ouvinte que a sessão está sincronizada com o livro selecionado.
3. **Tratamento de Áudio Ininteligível**:
   - Se o usuário falar muito baixo ou o STT retornar ruído vazio: *"Não consegui te ouvir direito. Pode repetir ou chegar mais perto do microfone?"*.

---

## 4. Pipeline de Áudio e Latência (Voice Stack)

### 4.1 Arquitetura de Voz: WebRTC de Ultra Baixa Latência

Para garantir que a conversa tenha a cadência natural humana (resposta em menos de 800ms):

| Etapa | Componente Utilizado | Latência Estimada | Otimização Aplicada |
|---|---|---|---|
| **Captura & VAD** | WebRTC MediaStream + Silero VAD (Dograh) | ~50ms | Buffer circular de 16kHz mono; detecção de silêncio configurada para 700ms |
| **STT (Speech-to-Text)** | Whisper Streaming (Dograh Server) | ~180ms - 250ms | Transcrição parcial chunked em tempo real |
| **LLM Inference** | MiniMax M3 via 9router (`localhost:20128`) | ~120ms (Time-to-First-Token) | Streaming SSE token a token direto pro sintetizador |
| **TTS (Text-to-Speech)** | MiniMax T2A v2 Proxy (`porta 9137`) / Dograh | ~200ms | Síntese de áudio por streaming (reproduz a primeira sentença assim que o primeiro ponto final é emitido) |
| **Transporte WebRTC** | PeerConnection UDP direto (VPS ↔ Browser) | ~30ms - 50ms | Zero overhead de HTTP handshake por turno |
| **LATÊNCIA TOTAL** | **Ponta a ponta (Usuário fala -> IA responde)** | **~600ms - 850ms** | **Equivalente a uma chamada telefônica real** |

### 4.2 Tratamento Crítico de Interrupção (Barge-in)

Um agente de voz sem suporte a interrupção causa frustração imediata. O protocolo de barge-in implementado:
1. **Detecção no Cliente / Gateway**: Assim que o microfone do usuário detecta energia de voz (VAD `speech_start`) enquanto o agente estiver no estado `SPEAKING`:
   - O player de áudio do navegador imediatamente corta a saída (`audio.pause()`, `gainNode.gain.setValueAtTime(0, ctx.currentTime)`).
   - O frontend dispara evento de cancelamento para o backend via WebSocket/WebRTC DataChannel (`{ type: "barge_in", timestamp: Date.now() }`).
2. **Cancelamento no Backend**:
   - O orquestrador envia sinal de `abort` para o stream do 9router LLM e suspende o enfileiramento de chunks no TTS.
   - O agente transita instantaneamente para o estado `LISTENING`.

---

## 5. Integração com o Frontend (Leitor Inteligente)

### 5.1 Localização e Design do Componente

- **Posicionamento**: Novo bloco inserido no rodapé da `HomePage.tsx`, logo abaixo da seção *"Destaques da semana"* e acima do footer.
- **Identidade Visual**:
  - Card escuro em glassmorphism (`backdrop-filter: blur(12px)`), borda com iluminação sutil (accent gradient), alinhado ao padrão do Leitor Inteligente.
  - Badge dinâmico no topo do card:
    - Se `modo_mentor_habilitado === true`: Tag dourada/âmbar com ícone de coroa/estrela — **"MODO MENTOR ATIVO"**.
    - Se `modo_mentor_habilitado === false`: Tag azulada/índigo com ícone de chapéu acadêmico — **"MODO PROFESSOR IA"**.
  - Dropdown estilizado com avatar/capa miniatura do livro ao lado do título.
  - Painel direito/inferior com visualizador de voz dinâmico (Orbe circular pulsante com gradiente vivo que reage ao áudio).

### 5.2 Máquina de Estados da UI (State Machine)

```
       +------------+
       |   IDLE     | <---------------------+
       +------------+                       |
             |                              |
      (Clica no Botão)               (Encerra Chamada /
             v                        Erro Irrecuperável)
       +------------+                       |
       | CONNECTING |                       |
       +------------+                       |
             |                              |
    (WebRTC Conectado)                      |
             v                              |
    +-----------------+                     |
+-> |    SPEAKING     | (Hook inicial)      |
|   +-----------------+                     |
|            |                              |
|   (Fim da fala / Barge-in)                |
|            v                              |
|   +-----------------+                     |
|   |    LISTENING    |                     |
|   +-----------------+                     |
|            |                              |
|   (Usuário para de falar)                 |
|            v                              |
|   +-----------------+                     |
|   |    THINKING     | --------------------+
|   +-----------------+
+------------+
```

### 5.3 Estados de Exceção e Acessibilidade

- **Permissão de Microfone Recusada (`ERROR_PERMISSION`)**:
  - O card não quebra: exibe banner instrutivo *"Microfone bloqueado pelo navegador. Clique no cadeado da barra de endereço para autorizar o áudio"*.
- **Fallback Visual**:
  - Transcrição textual das falas exibida em legendas compactas e elegantes abaixo do orbe, permitindo acompanhar o que a IA está dizendo mesmo com volume baixo.

---

## 6. Gotchas, Riscos e Critérios de Aceite

### 6.1 Riscos e Gotchas Técnicos Mapeados

1. **Políticas de Autoplay de Áudio nos Navegadores**:
   - *Risco*: Chrome e Safari mobile bloqueiam reprodução de áudio iniciada sem gesto direto do usuário.
   - *Solução*: A inicialização da sessão e do `AudioContext` ocorre estritamente a partir do clique explícito do usuário no botão de início da sessão de voz.
2. **Consumo de Tokens e Concorrência no 9router**:
   - *Mitigação*: O 9router roda localmente (`localhost:20128`), garantindo custo zero para o modelo MiniMax M3. Para evitar enfileiramento em concorrência pesada, mantemos rate limit de 1 sessão de voz ativa simultânea por cliente.
3. **Credenciais e Segurança (Zero Leak)**:
   - Nenhuma Service Role Key ou chave privada do 9router trafega no bundle do frontend. Toda autenticação com Dograh ou Supabase administrativo é mediada pelo backend na VPS.
4. **Isolamento de Território (Regra Ox Alpha)**:
   - Arquivos e memórias residem em `/root/projetos/leitor-inteligente/` e `/root/.oxalpha/`. Nenhuma modificação será realizada em `/root/.claude/` ou `/root/.hermes/`.

---

### 6.2 Critérios de Aceite (Definition of Done — DoD)

- [ ] **Migração Supabase**: Colunas `modo_mentor_habilitado`, `prompt_mentor`, `hook_abertura` e `voz_id` adicionadas e validadas na tabela `ebooks`.
- [ ] **Carregamento Dinâmico**: O dropdown na HomePage lista todos os e-books publicados com capas renderizadas e detecta em tempo real a persona configurada (Mentor vs Professor).
- [ ] **Sessão de Voz Bidirecional**: Conexão de áudio estabelecida com sucesso através do navegador via microfone.
- [ ] **Hook Proativo**: Ao conectar, o agente de voz inicia o diálogo saudando o leitor e provocando uma reflexão baseada no livro selecionado.
- [ ] **Barge-in Funcional**: Falar por cima do agente interrompe a fala dele em menos de 300ms.
- [ ] **Ancoragem Comprovada**: O agente responde fielmente aos tópicos do livro e declina assuntos alheios ao escopo da obra.
- [ ] **UI Responsiva & Impecável**: Layout perfeitamente adaptado para desktop e mobile, com animações suaves de estados (ouvindo, pensando, falando).

---

### 7. Próximos Passos (Aguardando Aprovação de Isaías)

Após sua aprovação deste documento de especificação:
1. Executar a migration no Supabase via API/SQL.
2. Implementar o endpoint de orquestração de sessão no backend (`api/`).
3. Desenvolver o componente `src/components/VoiceMentorSection.tsx` e integrá-lo à `src/pages/HomePage.tsx`.
4. Realizar testes práticos end-to-end com "O Poder do Hábito" e outros e-books do catálogo.
