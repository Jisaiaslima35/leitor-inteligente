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
import type { Book, Categoria } from '../domain/types'

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
  categoria: string | null
  toc?: [number, string, number][]
  modo_mentor_habilitado?: boolean
  hook_abertura?: string | null
  prompt_mentor?: string | null
  voz_id?: string | null
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
export async function loadCatalogFromSupabase(tenantId?: string): Promise<CatalogFetchResult> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { books: [], error: 'supabase_env_ausente' }
  }
  try {
    let url =
      `${SUPABASE_URL}/rest/v1/ebooks?is_published=eq.true` +
      `&price_cents=gt.0` +
      `&select=id,slug,title,author,description,cover_url,price_cents,total_pages,categoria,toc,modo_mentor_habilitado,hook_abertura,prompt_mentor,voz_id` +
      `&order=created_at.desc&limit=200`
    
    if (tenantId) {
      url += `&or=(tenant_id.eq.${tenantId},is_public.eq.true,tenant_id.is.null)`
    } else {
      // Fallback para o tenant raiz padrão e livros públicos/sem tenant
      url += `&or=(is_public.eq.true,tenant_id.is.null,tenant_id.eq.2656ae53-fbb0-4478-ab1a-36f3561d51df)`
    }
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
    const VALID: ReadonlySet<string> = new Set(['programacao', 'tecnologia', 'gospel', 'literatura', 'autoajuda', 'outros'])
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
      categoria: (row.categoria && VALID.has(row.categoria) ? row.categoria : 'outros') as Categoria,
      toc: row.toc,
      modoMentorHabilitado: Boolean(row.modo_mentor_habilitado),
      hookAbertura: row.hook_abertura || undefined,
      promptMentor: row.prompt_mentor || undefined,
      vozId: row.voz_id || undefined,
    }))
    return { books, error: null }
  } catch (err: any) {
    return { books: [], error: err?.message || 'fetch_falhou' }
  }
}

/**
 * Prova social: conta quantos leitores confirmados tem cada ebook (vitrine).
 *
 * Retorna Map<slug, count>. Se o Supabase bloquear via RLS, se a view
 * `ebook_reader_counts` não existir, ou se der timeout, retorna Map vazio
 * (graceful degradation — UI simplesmente não mostra "X lendo" e a home
 * funciona igual).
 *
 * Depende da view `public.ebook_reader_counts` criada via Management API
 * (Isaías autorizou 19/08/2026). View conta user_library com
 * payment_status = 'confirmed' por ebook publicado, GRANT SELECT pra anon
 * e authenticated — bypass da RLS restritiva de user_library.
 *
 * NÃO mexe em backend Python — bate direto no PostgREST com anon key.
 */
export async function loadReaderCountsBySlug(): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return out
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/ebook_reader_counts` +
      `?select=slug,readers_count` +
      `&limit=500`
    const resp = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    })
    if (!resp.ok) return out
    const rows = await resp.json()
    if (!Array.isArray(rows)) return out
    for (const row of rows) {
      const slug = row?.slug
      const cnt = row?.readers_count
      if (slug && typeof cnt === 'number' && cnt > 0) {
        out[slug] = cnt
      }
    }
    return out
  } catch {
    return out
  }
}
