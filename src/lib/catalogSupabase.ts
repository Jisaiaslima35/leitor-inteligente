// Carrega catálogo dinâmico do Supabase com fallback seguro pro CATALOG hardcoded.
// Strategy: Supabase é source-of-truth pra preço/capa/descrição, CATALOG local
// provê highlights + chunks (que ainda não migramos pro Supabase).

import { CATALOG } from '../domain/catalog'
import type { Book } from '../domain/types'

// Lê env vars expostas pelo Vite (VITE_*) — não usa segredos, só URL + anon key.
const SUPABASE_URL =
  (import.meta as any).env?.VITE_SUPABASE_URL || ''
const SUPABASE_ANON_KEY =
  (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || ''

export interface SupabaseEbook {
  slug: string
  title: string
  author: string | null
  description: string | null
  cover_url: string | null
  price_cents: number
  total_pages: number
  is_published: boolean
}

export async function loadCatalogFromSupabase(): Promise<Book[]> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn('[catalog] env vars ausentes, usando CATALOG estático')
    return CATALOG
  }
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/ebooks?is_published=eq.true` +
      `&select=slug,title,author,description,cover_url,price_cents,total_pages` +
      `&order=price_cents.desc,created_at.desc&limit=200`
    const resp = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const rows: SupabaseEbook[] = await resp.json()
    if (!Array.isArray(rows) || rows.length === 0) {
      console.warn('[catalog] Supabase retornou vazio, usando CATALOG estático')
      return CATALOG
    }
    // Merge: Supabase é source-of-truth pra metadados comerciais;
    // CATALOG local provê highlights + chunks (lookup por slug).
    const bySlug = new Map(CATALOG.map((b) => [b.id, b]))
    return rows.map((row): Book => {
      const local = bySlug.get(row.slug)
      return {
        id: row.slug,
        title: row.title,
        author: row.author || '',
        cover: row.cover_url || local?.cover || '',
        description: row.description || '',
        price: row.price_cents,
        totalPages: row.total_pages,
        highlights: local?.highlights || [],
        chunks: local?.chunks || [],
      }
    })
  } catch (err) {
    console.error('[catalog] falha no fetch Supabase, fallback CATALOG:', err)
    return CATALOG
  }
}
