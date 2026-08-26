-- user_quiz_scores — tabela de pontuação por quiz de página
-- Cada linha = 1 quiz (3 perguntas) submetido pelo user.
-- Score: +10 por acerto, -5 por erro (calculado pelo backend antes de inserir).
-- RLS: user só vê/insere/edita os próprios scores.

create table if not exists user_quiz_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id text not null,         -- slug ou UUID do ebook (mesmo formato de purchases.ebook_id)
  page_number int not null,
  correct_answers int not null check (correct_answers >= 0 and correct_answers <= 3),
  wrong_answers int not null check (wrong_answers >= 0 and wrong_answers <= 3),
  total_score int not null,      -- soma ponderada: correct*10 + wrong*-5
  created_at timestamptz not null default now()
);

-- Índice pra somar pontos rápido por user+book (mostra "X pontos nesse livro")
create index if not exists user_quiz_scores_user_book_idx
  on user_quiz_scores (user_id, book_id, created_at desc);

-- RLS
alter table user_quiz_scores enable row level security;

-- user só lê os próprios scores
drop policy if exists "user reads own scores" on user_quiz_scores;
create policy "user reads own scores" on user_quiz_scores
  for select using (auth.uid() = user_id);

-- user só insere score próprio (a checagem real é no backend via service_role,
-- mas mantemos a policy pra defesa em profundidade caso alguém habilite insert direto)
drop policy if exists "user inserts own score" on user_quiz_scores;
create policy "user inserts own score" on user_quiz_scores
  for insert with check (auth.uid() = user_id);

-- Sem update/delete pelo user — score é imutável (audit trail)
