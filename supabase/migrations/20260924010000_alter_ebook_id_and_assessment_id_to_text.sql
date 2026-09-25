-- Migration: Alter ebook_id and assessment_id to TEXT to support book slugs and resilient IDs
-- Date: 2026-09-24

-- 1. Clean test assessment if any
DELETE FROM public.academic_assessments WHERE id = '817c0127-48b5-4ad5-b0cd-548ed9aad842';

-- 2. Drop foreign key constraints on ebook_id
ALTER TABLE public.academic_assessments DROP CONSTRAINT IF EXISTS academic_assessments_ebook_id_fkey;
ALTER TABLE public.academic_submissions DROP CONSTRAINT IF EXISTS academic_submissions_ebook_id_fkey;

-- 3. Drop unique constraint on (ebook_id, tenant_id) before altering type
ALTER TABLE public.academic_assessments DROP CONSTRAINT IF EXISTS uq_academic_assessment_ebook_tenant;

-- 4. Alter ebook_id column type to TEXT in both tables
ALTER TABLE public.academic_assessments ALTER COLUMN ebook_id TYPE text USING ebook_id::text;
ALTER TABLE public.academic_submissions ALTER COLUMN ebook_id TYPE text USING ebook_id::text;

-- 5. Re-create unique constraint on (ebook_id, tenant_id)
ALTER TABLE public.academic_assessments ADD CONSTRAINT uq_academic_assessment_ebook_tenant UNIQUE (ebook_id, tenant_id);

-- 6. Relax assessment_id constraint in academic_submissions
ALTER TABLE public.academic_submissions DROP CONSTRAINT IF EXISTS academic_submissions_assessment_id_fkey;
ALTER TABLE public.academic_submissions ALTER COLUMN assessment_id DROP NOT NULL;
ALTER TABLE public.academic_submissions ALTER COLUMN assessment_id TYPE text USING assessment_id::text;

-- 7. Relax academic_assessments.id to TEXT with default uuid generator
ALTER TABLE public.academic_assessments ALTER COLUMN id TYPE text USING id::text;
ALTER TABLE public.academic_assessments ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
