# v6 — Streak de leitura (28/07/2026)

## O que o usuário pediu

Isaías pediu streak de leitura baseado em `reading_progress.last_read_at`. Achei um pitfall
durante implementação: `reading_progress` é UNIQUE por (user_id, ebook_id), então só guarda
a **última leitura**. Pra ter streak real (5 dias consecutivos = 5 linhas), precisava de
histórico. Criei tabela `reading_sessions` (1 row por save de progresso).

## Tabela `reading_sessions`

```sql
CREATE TABLE IF NOT EXISTS public.reading_sessions (
    id bigserial PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ebook_id uuid NOT NULL REFERENCES public.ebooks(id) ON DELETE CASCADE,
    page_number int NOT NULL,
    read_at timestamptz DEFAULT now()
);
CREATE INDEX reading_sessions_user_idx ON public.reading_sessions(user_id);
CREATE INDEX reading_sessions_user_date_idx ON public.reading_sessions(user_id, read_at);

ALTER TABLE public.reading_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "reading_sessions_own" ON public.reading_sessions
    FOR ALL USING (auth.uid() = user_id);

GRANT ALL ON public.reading_sessions TO anon, authenticated, service_role;
```

## RPC `get_reading_streak(p_user_id uuid)`

Retorna `{current_streak, best_streak, last_read_date, days_with_progress}` baseado em
datas DISTINTAS de read_at em UTC.

```sql
CREATE OR REPLACE FUNCTION public.get_reading_streak(p_user_id uuid)
RETURNS TABLE (
    current_streak int,
    best_streak int,
    last_read_date date,
    days_with_progress int
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_today date := CURRENT_DATE;
    v_dates date[];
    v_current int := 0;
    v_best int := 0;
    v_run int := 1;
BEGIN
    SELECT array_agg(d ORDER BY d DESC) INTO v_dates
    FROM (
        SELECT DISTINCT (read_at AT TIME ZONE 'UTC')::date AS d
        FROM public.reading_sessions
        WHERE user_id = p_user_id
    ) t;

    IF v_dates IS NULL OR array_length(v_dates, 1) IS NULL THEN
        current_streak := 0; best_streak := 0;
        last_read_date := NULL; days_with_progress := 0;
        RETURN NEXT; RETURN;
    END IF;

    last_read_date := v_dates[1];
    days_with_progress := array_length(v_dates, 1);

    -- current: streak "vivo" só se última leitura foi hoje ou ontem
    IF v_dates[1] = v_today OR v_dates[1] = v_today - 1 THEN
        v_current := 1;
        FOR i IN 2..array_length(v_dates, 1) LOOP
            EXIT WHEN v_dates[i] <> v_dates[i-1] - 1;
            v_current := v_current + 1;
        END LOOP;
    END IF;
    current_streak := v_current;

    -- best: maior run consecutiva na história (varre DESC)
    v_best := 1; v_run := 1;
    FOR i IN 2..array_length(v_dates, 1) LOOP
        IF v_dates[i] = v_dates[i-1] - 1 THEN
            v_run := v_run + 1;
            IF v_run > v_best THEN v_best := v_run; END IF;
        ELSE
            v_run := 1;
        END IF;
    END LOOP;
    best_streak := GREATEST(v_best, v_current);

    RETURN NEXT;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_reading_streak(uuid) TO anon, authenticated, service_role;
```

**Validação**: 5 datas consecutivas (hoje, ontem, anteontem, -3d, -4d) →
`{current_streak: 5, best_streak: 5, days_with_progress: 5}`. Quebra (-7d adicionada) →
`{current_streak: 5, best_streak: 5, days_with_progress: 6}` (best preservado). ✅

## Decisão de arquitetura (por que Opção A e não B)

Isaías pediu pra eu **decidir e justificar antes de implementar**.

**Opção A — Query em tempo real:**
- ✅ Sem estado a sincronizar; sempre bate com reading_sessions (source-of-truth)
- ✅ Sem jobs cron
- ✅ Migrar pra Opção B = adicionar 2 colunas + 1 trigger + trocar RPC (15min, front intocado)
- ❌ Cada abertura da biblioteca = 1 query SQL mais pesada (mas com índice, ~5ms)

**Opção B — Campo `current_streak` + `best_streak` em `profiles` atualizado a cada save:**
- ✅ Query trivial: `SELECT current_streak, best_streak FROM profiles WHERE id = ?`
- ✅ Escala pra 100k+ usuários
- ❌ Lógica de "se pulou 1 dia, reset" fica espalhada entre o save de progresso e (futuro) o save do cron
- ❌ Drift se save falhar (raro mas real)

**Decisão: Opção A (escolhida).** Razão: protótipo com <100 usuários, o volume de scan por
abertura é baixo (índice cobre), e migrar pra B é trivial se virar gargalo. RPC é `STABLE`
(mesmo resultado dentro da transação, Postgres pode cachear).

## Backend wrapper `api/streak_server.py` (porta 9132)

Ver `templates/streak_server.py` no skill. Service systemd:

```ini
[Unit]
Description=Leitor Inteligente - Streak API
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/root/projetos/leitor-inteligente
ExecStart=/usr/local/lib/hermes-agent/venv/bin/python3 /root/projetos/leitor-inteligente/api/streak_server.py
Restart=always
RestartSec=3
User=root
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

`ExecStart` aponta pro **venv do Hermes**, não `/usr/bin/python3` (Pitfall #44 também
aplica aqui — fastembed/starlette/etc só existem no venv).

## Frontend

`src/lib/streak.ts` — wrapper que pega `session.user.id` e faz POST JSON pra `/streak-api/streak`.

`Topbar.tsx` — `useEffect` chama `fetchStreak()` ao autenticar + a cada 60s via
`setInterval`. Mostra badge laranja (`background: linear-gradient(135deg, #ff6b35, #f7931e)`)
com ícone `Flame` (lucide-react) + número, **só se `current_streak >= 1`** (evita poluir UI
de quem tá começando).

Adaptar `supabaseStorage.ts saveRemoteProgress`: depois do upsert na `reading_progress`,
**best-effort insert** na `reading_sessions`:

```ts
await supabase.from('reading_sessions').insert({
  user_id: session.session.user.id,
  ebook_id: ebook.id,
  page_number: safePage,
})
```

Falha no insert NÃO bloqueia o save principal (best-effort). Se quiser coletar
eventos antes do save principal, use Promise.all, mas eu prefiro ordem sequencial
pra debugar fallback.

## nginx location

```nginx
location /leitor-inteligente/streak-api/ {
    proxy_pass http://127.0.0.1:9132/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_read_timeout 30s;
    add_header Cache-Control "no-store";
}
```

`proxy_read_timeout 30s` suficiente (RPC `get_reading_streak` é trivial, <100ms).

## Pitfalls novos desta rodada

51. **localStorage herdado com chaves `[bookId]` em vez de `[userId::bookId]` faz
    barra de progresso sumir** (BUG REAL 28/07/2026). Sintoma: usuário logado tem
    `reading_progress.current_page=42` no Supabase, fetch via API direto retorna certo,
    mas ReaderPage mostra página 1 + barra 0%. Causa: `getProgress(state, userId, bookId)`
    usa `state[userId+'::'+bookId]` (chave composta, ver `domain/progress.ts`), mas o
    localStorage antigo tinha `state[bookId]` (modelo pré-multi-user). Solução:
    **limpar storage na migração** (`localStorage.removeItem('leitor-ia:progress')`)
    OU mudar formato da chave pra nunca hardcodar — sempre composta desde o início.
    Fix definitivo (pendente): `loadRemoteProgress()` em `supabaseStorage.ts` deve
    usar `out[keyFor(userId, slug)] = {...}` em vez de `out[slug] = {...}` — ver
    Pitfall #52.

52. **`loadRemoteProgress()` salva com `out[slug] = {...}` mas `getProgress()` espera
    `state[userId+'::'+bookId]`** (BUG REAL 28/07/2026). Sintoma: fetch remoto OK
    (retorna 1 row com page=42), mas `state` final no React tem chave `'o-poder-do-habito'`
    em vez de `'aaa3fb43-...::o-poder-do-habito'`, então `getProgress` retorna
    `null` → fallback `?? 1` → p1 → barra 0%. **Fix**:
    ```ts
    import { keyFor } from '../domain/progress'  // não criar keyFor novo, reusar
    out[keyFor(session.session.user.id, slug)] = {
      page: row.current_page,
      totalPages: total,
      percent: Math.min(100, Math.round((row.current_page / total) * 100)),
      updatedAt: row.last_read_at,
    }
    ```
    Depois de aplicar, limpar localStorage do user existente uma vez
    (`localStorage.clear()` ou DevTools → Application → Clear storage).

## Smoke test end-to-end (28/07/2026, validado)

1. INSERT 5 sessões com `read_at` consecutivos (hoje, ontem, -2d, -3d, -4d):
   ```sql
   -- via POST /rest/v1/reading_sessions (service_role)
   ```
2. RPC `get_reading_streak(user_id)` retorna `{current: 5, best: 5}` ✅
3. INSERT 6ª sessão em -7d (quebra) → `{current: 5, best: 5}` (best preservado) ✅
4. Topbar mostra badge laranja "🔥 5" após login + 60s polling ✅

## Migração futura (Opção A → B)

Quando virar gargalo (>1000 usuários simultâneos abrindo biblioteca):
```sql
ALTER TABLE public.profiles ADD COLUMN current_streak int DEFAULT 0;
ALTER TABLE public.profiles ADD COLUMN best_streak int DEFAULT 0;

CREATE OR REPLACE FUNCTION public.update_streak_on_session()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_today date := CURRENT_DATE;
    v_yesterday date := v_today - 1;
    v_current int;
    v_best int;
BEGIN
    SELECT current_streak, best_streak INTO v_current, v_best
    FROM public.profiles WHERE id = NEW.user_id FOR UPDATE;

    IF v_current IS NULL THEN v_current := 0; END IF;
    IF v_best IS NULL THEN v_best := 0; END IF;
    -- (lógica do streak ...)
    UPDATE public.profiles SET current_streak = v_current, best_streak = v_best WHERE id = NEW.user_id;
    RETURN NEW;
END;
$$;
CREATE TRIGGER on_reading_session AFTER INSERT ON public.reading_sessions
    FOR EACH ROW EXECUTE FUNCTION public.update_streak_on_session();
```

Front continua chamando `get_reading_streak` (RPC refatorada pra fazer SELECT em `profiles`).
Zero mudança no consumidor.
