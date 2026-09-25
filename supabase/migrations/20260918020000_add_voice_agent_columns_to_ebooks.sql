-- 18/09/2026 — Agente de Voz Interativo (Modo Mentor / Professor IA)
-- Adiciona colunas para controle da persona de voz e mentoria

begin;

alter table public.ebooks
  add column if not exists modo_mentor_habilitado boolean default false,
  add column if not exists prompt_mentor text,
  add column if not exists hook_abertura text,
  add column if not exists voz_id text default 'Portuguese_Deep-VoicedGentleman';

commit;
