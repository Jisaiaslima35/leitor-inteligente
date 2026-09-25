-- ==============================================================================
-- 20260923050000_academic_module_and_tenant_type.sql
-- Módulo Acadêmico (Escolas e Faculdades) + Blindagem de Dono e Tipo de Tenant
-- ==============================================================================

-- 1. Coluna 'type' na tabela tenants (suportando 'school', 'radio', 'church', 'common')
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'tenants' AND column_name = 'type'
  ) THEN
    ALTER TABLE public.tenants ADD COLUMN type text DEFAULT 'common';
  END IF;
END $$;

UPDATE public.tenants 
SET type = CASE 
  WHEN slug = 'radio-devocional-12' OR edition = 'radio_embed' THEN 'radio'
  WHEN edition IN ('school', 'academic_premium') THEN 'school'
  ELSE 'common'
END
WHERE type IS NULL OR type = 'common';

-- Garantir dono oficial de 'radio-devocional-12'
DO $$
DECLARE
  v_owner_id uuid;
  v_tenant_id uuid;
BEGIN
  SELECT id INTO v_owner_id FROM auth.users WHERE lower(email) = 'geminijose356@gmail.com' LIMIT 1;
  SELECT id INTO v_tenant_id FROM public.tenants WHERE slug = 'radio-devocional-12' LIMIT 1;
  
  IF v_owner_id IS NOT NULL AND v_tenant_id IS NOT NULL THEN
    UPDATE public.tenants SET owner_user_id = v_owner_id WHERE id = v_tenant_id;
    
    INSERT INTO public.user_tenants (user_id, tenant_id, role)
    VALUES (v_owner_id, v_tenant_id, 'owner')
    ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = 'owner';
  END IF;
END $$;

-- 2. Atualizar create_tenant_with_owner para suportar edition / type 'school'
CREATE OR REPLACE FUNCTION public.create_tenant_with_owner(
  p_name text,
  p_slug text,
  p_edition text DEFAULT 'radio_embed',
  p_domain text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_clean_slug text;
  v_tenant public.tenants%ROWTYPE;
  v_edition text;
  v_type text;
  v_allowlist text[];
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Apenas usuários autenticados podem criar instituições.';
  END IF;

  v_clean_slug := lower(regexp_replace(regexp_replace(trim(p_slug), '[^a-zA-Z0-9-]', '', 'g'), '^-+|-+$', '', 'g'));
  IF length(v_clean_slug) < 3 THEN
    RAISE EXCEPTION 'O identificador (%) deve conter pelo menos 3 caracteres alfanuméricos.', p_slug;
  END IF;

  IF EXISTS (SELECT 1 FROM public.tenants WHERE slug = v_clean_slug) THEN
    RAISE EXCEPTION 'O identificador "%" já está em uso por outra instituição.', v_clean_slug;
  END IF;

  IF p_edition IN ('school', 'academic_premium') THEN
    v_edition := 'academic_premium';
    v_type := 'school';
  ELSIF p_edition IN ('radio', 'radio_embed') THEN
    v_edition := 'radio_embed';
    v_type := 'radio';
  ELSE
    v_edition := 'common';
    v_type := 'common';
  END IF;

  v_allowlist := ARRAY['self', 'leitorinteligente.automacaojs.us'];
  IF p_domain IS NOT NULL AND trim(p_domain) <> '' THEN
    v_allowlist := array_append(v_allowlist, lower(regexp_replace(regexp_replace(trim(p_domain), '^https?://', ''), '/.*$', '')));
  END IF;

  INSERT INTO public.tenants (
    name,
    slug,
    edition,
    type,
    embed_allowlist,
    theme,
    owner_user_id
  ) VALUES (
    trim(p_name),
    v_clean_slug,
    v_edition,
    v_type,
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

-- 3. Tabela academic_assessments (Avaliação Oficial de cada Ebook / Tenant)
CREATE TABLE IF NOT EXISTS public.academic_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ebook_id uuid NOT NULL REFERENCES public.ebooks(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Avaliação Oficial de Conhecimento',
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_academic_assessment_ebook_tenant UNIQUE (ebook_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_academic_assessments_tenant_ebook 
  ON public.academic_assessments (tenant_id, ebook_id);

-- 4. Tabela academic_submissions (Submissão Única de Aluno com Prova de 5 Questões)
CREATE TABLE IF NOT EXISTS public.academic_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES public.academic_assessments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  ebook_id uuid REFERENCES public.ebooks(id) ON DELETE CASCADE,
  score numeric(4, 2) NOT NULL DEFAULT 0,
  total_questions int NOT NULL DEFAULT 5,
  correct_answers int NOT NULL DEFAULT 0,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  passed boolean NOT NULL DEFAULT false,
  completed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_academic_submission_user_assessment UNIQUE (user_id, assessment_id)
);

CREATE INDEX IF NOT EXISTS idx_academic_submissions_tenant 
  ON public.academic_submissions (tenant_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_academic_submissions_user 
  ON public.academic_submissions (user_id, completed_at DESC);

-- 5. Row Level Security (RLS)
ALTER TABLE public.academic_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.academic_submissions ENABLE ROW LEVEL SECURITY;

-- Assessments: Todos autenticados leem as avaliações da instituição
DROP POLICY IF EXISTS "academic_assessments_select" ON public.academic_assessments;
CREATE POLICY "academic_assessments_select" ON public.academic_assessments
  FOR SELECT USING (true);

-- Assessments: Apenas Owner ou Admin da instituição podem criar/editar
DROP POLICY IF EXISTS "academic_assessments_manage" ON public.academic_assessments;
CREATE POLICY "academic_assessments_manage" ON public.academic_assessments
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.user_tenants ut
      WHERE ut.user_id = auth.uid()
        AND ut.tenant_id = academic_assessments.tenant_id
        AND ut.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_tenants ut
      WHERE ut.user_id = auth.uid()
        AND ut.tenant_id = academic_assessments.tenant_id
        AND ut.role IN ('owner', 'admin')
    )
  );

-- Submissions: Alunos leem apenas suas próprias submissões; Dono/Admin lê todas do seu tenant
DROP POLICY IF EXISTS "academic_submissions_select" ON public.academic_submissions;
CREATE POLICY "academic_submissions_select" ON public.academic_submissions
  FOR SELECT USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.user_tenants ut
      WHERE ut.user_id = auth.uid()
        AND ut.tenant_id = academic_submissions.tenant_id
        AND ut.role IN ('owner', 'admin')
    )
  );

-- Submissions: Alunos inserem apenas suas próprias submissões
DROP POLICY IF EXISTS "academic_submissions_insert" ON public.academic_submissions;
CREATE POLICY "academic_submissions_insert" ON public.academic_submissions
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
  );

-- Conceder permissões para authenticated e anon
GRANT SELECT ON public.academic_assessments TO authenticated, anon;
GRANT ALL ON public.academic_assessments TO authenticated;
GRANT SELECT, INSERT ON public.academic_submissions TO authenticated;
GRANT ALL ON public.academic_submissions TO service_role;
