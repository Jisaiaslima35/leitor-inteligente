# Recurring bugs and UX patterns — sessão 28/07/2026

Knowledge bank de bugs que apareceram repetidamente nesta sessão, com a
lição durável. Cada bug já foi corrigido mas o padrão volta — vale ter
este doc como referência pra próximas sessões que mexerem no Leitor.

## 1. `'demo-user'` hardcoded é o anti-pattern mais comum

**Apareceu 3 vezes** num único turno (Isaías → "barra não tá funcionando"):

| Arquivo | Linha | Sintoma | Fix |
|---|---|---|---|
| `src/pages/ReaderPage.tsx` | 52 | Spinbutton voltava pra 1 em vez de abrir na página salva | `getProgress(progress, userId, book.id)` com `userId = useAuth().user.id` |
| `src/pages/LibraryPage.tsx` | 17 | Biblioteca sempre vazia mesmo com compra no DB | `ownsBook(library, userId, book.id)` com userId dinâmico |
| `src/domain/storage.ts` | 64, 78 | Compra/progresso gravado com user errado | `currentUserId()` async helper que lê do Supabase session |

**Lição durável:** qualquer string literal `'demo-user'` ou uso de
`DEFAULT_USER.id` em código pós-migração Supabase é **red flag**. Antes
de commitar, rodar:

```bash
grep -rn "demo-user\|DEFAULT_USER" src/
```

Deve retornar **zero matches** (exceto em arquivos de tipos como
`src/domain/types.ts` que define o `DEFAULT_USER` constante).

**Helper pattern** (já em `storage.ts`):

```ts
async function currentUserId(): Promise<string> {
  if (SUPABASE_READY) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.user) return data.session.user.id
  }
  return DEFAULT_USER.id  // fallback demo
}
```

## 2. `ProgressState` usa chave composta — sempre

`saveProgress`/`getProgress` em `src/domain/progress.ts` usam:

```ts
function keyFor(userId: string, bookId: string): string {
  return `${userId}::${bookId}`
}
```

**Incompatibilidade local/remote** foi o bug que motivou a barra sempre
mostrar 0% mesmo com `reading_progress` correto no Supabase. O `loadRemoteProgress()`
tava gravando `out[slug] = {...}` em vez de `out[keyFor(userId, slug)] = {...}`.

**Lição:** ao popular `ProgressState` a partir do Supabase, SEMPRE usar
`keyFor`. Ao popular de localStorage, o state antigo (chave simples)
fica órfão — vale limpar `localStorage.removeItem('leitor-ia:progress')`
na migração inicial.

## 3. URL truncada do terminal é fonte clássica de bug

Sintoma típico:

```bash
$ print(some_long_signed_url)
https://...supabase.co/object/sign/...?token=eyJraW...UrDQ
$ # ← display cortou no meio do JWT
```

Se você copiar isso e colar em código → `InvalidJWT: signature verification failed`.

**REGRA: antes de patchar signed URL/JWT no código:**

```bash
# 1. Sempre escrever num arquivo via Python primeiro
python3 -c "
import subprocess
r = subprocess.run(['curl', '-sS', '-X', 'POST', 'https://.../sign', ...], capture_output=True, text=True)
data = json.loads(r.stdout)
with open('/tmp/url.txt', 'w') as f: f.write(data['url'])
"
# 2. Ler de volta em chunks pra confirmar comprimento completo
for i in range(0, $(wc -c < /tmp/url.txt), 60); do
  echo "[$i] $(cut -c${i}-$((i+60)) /tmp/url.txt)"
done
# 3. Validar via curl antes de patchar
curl -sS -o /dev/null -w "HTTP=%{http_code}\n" "$(cat /tmp/url.txt)"
# 4. SÓ ENTÃO patchar no código
```

## 4. Spinner + syncDone é o padrão pra carregar dados async

O front passou por **3 rodadas de bug** porque o `useEffect` de sync
disparava mas o resultado era ignorado ou chegava tarde demais. Padrão
que funciona (já em `App.tsx`):

```tsx
const [syncDone, setSyncDone] = useState(false)

useEffect(() => {
  if (!isReady) return
  if (!isAuthenticated) { /* load local */ ; setSyncDone(true); return }
  if (lastSyncedUser.current === user.id) return
  lastSyncedUser.current = user.id
  setSyncDone(false)  // mostra spinner
  Promise.all([fetchRemoteLibrary(), fetchRemoteProgress()]).then(([lib, prog]) => {
    setLibrary(lib ?? loadLibrary())
    setProgress(prog ?? loadProgress())
    setSyncDone(true)
  })
}, [isReady, isAuthenticated, user.id])

// No JSX:
{showSyncLoading && <div className="spinner">Carregando...</div>}
{!showSyncLoading && <>{/* rotas normais */}</>}
```

**Lição:** state inicial começa vazio (`{}` em vez de `loadProgress()`).
Sync popula DEPOIS. UI só renderiza depois de `syncDone=true`. Sem isso,
você sempre vê "vazio" por race condition.

## 5. Auth login + onSuccess + navegação

Login funcionou mas o front ficou na página de login sem redirecionar.
**Causa**: o `onAuthStateChange` não disparou consistentemente após
`signInWithPassword` em alguns browsers.

**Fix** (em `AuthContext.tsx`): chamar `supabase.auth.getSession()`
explicitamente depois do login pra forçar refresh:

```ts
signInWithPassword: async (email, password) => {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) return { ok: false, error: error.message }
  // Fallback: força refresh (onAuthStateChange pode falhar)
  const { data } = await supabase.auth.getSession()
  if (data.session) {
    setSession(data.session)
    setSupabaseUser(data.session.user)
  }
  return { ok: true }
}
```

E `LoginPage.tsx` precisa de `useEffect` que detecta mudança em
`isAuthenticated` e chama callback:

```tsx
useEffect(() => {
  if (isAuthenticated && onSuccess) onSuccess()
}, [isAuthenticated, onSuccess])
```

## 6. Pattern de "pergunta arquitetural ANTES de codificar"

Isaías pediu **3 vezes nesta sessão** decisões de arquitetura antes de
implementar. Resposta padrão correta:

1. **Apresenta 2-3 opções** com prós/contras resumidos
2. **Recomenda com justificativa** (qual você escolheria + por quê)
3. **Implica migração futura** (se a escolha atual é OK pra 100 users
   mas precisa mudar em 1000, diz isso explicitamente)
4. **Defaults sensatos** se ele não responder

Errar pra LADO de fazer mais (processar embeddings, inserir compra pro
user teste, deploy automático) é OK. Errar pra LADO de fazer menos é
irritante — Isaías prefere "fiz mais coisa, se não quiser desfaz" do
que "perdi 30min explicando, agora faça".

## 7. OCR pipeline (pitfall #54 do SKILL.md) — checklist antes de deploy

Toda vez que for adicionar livro novo, validar ANTES:

```bash
for cmd in tesseract pdftoppm unpaper ocrmypdf pdftotext; do
  command -v $cmd >/dev/null && echo "✓ $cmd" || echo "✗ $cmd MISSING"
done
tesseract --list-langs 2>&1 | grep por  # tem PT-BR?
```

Sem `unpaper` → `ocrmypdf` falha com mensagem clara ("The program
'unpaper' could not be executed").

## 8. RLS + service_role — sempre separar

Pra popular dados de teste (compras fake, leituras fake), sempre usar
**service_role** key em `Authorization: Bearer`. A **anon** key retorna
**42501** "row violates row-level security" pra qualquer INSERT em
tabela com RLS.

```bash
# Errado (vai falhar com 42501 se a tabela tem RLS):
curl -X POST "$URL/rest/v1/ebooks" -H "apikey: $ANON" ...

# Certo (bypass RLS pra uso admin):
curl -X POST "$URL/rest/v1/ebooks" -H "apikey: $SERVICE_ROLE" ...
```

Service_role tá em `/root/.hermes/secrets/leitor-supabase.env` (campo
`SUPABASE_SERVICE_ROLE`). ANON tá no mesmo arquivo
(`SUPABASE_ANON_KEY`).

## Resumo das lições duráveis

1. **Nunca hardcode `'demo-user'`** — sempre `useAuth().user.id`
2. **`ProgressState` é multi-usuário** — chave composta obrigatória
3. **URL truncada = URL quebrada** — sempre validar via curl antes de patchar
4. **State inicial vazio + spinner + syncDone** é o padrão pra carregar async
5. **Login precisa fallback explícito** (getSession depois de signIn)
6. **Decisão arquitetural primeiro, código depois** — Isaías prefere
7. **OCR pipeline tem pré-requisitos** — apt + pip + tesseract lang pack
8. **service_role vs anon key** — pra testes/admins, sempre service_role
9. **Back + front em conjunto** — quando adicionar/modificar contrato de API (campo, header, payload), SEMPRE tocar back + front no mesmo round. Esquecer o front = bug silencioso: backend retorna 200 com fallback/default, front não sabe. Caso real 28/07/2026: `bookSlug` adicionado no `semantic_server.py`, mas `ReaderPage.tsx` continuou mandando `bookId` — Professor IA sempre respondia sobre Hábito mesmo com livro do Gálatas aberto. Valide SEMPRE end-to-end (browser real, não só curl direto) após mudanças de contrato.
10. **Hardcoded corpus em fallback lexical** — quando o backend tem fallback pra "página N explícita" lendo JSON local, ele DEVE receber `book_slug` igual ao retrieval vetorial. Esquecer = sempre retorna conteúdo do primeiro livro configurado, independente do livro aberto. Caso real 28/07/2026: `lexical_page_lookup(page_num, k=3)` em `semantic_server.py` lia `/root/projetos/leitor-inteligente/data/o-poder-do-habito-pages.json` hardcoded — pergunta "resumo da página 8" no Gálatas retornava Lisa no Cairo (Hábito). Perguntas SEM "página N" usavam RAG vetorial e funcionavam (porque o match_ebook_slug estava certo), o que mascarava o bug. **REGRA**: TODA função que busca conteúdo de livro recebe `book_slug` como parâmetro. Mapeamento slug → arquivo via dicionário `LEXICAL_PATHS = {slug: path}` em vez de hardcoded. Valide com pelo menos 2 livros diferentes E com perguntas COM e SEM "página N" pra pegar ambos os code paths.
