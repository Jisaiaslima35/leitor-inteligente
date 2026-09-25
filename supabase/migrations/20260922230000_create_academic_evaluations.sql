-- 22/09/2026 — Persistência de Avaliações Acadêmicas (Sala de Aula Interativa)
-- Armazena cada submissão de quiz dentro do contexto de uma sala colaborativa,
-- permitindo visão de turma (ranking, página atual, placar acumulado por aluno/livro).
--
-- Decisões aplicadas:
-- - total_score: integer (regra +10 acerto / -5 erro, igual a user_quiz_scores e quizScore.ts)
-- - RLS: aberta (insert + select) — sala de aula precisa ver ranking em tempo real
-- - Índices: (room_id, book_id) pra queries por turma/livro; (user_id, created_at desc) pra histórico do aluno
-- - student_name: text livre (suporta guest sem user_id)
-- - user_id: nullable (guests); FK com on delete set null

create table if not exists public.academic_evaluations (
  id uuid primary key default gen_random_uuid(),
  room_id text not null,
  book_id text not null,
  student_name text not null,
  user_id uuid null references auth.users(id) on delete set null,
  page_number int not null check (page_number > 0),
  correct_answers int not null default 0,
  wrong_answers int not null default 0,
  total_score int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists academic_evaluations_room_book_idx
  on public.academic_evaluations (room_id, book_id);

create index if not exists academic_evaluations_user_created_idx
  on public.academic_evaluations (user_id, created_at desc);

create index if not exists academic_evaluations_room_created_idx
  on public.academic_evaluations (room_id, created_at desc);

alter table public.academic_evaluations enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'academic_evaluations' and policyname = 'academic_evaluations_all'
  ) then
    create policy "academic_evaluations_all" on public.academic_evaluations
      for all using (true) with check (true);
  end if;
end $$;
