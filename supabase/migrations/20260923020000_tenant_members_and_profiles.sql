-- Migration: 20260923020000_tenant_members_and_profiles.sql
-- Descrição: Suporte a membros de tenant, view tenant_members, current_tenant_id em profiles e RPC register_tenant_member
-- Data: 23/09/2026

-- 1. Coluna current_tenant_id em profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS current_tenant_id uuid REFERENCES public.tenants(id) ON DELETE SET NULL;

-- 2. View tenant_members espelhando user_tenants para consultas canônicas
CREATE OR REPLACE VIEW public.tenant_members AS
SELECT 
  user_id,
  tenant_id,
  role,
  joined_at AS created_at
FROM public.user_tenants;

-- 3. RLS para user_tenants
ALTER TABLE public.user_tenants ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_tenants' AND policyname = 'user_tenants_select_all'
  ) THEN
    CREATE POLICY user_tenants_select_all ON public.user_tenants FOR SELECT TO public USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_tenants' AND policyname = 'user_tenants_insert_self'
  ) THEN
    CREATE POLICY user_tenants_insert_self ON public.user_tenants FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- 4. Função segura RPC para vincular membro ao tenant atual
CREATE OR REPLACE FUNCTION public.register_tenant_member(p_tenant_id uuid, p_role text DEFAULT 'student')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_uid uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Não autenticado');
  END IF;

  INSERT INTO public.user_tenants (user_id, tenant_id, role)
  VALUES (v_uid, p_tenant_id, COALESCE(p_role, 'student'))
  ON CONFLICT (user_id, tenant_id) DO NOTHING;

  UPDATE public.profiles
  SET current_tenant_id = p_tenant_id, updated_at = now()
  WHERE id = v_uid;

  RETURN jsonb_build_object('ok', true, 'user_id', v_uid, 'tenant_id', p_tenant_id);
END;
$$;
