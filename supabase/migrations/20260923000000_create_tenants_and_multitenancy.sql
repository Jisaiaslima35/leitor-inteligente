-- Migration: 20260923000000_create_tenants_and_multitenancy.sql
-- Descrição: FASE 1 - Passo 1: Modelagem de dados, multitenancy e backfill seguro
-- Data: 23/09/2026

-- 1. Criação da Tabela public.tenants
CREATE TABLE IF NOT EXISTS public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  theme jsonb NOT NULL DEFAULT '{}'::jsonb,
  edition text NOT NULL DEFAULT 'common' CHECK (edition IN ('common', 'radio_embed', 'academic_premium')),
  embed_allowlist text[] NOT NULL DEFAULT '{}',
  radio_mount text NULL,
  radio_liquidsoap_host text NULL,
  radio_liquidsoap_port int NULL,
  radio_liquidsoap_password text NULL,
  owner_user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  archived_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_tenants_slug ON public.tenants(slug);

-- 2. Criação da Tabela public.user_tenants
CREATE TABLE IF NOT EXISTS public.user_tenants (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher', 'admin', 'owner')),
  joined_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_user_tenants_user ON public.user_tenants(user_id);
CREATE INDEX IF NOT EXISTS idx_user_tenants_tenant ON public.user_tenants(tenant_id);

-- 3. Inserção dos Tenants Iniciais ('raiz' e 'devocional')
INSERT INTO public.tenants (slug, name, edition, embed_allowlist)
VALUES (
  'raiz',
  'Leitor Raiz',
  'common',
  ARRAY['self', 'leitorinteligente.automacaojs.us']
)
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name,
    edition = EXCLUDED.edition,
    embed_allowlist = EXCLUDED.embed_allowlist,
    updated_at = now();

INSERT INTO public.tenants (slug, name, edition, embed_allowlist, radio_mount)
VALUES (
  'devocional',
  'Rádio Devocional 12',
  'radio_embed',
  ARRAY['radio.automacaojs.us', 'devocional12.com.br'],
  '/studio-devocional'
)
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name,
    edition = EXCLUDED.edition,
    embed_allowlist = EXCLUDED.embed_allowlist,
    radio_mount = EXCLUDED.radio_mount,
    updated_at = now();

-- 4. Criação de tabelas complementares caso ainda não existam (payments e quiz_scores)
CREATE TABLE IF NOT EXISTS public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  amount_cents int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quiz_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  book_id text NOT NULL,
  total_score int NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Adição de tenant_id nas 6 tabelas especificadas (mais purchases, upload_payments e user_quiz_scores)
ALTER TABLE public.ebooks ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE;
ALTER TABLE public.user_library ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE;
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE;
ALTER TABLE public.upload_payments ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE;
ALTER TABLE public.quiz_scores ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE;
ALTER TABLE public.user_quiz_scores ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE;
ALTER TABLE public.academic_evaluations ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE;
ALTER TABLE public.collab_snapshots ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE;

-- Índices em tenant_id para otimização de consultas e joins
CREATE INDEX IF NOT EXISTS idx_ebooks_tenant ON public.ebooks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_library_tenant ON public.user_library(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON public.payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_purchases_tenant ON public.purchases(tenant_id);
CREATE INDEX IF NOT EXISTS idx_upload_payments_tenant ON public.upload_payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_quiz_scores_tenant ON public.quiz_scores(tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_quiz_scores_tenant ON public.user_quiz_scores(tenant_id);
CREATE INDEX IF NOT EXISTS idx_academic_evaluations_tenant ON public.academic_evaluations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_collab_snapshots_tenant ON public.collab_snapshots(tenant_id);

-- 6. Backfill Seguro: associar todos os registros legados (tenant_id IS NULL) ao tenant 'raiz'
DO $$
DECLARE
  v_raiz_id uuid;
BEGIN
  SELECT id INTO v_raiz_id FROM public.tenants WHERE slug = 'raiz';
  IF v_raiz_id IS NULL THEN
    RAISE EXCEPTION 'Tenant raiz não encontrado para backfill!';
  END IF;

  UPDATE public.ebooks SET tenant_id = v_raiz_id WHERE tenant_id IS NULL;
  UPDATE public.user_library SET tenant_id = v_raiz_id WHERE tenant_id IS NULL;
  UPDATE public.payments SET tenant_id = v_raiz_id WHERE tenant_id IS NULL;
  UPDATE public.purchases SET tenant_id = v_raiz_id WHERE tenant_id IS NULL;
  UPDATE public.upload_payments SET tenant_id = v_raiz_id WHERE tenant_id IS NULL;
  UPDATE public.quiz_scores SET tenant_id = v_raiz_id WHERE tenant_id IS NULL;
  UPDATE public.user_quiz_scores SET tenant_id = v_raiz_id WHERE tenant_id IS NULL;
  UPDATE public.academic_evaluations SET tenant_id = v_raiz_id WHERE tenant_id IS NULL;
  UPDATE public.collab_snapshots SET tenant_id = v_raiz_id WHERE tenant_id IS NULL;

  -- Associar todos os usuários existentes em auth.users ao tenant 'raiz' com role 'student'
  INSERT INTO public.user_tenants (user_id, tenant_id, role)
  SELECT id, v_raiz_id, 'student'
  FROM auth.users
  ON CONFLICT (user_id, tenant_id) DO NOTHING;
END $$;

-- 7. Função auxiliar de resolução de tenant JWT com fallback seguro para 'raiz'
CREATE OR REPLACE FUNCTION public.current_tenant_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (
      SELECT array_agg(t::uuid)
      FROM jsonb_array_elements_text(
        CASE 
          WHEN jsonb_typeof(auth.jwt() -> 'tenants') = 'array' THEN auth.jwt() -> 'tenants'
          WHEN auth.jwt() ->> 'tenant_id' IS NOT NULL THEN jsonb_build_array(auth.jwt() ->> 'tenant_id')
          ELSE NULL
        END
      ) AS t
    ),
    ARRAY[(SELECT id FROM public.tenants WHERE slug = 'raiz')]
  );
$$;

-- 8. Políticas de RLS (Row Level Security)
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_tenants ENABLE ROW LEVEL SECURITY;

-- Tenants: leitura pública (select usando true), escrita restrita a service_role / admin
DROP POLICY IF EXISTS "tenants_read_all" ON public.tenants;
CREATE POLICY "tenants_read_all" ON public.tenants FOR SELECT USING (true);

-- User_Tenants: usuário visualiza seus próprios vínculos
DROP POLICY IF EXISTS "user_tenants_select_own" ON public.user_tenants;
CREATE POLICY "user_tenants_select_own" ON public.user_tenants FOR SELECT USING (auth.uid() = user_id);

-- Ebooks: substituir policy antiga para isolamento por tenant ativo (com fallback 'raiz')
DROP POLICY IF EXISTS "ebooks_public_read" ON public.ebooks;
DROP POLICY IF EXISTS "ebooks_tenant_read" ON public.ebooks;
CREATE POLICY "ebooks_tenant_read" ON public.ebooks FOR SELECT USING (
  tenant_id = ANY(public.current_tenant_ids())
);

-- Academic Evaluations: isolamento por tenant
DROP POLICY IF EXISTS "academic_evaluations_all" ON public.academic_evaluations;
DROP POLICY IF EXISTS "academic_evaluations_tenant" ON public.academic_evaluations;
CREATE POLICY "academic_evaluations_tenant" ON public.academic_evaluations FOR ALL USING (
  tenant_id = ANY(public.current_tenant_ids())
) WITH CHECK (
  tenant_id = ANY(public.current_tenant_ids())
);

-- Collab Snapshots: isolamento por tenant
DROP POLICY IF EXISTS "collab_snapshots_all" ON public.collab_snapshots;
DROP POLICY IF EXISTS "collab_snapshots_tenant" ON public.collab_snapshots;
CREATE POLICY "collab_snapshots_tenant" ON public.collab_snapshots FOR ALL USING (
  tenant_id = ANY(public.current_tenant_ids())
) WITH CHECK (
  tenant_id = ANY(public.current_tenant_ids())
);

-- User Library: usuário enxerga seus livros dentro do tenant ativo
DROP POLICY IF EXISTS "user_library_tenant" ON public.user_library;
CREATE POLICY "user_library_tenant" ON public.user_library FOR ALL USING (
  auth.uid() = user_id AND (tenant_id = ANY(public.current_tenant_ids()) OR tenant_id IS NULL)
) WITH CHECK (
  auth.uid() = user_id AND (tenant_id = ANY(public.current_tenant_ids()) OR tenant_id IS NULL)
);

-- Purchases: isolamento no tenant
DROP POLICY IF EXISTS "purchases_tenant_read" ON public.purchases;
CREATE POLICY "purchases_tenant_read" ON public.purchases FOR SELECT USING (
  auth.uid() = user_id AND (tenant_id = ANY(public.current_tenant_ids()) OR tenant_id IS NULL)
);

-- User Quiz Scores: isolamento no tenant
DROP POLICY IF EXISTS "user_quiz_scores_tenant_read" ON public.user_quiz_scores;
CREATE POLICY "user_quiz_scores_tenant_read" ON public.user_quiz_scores FOR SELECT USING (
  auth.uid() = user_id AND (tenant_id = ANY(public.current_tenant_ids()) OR tenant_id IS NULL)
);

DROP POLICY IF EXISTS "user_quiz_scores_tenant_insert" ON public.user_quiz_scores;
CREATE POLICY "user_quiz_scores_tenant_insert" ON public.user_quiz_scores FOR INSERT WITH CHECK (
  auth.uid() = user_id AND (tenant_id = ANY(public.current_tenant_ids()) OR tenant_id IS NULL)
);

-- Payments
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payments_tenant_read" ON public.payments;
CREATE POLICY "payments_tenant_read" ON public.payments FOR SELECT USING (
  tenant_id = ANY(public.current_tenant_ids())
);

-- Quiz Scores
ALTER TABLE public.quiz_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "quiz_scores_tenant_read" ON public.quiz_scores;
CREATE POLICY "quiz_scores_tenant_read" ON public.quiz_scores FOR SELECT USING (
  tenant_id = ANY(public.current_tenant_ids())
);
