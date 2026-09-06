import { useEffect, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import type { Route } from '../App'
import type { ProgressState } from '../domain/library'
import { getProgress } from '../domain/progress'
import { useAuth } from '../lib/AuthContext'
import { supabase } from '../lib/supabase'

interface Props {
  progress: ProgressState
  onNavigate: (route: Route, bookId?: string) => void
}

interface LibraryBook {
  id: string              // slug (bookId / catalog id)
  ebook_id: string        // uuid do ebooks row
  slug: string
  title: string
  author: string
  cover_url: string | null
  pdf_storage_path: string | null
  total_pages: number
  owner_user_id: string | null
  purchased_at: string | null
  payment_status: string
  is_global: boolean
  skill_generated: boolean
}

export function LibraryPage({ progress, onNavigate }: Props) {
  const { user } = useAuth()
  const userId = user.id
  const [books, setBooks] = useState<LibraryBook[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        // 05/09/2026 (v8 Isaías): Minha Biblioteca = estritamente livros
        // COMPRADOS/ADICIONADOS pelo user. Livros globais do Modo Mentor
        // aparecem SÓ na vitrine pública (#/store, #/home) com o badge.
        // Antes usava view `user_library_with_globals` que injetava
        // is_global=true pra todo mundo — daí qualquer user logado via 4
        // livros que nunca comprou. Fix: query direta em user_library +
        // JOIN com ebooks pra metadata.
        const { data, error: e1 } = await supabase
          .from('user_library')
          .select(`
            user_id, purchased_at, payment_status,
            ebooks!inner(
              ebook_id:id, slug, title, author, cover_url,
              pdf_storage_path, total_pages, owner_user_id,
              is_global, skill_generated
            )
          `)
          .eq('user_id', userId)
          .order('purchased_at', { ascending: false, nullsFirst: false })

        if (e1) throw e1
        if (cancelled) return

        const rows: LibraryBook[] = []
        for (const row of (data || []) as any[]) {
          const eb = row.ebooks
          if (!eb || !eb.slug) continue
          rows.push({
            id: eb.slug,
            ebook_id: eb.ebook_id,
            slug: eb.slug,
            title: eb.title,
            author: eb.author,
            cover_url: eb.cover_url,
            pdf_storage_path: eb.pdf_storage_path,
            total_pages: eb.total_pages || 0,
            owner_user_id: eb.owner_user_id,
            purchased_at: row.purchased_at,
            payment_status: row.payment_status,
            is_global: !!eb.is_global,
            skill_generated: !!eb.skill_generated,
          })
        }
        setBooks(rows)
      } catch (e: any) {
        setError(e?.message || String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [userId])

  if (loading) {
    return (
      <section>
        <h2 style={{ marginTop: 0 }}>Minha Biblioteca</h2>
        <p style={{ color: 'var(--muted)' }}>Carregando seus livros...</p>
      </section>
    )
  }

  if (error) {
    return (
      <section>
        <h2 style={{ marginTop: 0 }}>Minha Biblioteca</h2>
        <p style={{ color: 'var(--c-error, #dc2626)' }}>Erro: {error}</p>
      </section>
    )
  }

  if (books.length === 0) {
    return (
      <section>
        <h2 style={{ marginTop: 0 }}>Sua biblioteca está vazia</h2>
        <p style={{ color: 'var(--muted)' }}>
          Visite a <button className="btn btn-ghost" onClick={() => onNavigate('store')}>loja</button> e adicione seu primeiro livro, ou{' '}
          <button className="btn btn-ghost" onClick={() => onNavigate('upload')}>envie o seu PDF</button>.
        </p>
      </section>
    )
  }

  return (
    <section>
      <div className="section-title">
        <h2>Minha Biblioteca</h2>
        <small>{books.length} {books.length === 1 ? 'livro' : 'livros'}</small>
      </div>
      <div className="library-list">
        {books.map((book) => {
          const item = getProgress(progress, userId, book.id)
          const isMine = !!book.owner_user_id
          return (
            <article key={book.id} className="library-item">
              <div
                className="cover"
                style={{
                  backgroundImage: book.cover_url
                    ? `url(${book.cover_url})`
                    : 'linear-gradient(135deg, var(--brand), var(--accent))',
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div>
                  <h4>
                    {book.title}
                    {isMine && <span className="my-book-badge">Meu livro</span>}
                    {book.is_global && (
                      <span
                        className="my-book-badge"
                        style={{
                          background: 'linear-gradient(90deg,#7c3aed,#db2777)',
                          color: '#fff',
                          marginLeft: 6,
                        }}
                      >
                        ✨ Modo Mentor
                      </span>
                    )}
                  </h4>
                  <div className="author">por {book.author}</div>
                </div>
                <div>
                  <div className="progress-bar" aria-label={`Progresso ${item?.percent ?? 0}%`}>
                    <span style={{ width: `${item?.percent ?? 0}%` }} />
                  </div>
                  <small style={{ color: 'var(--muted)' }}>
                    {item
                      ? `Página ${item.page} de ${item.totalPages} (${item.percent}%)`
                      : book.total_pages > 0
                        ? `Você ainda não começou — ${book.total_pages} páginas`
                        : 'Você ainda não começou — abra agora mesmo.'}
                  </small>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button className="btn btn-primary" onClick={() => onNavigate('reader', book.id)}>
                    {item ? 'Continuar' : 'Abrir'} <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
