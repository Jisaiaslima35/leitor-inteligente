// Carrega catálogo dinâmico do Supabase.
// FONTE OFICIAL: Supabase. NÃO usa mais CATALOG hardcoded como fallback.
//
// Filtro de vitrine (Início + Loja):
//   - owner_user_id = ADMIN_USER_ID (só ebooks cadastrados pelo admin)
//   - is_published = true (admin precisa publicar)
//   - price_cents > 0 (ebooks grátis NÃO aparecem — evita quebrar a app)
//
// Chunks de RAG (para o chat do Leitor) ficam em src/domain/catalogRagChunks.ts
// — o admin pode publicar livros sem precisar re-indexar RAG.

import { ADMIN_USER_ID } from './admin'
import type { Book } from '../domain/types'

const SUPABASE_URL =
  (import.meta as any).env?.VITE_SUPABASE_URL || ''
const SUPABASE_ANON_KEY =
  (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || ''

export interface SupabaseEbook {
  id: string
  slug: string
  title: string
  author: string | null
  description: string | null
  cover_url: string | null
  price_cents: number
  total_pages: number
  is_published: boolean
  owner_user_id: string | null
}

export interface CatalogFetchResult {
  books: Book[]
  error: string | null
}

/**
 * Carrega ebooks visíveis publicamente (vitrine: Início + Loja).
 * Filtro acontece no Supabase via query — NADA de filtro visual no React.
 * Se Supabase falhar OU retornar vazio, retorna lista vazia (sem fallback
 * hardcoded). App mostra estado vazio honesto em vez de vazar ebooks privados.
 */
export async function loadCatalogFromSupabase(): Promise<CatalogFetchResult> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { books: [], error: 'supabase_env_ausente' }
  }
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/ebooks?is_published=eq.true` +
      `&owner_user_id=eq.${ADMIN_USER_ID}` +
      `&price_cents=gt.0` +
      `&select=id,slug,title,author,description,cover_url,price_cents,total_pages` +
      `&order=created_at.desc&limit=200`
    const resp = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    })
    if (!resp.ok) {
      return { books: [], error: `http_${resp.status}` }
    }
    const rows: SupabaseEbook[] = await resp.json()
    const books: Book[] = (rows || []).map((row) => ({
      id: row.slug,
      title: row.title,
      author: row.author || '',
      cover: row.cover_url || '',
      description: row.description || '',
      price: row.price_cents,
      totalPages: row.total_pages,
      highlights: [],
      chunks: [],
    }))
    return { books, error: null }
  } catch (err: any) {
    return { books: [], error: err?.message || 'fetch_falhou' }
  }
}
