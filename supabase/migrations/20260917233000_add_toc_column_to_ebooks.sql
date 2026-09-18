-- 17/09/2026 — FASE 5: Extração de Sumário Estruturado (TOC)
-- Adiciona a coluna `toc` (JSONB) para armazenar os marcadores hierárquicos do PDF [[nivel, titulo, pagina], ...]

begin;

alter table public.ebooks
  add column if not exists toc jsonb default '[]'::jsonb;

commit;
