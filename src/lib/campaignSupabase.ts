// Loader de livros pra landpages de campanha (/tema/<slug>).
//
// DIFERENÇA do loadCatalogFromSupabase (vitrine comercial):
//   - NÃO filtra por is_published (livro recém-subido pelo Isaías aparece na hora)
//   - NÃO filtra por price_cents > 0 (campanha inclui livros do acervo pessoal)
//   - NÃO filtra por owner_user_id (inclui livros do admin E de qualquer usuário
//     que subiu ebook com categoria da campanha)
//   - filtra SÓ pela categoria da campanha
//
// Resultado: quando Isaías sobe um ebook pelo UploadPage com categoria
// batalha-espiritual, ele aparece na vitrine /tema/batalha-espiritual mesmo
// antes de ser "publicado" (porque campanha é diferente de loja comercial).
//
// Se a query vier vazia, a UI mostra o empty state ("em breve").

import type { Book, Categoria } from '../domain/types'

const SUPABASE_URL =
  (import.meta as any).env?.VITE_SUPABASE_URL || ''
const SUPABASE_ANON_KEY =
  (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || ''

export interface CampaignFetchResult {
  books: Book[]
  error: string | null
}

interface CampaignEbookRow {
  id: string
  slug: string
  title: string
  author: string | null
  description: string | null
  cover_url: string | null
  total_pages: number | null
  categoria: string | null
}

const VALID_CATEGORIAS: ReadonlySet<string> = new Set([
  'programacao',
  'tecnologia',
  'gospel',
  'literatura',
  'autoajuda',
  'outros',
  'comum',
  'batalha-espiritual',
  'casamento-familia',
  'infantil',
])

export async function loadBooksByCategoria(
  categoria: Categoria,
): Promise<CampaignFetchResult> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { books: [], error: 'supabase_env_ausente' }
  }
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/ebooks?categoria=eq.${encodeURIComponent(categoria)}` +
      `&select=id,slug,title,author,description,cover_url,total_pages,categoria` +
      `&order=created_at.desc&limit=200`
    const resp = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    })
    if (!resp.ok) return { books: [], error: `http_${resp.status}` }
    const rows: CampaignEbookRow[] = await resp.json()
    const books: Book[] = (rows || []).map((row) => ({
      id: row.slug || row.id,
      title: row.title,
      author: row.author || '',
      cover: row.cover_url || '',
      description: row.description || '',
      price: 0,
      totalPages: row.total_pages || 100,
      highlights: [],
      chunks: [],
      categoria: (row.categoria && VALID_CATEGORIAS.has(row.categoria)
        ? row.categoria
        : 'outros') as Categoria,
    }))
    return { books, error: null }
  } catch (err: any) {
    return { books: [], error: err?.message || 'fetch_falhou' }
  }
}
