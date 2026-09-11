-- 11/09/2026 — campanhas temáticas (/tema/<slug>)
-- Adiciona 3 valores à CHECK constraint da coluna ebooks.categoria:
--   - batalha-espiritual
--   - casamento-familia
--   - infantil
-- O CHECK anterior cobria 7 valores (comum + 6 oficiais P8). Sobe pra 10.
--
-- Idempotente: dropa constraint se existir, recria com a lista atualizada.
-- Aplica só em public.ebooks (tabela oficial de ebooks cadastrados).

begin;

-- 1. Remover CHECK antiga (qualquer nome que tenha sido usado).
alter table public.ebooks drop constraint if exists ebooks_categoria_check;
alter table public.ebooks drop constraint if exists ebooks_categoria_chk;

-- 2. Recriar com 10 valores.
alter table public.ebooks
  add constraint ebooks_categoria_check
  check (categoria in (
    'comum',
    'programacao',
    'tecnologia',
    'gospel',
    'literatura',
    'autoajuda',
    'outros',
    'batalha-espiritual',
    'casamento-familia',
    'infantil'
  ));

-- 3. Adicionar coluna description se não existir (usada na vitrine da campanha).
--    O Admin/Upload vai poder preencher opcionalmente.
alter table public.ebooks
  add column if not exists description text;

commit;
