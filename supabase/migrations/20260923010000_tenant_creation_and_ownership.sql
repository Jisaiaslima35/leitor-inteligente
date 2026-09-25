-- Migration: 20260923010000_tenant_creation_and_ownership.sql
-- Descrição: FASE 1 - Passo 3: Políticas RLS e RPC atômica para criação de tenants por parceiros/gestores
-- Data: 23/09/2026

-- 1. Políticas RLS para tenants
DROP POLICY IF EXISTS "tenants_insert_authenticated" ON public.tenants;
CREATE POLICY "tenants_insert_authenticated" ON public.tenants
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = owner_user_id);

DROP POLICY IF EXISTS "tenants_update_owner" ON public.tenants;
CREATE POLICY "tenants_update_owner" ON public.tenants
  FOR UPDATE TO authenticated
  USING (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

-- 2. Políticas RLS para user_tenants
DROP POLICY IF EXISTS "user_tenants_insert_owner" ON public.user_tenants;
CREATE POLICY "user_tenants_insert_owner" ON public.user_tenants
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_tenants_update_owner" ON public.user_tenants;
CREATE POLICY "user_tenants_update_owner" ON public.user_tenants
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 3. Função RPC atômica: create_tenant_with_owner
CREATE OR REPLACE FUNCTION public.create_tenant_with_owner(
  p_name text,
  p_slug text,
  p_edition text,
  p_domain text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id uuid;
  v_clean_slug text;
  v_allowlist text[];
  v_tenant record;
  v_edition text;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Apenas usuários autenticados podem criar instituições.';
  END IF;

  v_clean_slug := lower(regexp_replace(trim(p_slug), '[^a-z0-9-]', '', 'g'));
  IF length(v_clean_slug) < 3 THEN
    RAISE EXCEPTION 'O identificador (slug) deve conter pelo menos 3 caracteres alfanuméricos.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.tenants WHERE slug = v_clean_slug) THEN
    RAISE EXCEPTION 'O identificador "%" já está em uso por outra instituição.', v_clean_slug;
  END IF;

  v_edition := CASE
    WHEN p_edition IN ('common', 'radio_embed', 'academic_premium') THEN p_edition
    ELSE 'radio_embed'
  END;

  v_allowlist := ARRAY['self', 'leitorinteligente.automacaojs.us'];
  IF p_domain IS NOT NULL AND trim(p_domain) <> '' THEN
    v_allowlist := array_append(v_allowlist, lower(regexp_replace(regexp_replace(trim(p_domain), '^https?://', ''), '/.*$', '')));
  END IF;

  INSERT INTO public.tenants (
    name,
    slug,
    edition,
    embed_allowlist,
    theme,
    owner_user_id
  ) VALUES (
    trim(p_name),
    v_clean_slug,
    v_edition,
    v_allowlist,
    jsonb_build_object('brand_name', trim(p_name)),
    v_user_id
  )
  RETURNING * INTO v_tenant;

  INSERT INTO public.user_tenants (
    user_id,
    tenant_id,
    role
  ) VALUES (
    v_user_id,
    v_tenant.id,
    'owner'
  )
  ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = 'owner';

  RETURN to_jsonb(v_tenant);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_tenant_with_owner(text, text, text, text) TO authenticated;
