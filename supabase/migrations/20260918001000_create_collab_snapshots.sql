-- 18/09/2026 — Persistência Segura de Snapshots do Estudo em Dupla (Collab)
-- Armazena o snapshot periódico do conteúdo das salas colaborativas no Supabase

create table if not exists public.collab_snapshots (
  room_id text primary key,
  content text not null default '',
  mode text not null default 'text',
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.collab_snapshots enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'collab_snapshots' and policyname = 'collab_snapshots_all'
  ) then
    create policy "collab_snapshots_all" on public.collab_snapshots
      for all using (true) with check (true);
  end if;
end $$;
