-- Migration: 20260923040000_assign_owner_and_library_isolation.sql
-- Descrição: Formaliza geminijose356@gmail.com como Dono/Super Admin do tenant radio-devocional-12
-- e garante isolamento estrito de biblioteca e permissões de transmissão.
-- Data: 23/09/2026

-- 1. Atribuição de owner no tenant radio-devocional-12
UPDATE public.tenants
SET owner_user_id = 'ebf849b8-f2f8-4d70-b27b-6a08ce093a09',
    updated_at = now()
WHERE slug = 'radio-devocional-12';

-- 2. Atribuição de role 'owner' na tabela user_tenants para o gestor oficial
INSERT INTO public.user_tenants (user_id, tenant_id, role)
SELECT 
  'ebf849b8-f2f8-4d70-b27b-6a08ce093a09'::uuid,
  id,
  'owner'
FROM public.tenants
WHERE slug = 'radio-devocional-12'
ON CONFLICT (user_id, tenant_id) 
DO UPDATE SET role = 'owner';

-- 3. Rebaixa dummy antigo para student caso exista
UPDATE public.user_tenants
SET role = 'student'
WHERE user_id = '4c347fb6-e66e-4993-b69e-93e966ef8455'
  AND tenant_id = (SELECT id FROM public.tenants WHERE slug = 'radio-devocional-12');
