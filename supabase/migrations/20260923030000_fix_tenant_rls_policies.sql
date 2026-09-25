-- Migration: 20260923030000_fix_tenant_rls_policies.sql
-- Descrição: Ajusta current_tenant_ids() para ler de user_tenants e profiles.current_tenant_id,
-- e ajusta policies RLS de ebooks e user_library para permitir acesso correto aos livros do tenant.
-- Data: 23/09/2026

-- 1. Atualiza current_tenant_ids() para buscar dos tenants do usuário em user_tenants e profiles
CREATE OR REPLACE FUNCTION public.current_tenant_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH jwt_tenants AS (
    SELECT t::uuid AS tid
    FROM jsonb_array_elements_text(
      CASE 
        WHEN jsonb_typeof(auth.jwt() -> 'tenants') = 'array' THEN auth.jwt() -> 'tenants'
        WHEN auth.jwt() ->> 'tenant_id' IS NOT NULL THEN jsonb_build_array(auth.jwt() ->> 'tenant_id')
        ELSE '[]'::jsonb
      END
    ) AS t
  ),
  db_tenants AS (
    SELECT tenant_id AS tid
    FROM public.user_tenants
    WHERE user_id = auth.uid()
    UNION
    SELECT current_tenant_id AS tid
    FROM public.profiles
    WHERE id = auth.uid() AND current_tenant_id IS NOT NULL
  ),
  all_tenants AS (
    SELECT tid FROM jwt_tenants
    UNION
    SELECT tid FROM db_tenants
  )
  SELECT COALESCE(
    (SELECT array_agg(DISTINCT tid) FROM all_tenants WHERE tid IS NOT NULL),
    ARRAY[(SELECT id FROM public.tenants WHERE slug = 'raiz')]
  );
$$;

-- 2. Atualiza policy de ebooks para permitir leitura do tenant ativo, do dono, de quem tem o livro na biblioteca, ou raiz
DROP POLICY IF EXISTS "ebooks_tenant_read" ON public.ebooks;
CREATE POLICY "ebooks_tenant_read" ON public.ebooks FOR SELECT USING (
  tenant_id = ANY(public.current_tenant_ids())
  OR owner_user_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.user_library ul
    WHERE ul.ebook_id = public.ebooks.id AND ul.user_id = auth.uid()
  )
  OR tenant_id = (SELECT id FROM public.tenants WHERE slug = 'raiz')
);

-- 3. Atualiza policy de user_library para que o usuário acesse tudo que lhe pertence
DROP POLICY IF EXISTS "user_library_tenant" ON public.user_library;
DROP POLICY IF EXISTS "user_library_own" ON public.user_library;
CREATE POLICY "user_library_own" ON public.user_library FOR ALL USING (
  auth.uid() = user_id
) WITH CHECK (
  auth.uid() = user_id
);
