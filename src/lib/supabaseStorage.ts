import { useEffect, useState } from 'react'
import { supabase, SUPABASE_READY } from './supabase'
import type { LibraryState, ProgressState } from '../domain/types'
import { keyFor } from '../domain/progress'

// Helpers que conectam o storage layer existente ao Supabase quando logado.
// Em modo demo (sem user) caem no localStorage como antes.

export async function loadRemoteLibrary(): Promise<LibraryState | null> {
  if (!SUPABASE_READY) return null
  const { data: session } = await supabase.auth.getSession()
  if (!session.session) return null
  const { data, error } = await supabase
    .from('user_library')
    .select('ebook_id, purchased_at, ebooks!inner(slug, owner_user_id)')
    .eq('user_id', session.session.user.id)
  if (error || !data) return null
  return {
    purchases: data.map((row: any) => ({
      id: row.ebook_id,
      userId: session.session.user.id,
      bookId: row.ebooks?.slug ?? row.ebook_id,
      status: 'approved' as const,
      purchasedAt: row.purchased_at,
      ownerUserId: row.ebooks?.owner_user_id ?? null,
    })),
  }
}

export async function addRemotePurchase(ebookSlug: string): Promise<boolean> {
  if (!SUPABASE_READY) return false
  const { data: session } = await supabase.auth.getSession()
  if (!session.session) return false
  // Resolve slug → ebook_id
  const { data: ebook, error: e1 } = await supabase
    .from('ebooks')
    .select('id')
    .eq('slug', ebookSlug)
    .single()
  if (e1 || !ebook) return false
  const { error } = await supabase.from('user_library').insert({
    user_id: session.session.user.id,
    ebook_id: ebook.id,
  })
  // 23505 = já existe (idempotente)
  return !error || error.code === '23505'
}

export async function loadRemoteProgress(): Promise<ProgressState | null> {
  if (!SUPABASE_READY) return null
  const { data: session } = await supabase.auth.getSession()
  if (!session.session) return null
  const { data, error } = await supabase
    .from('reading_progress')
    .select('ebook_id, current_page, last_read_at, ebooks!inner(slug, total_pages)')
    .eq('user_id', session.session.user.id)
  if (error || !data) return null
  const out: ProgressState = {}
  for (const row of data as any[]) {
    const slug = row.ebooks?.slug
    const total = row.ebooks?.total_pages ?? 1
    if (!slug) continue
    const pct = Math.min(100, Math.round((row.current_page / total) * 100))
    out[keyFor(session.session.user.id, slug)] = {
      page: row.current_page,
      totalPages: total,
      percent: pct,
      updatedAt: row.last_read_at,
    }
  }
  return out
}

export async function saveRemoteProgress(ebookSlug: string, page: number): Promise<boolean> {
  if (!SUPABASE_READY) return false
  const { data: session } = await supabase.auth.getSession()
  if (!session.session) return false
  const { data: ebook, error: e1 } = await supabase
    .from('ebooks')
    .select('id, total_pages')
    .eq('slug', ebookSlug)
    .single()
  if (e1 || !ebook) return false
  const safePage = Math.max(1, Math.min(ebook.total_pages, Math.floor(page)))
  // upsert: ON CONFLICT (user_id, ebook_id) DO UPDATE
  const { error } = await supabase
    .from('reading_progress')
    .upsert(
      {
        user_id: session.session.user.id,
        ebook_id: ebook.id,
        current_page: safePage,
        last_read_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,ebook_id' },
    )
  if (error) return false
  // Também registra na reading_sessions (histórico) — alimenta o cálculo de streak.
  // Falha aqui NÃO bloqueia o save principal (best-effort).
  await supabase.from('reading_sessions').insert({
    user_id: session.session.user.id,
    ebook_id: ebook.id,
    page_number: safePage,
  })
  return true
}

export function useRemoteSync(userId: string | undefined, onLibrary: (l: LibraryState) => void, onProgress: (p: ProgressState) => void) {
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!userId || userId === 'demo-user') return
    let cancelled = false
    setLoading(true)
    Promise.all([loadRemoteLibrary(), loadRemoteProgress()]).then(([lib, prog]) => {
      if (cancelled) return
      if (lib) onLibrary(lib)
      if (prog) onProgress(prog)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [userId])

  return { loading }
}

/** Busca todos os livros do user com metadados completos do ebooks. */
export async function loadRemoteUserBooks(): Promise<Array<{
  ebook_id: string
  slug: string
  title: string
  author: string
  cover_url: string | null
  pdf_storage_path: string | null
  total_pages: number
  owner_user_id: string | null
  purchased_at: string
}> | null> {
  if (!SUPABASE_READY) return null
  const { data: session } = await supabase.auth.getSession()
  if (!session.session) return null
  const { data, error } = await supabase
    .from('user_library')
    .select(`
      purchased_at, payment_status,
      ebooks!inner(
        id, slug, title, author, cover_url,
        pdf_storage_path, total_pages, owner_user_id
      )
    `)
    .eq('user_id', session.session.user.id)
    .order('purchased_at', { ascending: false })
  if (error || !data) return null
  return data.map((row: any) => ({
    ebook_id: row.ebooks.id,
    slug: row.ebooks.slug,
    title: row.ebooks.title,
    author: row.ebooks.author,
    cover_url: row.ebooks.cover_url,
    pdf_storage_path: row.ebooks.pdf_storage_path,
    total_pages: row.ebooks.total_pages || 0,
    owner_user_id: row.ebooks.owner_user_id,
    purchased_at: row.purchased_at,
  }))
}

/** Busca metadados de um ebook específico por slug (cobre livros uploaded). */
export async function loadEbookBySlug(slug: string): Promise<{
  ebook_id: string
  title: string
  author: string
  cover_url: string | null
  pdf_storage_path: string | null
  total_pages: number
  owner_user_id: string | null
  // 23/08/2026: precisei adicionar categoria aqui pro gate da Sala Dev.
  // Sem isso, dynamicBook.categoria ficava undefined e o botão Área Dev
  // se escondia pra TODO livro (mesmo os programacao) — bug pego via
  // print do Isaías no celular 23/08 21:30.
  categoria: string | null
} | null> {
  if (!SUPABASE_READY) return null
  const { data, error } = await supabase
    .from('ebooks')
    .select('id, slug, title, author, cover_url, pdf_storage_path, total_pages, owner_user_id, categoria')
    .eq('slug', slug)
    .maybeSingle()
  if (error || !data) return null
  return {
    ebook_id: data.id,
    title: data.title,
    author: data.author,
    cover_url: data.cover_url,
    pdf_storage_path: data.pdf_storage_path,
    total_pages: data.total_pages || 0,
    owner_user_id: data.owner_user_id,
    categoria: data.categoria ?? null,
  }
}
