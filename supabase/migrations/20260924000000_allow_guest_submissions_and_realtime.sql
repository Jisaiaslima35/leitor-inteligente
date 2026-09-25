-- Migration: Allow guest/anonymous submissions and enable Realtime for academic_submissions
-- Date: 2026-09-24

-- 1. Make user_id nullable and add student_name and student_identifier
ALTER TABLE public.academic_submissions ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.academic_submissions ADD COLUMN IF NOT EXISTS student_name text;
ALTER TABLE public.academic_submissions ADD COLUMN IF NOT EXISTS student_identifier text;

-- 2. Unique constraints: one submission per user_id OR per student_identifier for a given assessment
ALTER TABLE public.academic_submissions DROP CONSTRAINT IF EXISTS uq_academic_submission_user_assessment;
CREATE UNIQUE INDEX IF NOT EXISTS idx_uq_academic_sub_user_assess ON public.academic_submissions (user_id, assessment_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_uq_academic_sub_student_assess ON public.academic_submissions (student_identifier, assessment_id) WHERE student_identifier IS NOT NULL;

-- 3. RLS for academic_submissions
ALTER TABLE public.academic_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "academic_submissions_insert" ON public.academic_submissions;
DROP POLICY IF EXISTS "Allow submit assessment" ON public.academic_submissions;
CREATE POLICY "Allow submit assessment" ON public.academic_submissions FOR INSERT WITH CHECK (tenant_id IS NOT NULL);

DROP POLICY IF EXISTS "academic_submissions_select" ON public.academic_submissions;
CREATE POLICY "academic_submissions_select" ON public.academic_submissions FOR SELECT
USING (
  user_id = auth.uid()
  OR auth.uid() IS NULL
  OR EXISTS (
    SELECT 1 FROM user_tenants ut
    WHERE ut.user_id = auth.uid()
      AND ut.tenant_id = academic_submissions.tenant_id
      AND ut.role = ANY (ARRAY['owner'::text, 'admin'::text])
  )
);

-- 4. RLS for academic_assessments so default assessments can be inserted by readers/guests
DROP POLICY IF EXISTS "academic_assessments_insert_public" ON public.academic_assessments;
CREATE POLICY "academic_assessments_insert_public" ON public.academic_assessments FOR INSERT WITH CHECK (tenant_id IS NOT NULL);

-- 5. Permissions
GRANT ALL ON public.academic_submissions TO anon, authenticated, service_role;
GRANT ALL ON public.academic_assessments TO anon, authenticated, service_role;

-- 6. Realtime publication
ALTER TABLE public.academic_submissions REPLICA IDENTITY FULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'academic_submissions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.academic_submissions;
  END IF;
END $$;
