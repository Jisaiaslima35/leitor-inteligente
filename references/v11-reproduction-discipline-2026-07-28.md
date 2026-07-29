# Workflow: Reproduction discipline (v11) — 28/07/2026

Isaías exigiu explicitamente após 2 declarações erradas de "corrigido".

## O pedido literal

Isaías, depois de eu ter declarado um bug "corrigido" 2 vezes seguidas com base apenas em:
- Ler código e confirmar que o fix tá lá
- Rodar `curl` direto no backend e ver resposta correta
- Bundle JS minificado contém a string nova

…ele parou e exigiu:

> "Não me diga 'corrigido' de novo sem ter reproduzido você mesmo o teste completo: abrir o livro X, perguntar sobre Y, e ver a resposta certa saindo — não só confirmar no código."

## Por que essa regra existe

3 classes de bugs que "passam" em testes superficiais mas falham E2E:

1. **Cache ou SW segurando versão antiga**: bundle JS novo tá no servidor, mas o navegador do user tá com a versão antiga cacheada. Frontend envia payload errado porque roda JS antigo.
2. **Hardcoded corpus em branch de fallback** (Pitfall #61 — caso real Gálatas v10): `lexical_page_lookup` lia caminho fixo do Hábito independente do `book_slug`. Perguntas com "página N" iam pelo fallback lexical → retornavam Hábito. Perguntas sem "página N" iam pelo RAG vetorial (com book_slug correto) e funcionavam. Teste parcial parecia ok.
3. **Múltiplos code paths que precisam teste individual**.

## Recipe obrigatória antes de declarar "corrigido"

```bash
# 1. Backend smoke test (curl direto)
curl -X POST /semantic-api/semantic-ask -d '{"question":"...","bookSlug":"X"}' | jq '.sources[].page'

# 2. Bundle check (JS tem a string certa)
curl -sS /assets/index-*.js | grep "novoFieldName"

# 3. E2E no browser agent (OBRIGATÓRIO)
#    - Login com user de teste
#    - Navegar até o livro que tava com bug
#    - Fazer a pergunta exata que o user fez
#    - Confirmar que a resposta cita a fonte correta
#    - Anexar screenshot ou transcript
```

**Sem o passo 3, "corrigido" não conta.** Isaías espera ver literalmente:
- Payload exato que sai do front (`window._fetchLog` ou Network tab)
- Log do backend mostrando o que processou (`journalctl -u <service>`)
- Resposta renderizada mostrando conteúdo do livro certo

## Caso real desta sessão (28/07/2026)

| Rodada | O que eu fiz | Por que falhou |
|---|---|---|
| 1ª | Patch `BOOK_SLUG = 'o-poder-do-habito'` constant no `semantic_server.py` | Fix só no RAG vetorial, fallback lexical ainda hardcoded |
| 2ª | Patch `ReaderPage.tsx` pra mandar `bookSlug` em vez de `bookId` | Cache do navegador do user tinha bundle antigo — eu não testei E2E |
| 3ª | Isaías testou em aba anônima no Chrome, mesmo erro: "decisão de Lisa no Cairo" | Eu não tinha reproduzido no browser — só tinha feito curl direto |
| 4ª (correta) | Reproduzi E2E no browser agent (login → biblioteca → abrir Gálatas → perguntar "resumo da página 8") + adicionei logs no backend + confirmei via `journalctl` que `lexical_page_lookup` lia caminho hardcoded | Achei o bug real (Pitfall #61 da v9) |

## Helper: instrumentar fetch no front

```js
(() => {
  const origFetch = window.fetch;
  window._fetchLog = [];
  window.fetch = async function(...args) {
    const url = String(args[0] || '');
    if (url.includes('semantic-ask') || url.includes('signed-url-api') || url.includes('streak-api')) {
      window._fetchLog.push({url, method: args[1]?.method, body: args[1]?.body, time: Date.now()});
    }
    return origFetch.apply(this, args);
  };
  return 'interceptor instalado';
})()

// Depois de acionar:
JSON.stringify(window._fetchLog, null, 2)
```

## Helper: instrumentar backend Python

```python
print(f'[semantic-ask] q="{q[:60]}" page={p} bookSlug="{slug}"', flush=True)
```

`flush=True` é obrigatório — sem isso, prints ficam no buffer e só aparecem no próximo reload.

```bash
journalctl -u leitor-semantic-api.service --no-pager -n 20 --since "1 minute ago" | grep semantic-ask
```

## Quando pular a regra

Nunca. Mesmo bugs "óbvios" (1 linha trocada) podem ter outro code path escondido.

## Anti-patterns

- "Está no código" ≠ está funcionando pro user
- `curl` direto no backend ≠ mesma rota que o browser real faz
- Bundle JS tem a string ≠ o navegador do user tá usando esse bundle
- Teste parcial ok ≠ todo fluxo ok (especialmente quando há múltiplos code paths)

## Onde aplicar

Universal — não exclusivo do Leitor. Aplica pra:
- Migração de contrato API/front
- Cache de assets (Vite/webpack, service workers, CDN)
- Multi-tenant data
- Fallbacks de qualquer tipo (cache → DB, API v1 → v2, online → offline)

Regra codificada:
> "Antes de declarar 'corrigido', reproduzir E2E no browser real (não só curl) + anexar evidência."

## Relação com outros docs

- `v9-recurring-bugs-and-ux-patterns-2026-07-28.md` — lista 10 pitfalls técnicos (incluindo #61 hardcoded corpus). Workflow diferente deste doc.
- `v10-multi-book-validation-2026-07-28.md` — saga dos bugs multi-livro. Companion.

Este doc captura **workflow behavior**; os outros capturam **bugs e decisões** técnicas.
