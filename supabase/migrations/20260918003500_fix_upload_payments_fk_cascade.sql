-- Migration: Fix upload_payments foreign key cascade delete
-- Data: 18/09/2026
-- Permite exclusão de livros em ebooks sem conflito de foreign key em upload_payments

ALTER TABLE public.upload_payments 
  DROP CONSTRAINT IF EXISTS upload_payments_ebook_id_fkey;

ALTER TABLE public.upload_payments 
  ADD CONSTRAINT upload_payments_ebook_id_fkey 
  FOREIGN KEY (ebook_id) REFERENCES public.ebooks(id) ON DELETE SET NULL;
