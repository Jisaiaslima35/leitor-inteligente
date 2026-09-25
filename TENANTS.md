# Arquitetura Multi-Tenant — Leitor Inteligente

Este repositório adota uma arquitetura multi-tenant unificada: um único codebase e bundle de produção atendem a múltiplos clientes, modelos de negócio e verticais através de isolamento lógico em banco e roteamento contextual.

---

## 1. Visão Geral da Arquitetura

- **Frontend Único**: React + Vite + TypeScript servido via Nginx com roteamento SPA.
- **Isolamento de Dados**: No Supabase através das tabelas `tenants`, `tenant_members`, `profiles`, `ebooks`, `academic_assessments` e `academic_submissions`.
- **Roteamento Canônico de Tenants**:
  - Rota de path: `/t/:slug` (ex: `/t/juventude-10`, `/t/devocional`)
  - Query param universal: `?tenant=:slug` (ex: `?tenant=juventude-10`)
- **Segurança de Embedding (CSP)**:
  - Nginx mapeia dinamicamente a variável `$csp_frame_ancestors` com base no slug ou domínio para autorizar iframes em portais externos.

---

## 2. Tipos de Modelos Suportados

### A. Modelo Acadêmico / Faculdades (ex: Juventude 10)
- **Finalidade**: Universidades, colégios, cursos preparatórios e salas de aula.
- **Recursos Chave**:
  - Identificação formal obrigatória do aluno (Nome Completo + Matrícula/CPF).
  - Trava pedagógica de estudo por intervalo de páginas (`Páginas X a Y`) sem dependência de sumário/capítulos.
  - Avaliações oficiais geradas por LLM restritas ao intervalo estrito de páginas (PyMuPDF).
  - Painel do Gestor (`AcademicManagerPage`) com visão consolidada de turmas, notas, taxas de domínio e exportação em CSV com UTF-8 BOM.
  - Emissão e impressão de Boletim Oficial/Comprovante de Avaliação.
- **Branch de Referência**: `template/academico-faculdade`
- **Tag Homologada**: `v1.0.0-academic-stable`

### B. Modelo Web Rádio / Devocional (ex: Devocional 12)
- **Finalidade**: Portais de conteúdo, comunidades de ouvintes, rádios web e ministérios.
- **Recursos Chave**:
  - Leitura com voz ultra-realista via TTS e agente mentor de áudio.
  - Quizzes rápidos de fixação integrados por página.
  - Embed seguro nos sites das rádios via CSP configurado no Nginx (`devocional12.automacaojs.us`, `devocional12.com.br`, `radio.automacaojs.us`).
  - Checkout e monetização de e-books via Asaas integrado.

---

## 3. Como Inicializar um Novo Cliente

### Inicialização de um Cliente Acadêmico (Ex: Juventude 10)

1. **Criar o Tenant no Banco**:
   - Via interface no Painel Admin com o modal `CreateTenantModal`, ou inserindo via SQL:
   ```sql
   INSERT INTO tenants (id, name, slug, tenant_type, is_active)
   VALUES (
     gen_random_uuid(),
     'Faculdade Juventude 10',
     'juventude-10',
     'academic',
     true
   );
   ```

2. **Atribuir o Gestor / Professor**:
   - Vincular o usuário responsável na tabela `tenant_members` com role `owner` ou `admin`.

3. **Acesso do Cliente**:
   - Acesso da instituição: `https://leitorinteligente.automacaojs.us/t/juventude-10`
   - Painel do gestor da instituição: `https://leitorinteligente.automacaojs.us/t/juventude-10#/academic/manager`

---

### Inicialização de um Cliente de Web Rádio (Ex: Devocional 12)

1. **Registrar o Tenant**:
   ```sql
   INSERT INTO tenants (id, name, slug, tenant_type, is_active)
   VALUES (
     gen_random_uuid(),
     'Rádio Devocional 12',
     'devocional',
     'default',
     true
   );
   ```

2. **Permissão de Embed no Nginx (`/etc/nginx/preview-only.conf`)**:
   - No mapa `$csp_frame_ancestors`, adicionar os domínios autorizados para o slug:
   ```nginx
   ~[?&]tenant=devocional  "'self' radio.automacaojs.us devocional12.com.br www.devocional12.com.br";
   ~^/t/devocional          "'self' radio.automacaojs.us devocional12.com.br www.devocional12.com.br";
   ```
   - Executar `nginx -c /etc/nginx/preview-only.conf -t && systemctl reload nginx`.

3. **URL para Embed ou Acesso Direto**:
   - `https://leitorinteligente.automacaojs.us/t/devocional`
   - No iframe do site da rádio: `<iframe src="https://leitorinteligente.automacaojs.us/t/devocional?book=livro-slug"></iframe>`

---

## 4. Esteira de Deploy e Assets

- **Compilação**: `npm run build`
- **Deploy Atômico**: `./deploy.sh`
  - Sincroniza os bundles com `/var/www/preview/leitor-inteligente/`.
  - Garante os módulos estáticos do PDF.js (OpenJPEG `.wasm` e worker `.mjs`) em `/assets/pdfjs/` e `/pdfjs/`.
  - Cria os links simbólicos necessários para entrega com zero downtime.
