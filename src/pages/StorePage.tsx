import { useState, useEffect } from 'react'
import { BookCard } from '../components/BookCard'
import type { Book } from '../domain/types'
import type { LibraryState } from '../domain/library'
import { ownsBook } from '../domain/library'
import { loadCatalogFromSupabase, loadReaderCountsBySlug } from '../lib/catalogSupabase'

interface Props {
  onBuy: (book: Book) => void
  library: LibraryState
  onGoLibrary: () => void
}

const PENDING_KEY = 'leitor-ia:pending-checkout'

interface PendingCheckout {
  bookId: string
  bookTitle: string
  at: number
}

function readPending(): PendingCheckout | null {
  try {
    const raw = window.localStorage.getItem(PENDING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PendingCheckout
    // Expira em 1h — senão fica aparecendo sempre
    if (Date.now() - parsed.at > 60 * 60 * 1000) {
      window.localStorage.removeItem(PENDING_KEY)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function StorePage({ onBuy, library, onGoLibrary }: Props) {
  const [pending, setPending] = useState<PendingCheckout | null>(null)
  const [books, setBooks] = useState<Book[]>([])
  const [readerCounts, setReaderCounts] = useState<Record<string, number>>({})
  const [loadingCatalog, setLoadingCatalog] = useState(true)
  const [catalogError, setCatalogError] = useState<string | null>(null)

  useEffect(() => {
    // Carrega catálogo + prova social do Supabase (filtro server-side: admin + publicado + preço > 0).
    // SEM fallback pro CATALOG hardcoded — vitrine vazia é honesta.
    // Contagens: se RLS bloquear, retorna {} e BookCard não mostra o badge.
    let cancelled = false
    Promise.all([
      loadCatalogFromSupabase(),
      loadReaderCountsBySlug(),
    ])
      .then(([res, counts]) => {
        if (!cancelled) {
          setBooks(res.books)
          setReaderCounts(counts)
          setCatalogError(res.error)
          setLoadingCatalog(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalogError('fetch_falhou')
          setLoadingCatalog(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    // 2. Ao montar a Loja, vê se user voltou de um checkout
    const p = readPending()
    if (p) setPending(p)
  }, [])

  // Banner some quando user clica em "já vi"
  const dismissBanner = () => {
    try { window.localStorage.removeItem(PENDING_KEY) } catch {}
    setPending(null)
  }

  // Limpa a flag se o user já tem o livro (não precisa mais do banner)
  useEffect(() => {
    if (pending && library.purchases.some((p) => p.bookId === pending.bookId)) {
      try { window.localStorage.removeItem(PENDING_KEY) } catch {}
      setPending(null)
    }
  }, [library, pending])

  return (
    <section>
      <div className="section-title">
        <h2>Loja</h2>
        <small>Catálogo comercial • pagamento demonstrativo</small>
      </div>

      {pending && (
        <div
          className="pending-checkout-banner"
          style={{
            background: 'linear-gradient(135deg, #2a2540, #3a3150)',
            border: '1px solid #d4af37',
            borderRadius: 12,
            padding: '16px 20px',
            margin: '0 0 24px',
            color: '#e8e0d0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: 200 }}>
            <strong style={{ color: '#d4af37', fontFamily: 'Georgia, serif' }}>
              Pagou e o livro ainda não apareceu?
            </strong>
            <div style={{ marginTop: 4, fontSize: 14, opacity: 0.9 }}>
              O webhook costuma liberar em até 30s. Se já passou mais que isso e
              sua Biblioteca ainda está vazia, toque no botão pra checar de novo.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={onGoLibrary}
              style={{
                background: '#d4af37',
                color: '#0c0a17',
                border: 'none',
                borderRadius: 8,
                padding: '10px 20px',
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              Ver minha Biblioteca
            </button>
            <button
              type="button"
              onClick={dismissBanner}
              aria-label="Fechar"
              style={{
                background: 'transparent',
                color: '#e8e0d0',
                border: '1px solid #6b6280',
                borderRadius: 8,
                padding: '10px 14px',
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              Já vi
            </button>
          </div>
        </div>
      )}

      <div className="book-grid">
        {loadingCatalog && books.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>
            Carregando catálogo...
          </div>
        ) : !loadingCatalog && books.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>
            {catalogError
              ? 'Catálogo temporariamente indisponível. Tente recarregar.'
              : 'Nenhum ebook disponível na loja no momento.'}
          </div>
        ) : (
          books.map((book) => (
            <BookCard
              key={book.id}
              book={book}
              owned={ownsBook(library, 'demo-user', book.id)}
              onBuy={() => onBuy(book)}
              onRead={() => undefined}
              readersCount={readerCounts[book.id]}
            />
          ))
        )}
      </div>
    </section>
  )
}
