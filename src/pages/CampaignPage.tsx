// CampaignPage — rota /tema/<slug>
//
// Layout (1 coluna no mobile, 2 no desktop):
//   ┌──────────────────────────────────────────────────────┐
//   │  HERO  (badge + título + descrição + 2 CTAs + capa) │
//   ├──────────────────────────────────────────────────────┤
//   │  "Explorar por Títulos e Sub-temas"                  │
//   │  Grid de CampaignCard (capa + páginas + título)      │
//   │  empty state se vazio                                │
//   └──────────────────────────────────────────────────────┘
//
// Fluxo de clique no card / CTA secundário:
//   1. Se user TEM o livro → vai pro reader (#/reader/<slug>)
//   2. Se NÃO tem e NÃO está logado → vai pro login
//   3. Se NÃO tem e está logado → abre CheckoutModal (R$12,90)
//      (mesmo CheckoutModal que StorePage usa)

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Book, LibraryState } from '../domain/types'
import { ownsBook } from '../domain/library'
import { CampaignCard } from '../components/CampaignCard'
import { loadBooksByCategoria } from '../lib/campaignSupabase'
import { useAuth } from '../lib/AuthContext'
import type { Campanha } from '../data/campaigns'

interface Props {
  campanha: Campanha
  library: LibraryState
  /** user logado — passado pronto da App pra evitar hook duplo */
  isAuthenticated: boolean
  onOpenReader: (bookId: string) => void
  onOpenLogin: () => void
  onOpenCheckout: (book: Book) => void
  onScrollToGrid: () => void
}

export function CampaignPage({
  campanha,
  library,
  isAuthenticated,
  onOpenReader,
  onOpenLogin,
  onOpenCheckout,
  onScrollToGrid,
}: Props) {
  const { user } = useAuth()
  const [books, setBooks] = useState<Book[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    loadBooksByCategoria(campanha.categoria).then((res) => {
      if (cancelled) return
      setBooks(res.books)
      setError(res.error)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [campanha.categoria])

  // Livro destaque: configurado OU mais recente da lista
  const featured = useMemo(() => {
    if (campanha.featuredBookId) {
      const explicit = books.find((b) => b.id === campanha.featuredBookId)
      if (explicit) return explicit
    }
    return books[0] ?? null
  }, [books, campanha.featuredBookId])

  const handleBookClick = (book: Book) => {
    if (user && ownsBook(library, user.id, book.id)) {
      onOpenReader(book.id)
      return
    }
    if (!isAuthenticated) {
      onOpenLogin()
      return
    }
    onOpenCheckout(book)
  }

  const handleHeroCtaPrimario = () => {
    onScrollToGrid()
    gridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const handleHeroCtaSecundario = () => {
    if (!featured) {
      handleHeroCtaPrimario()
      return
    }
    handleBookClick(featured)
  }

  return (
    <div className="campaign-page">
      {/* HERO */}
      <section className="campaign-hero">
        <div className="campaign-hero-text">
          <div className="campaign-hero-badge">{campanha.badge}</div>
          <h1 className="campaign-hero-title">{campanha.titulo}</h1>
          <p className="campaign-hero-desc">{campanha.descricao}</p>
          <div className="campaign-hero-ctas">
            <button className="campaign-hero-cta-primary" onClick={handleHeroCtaPrimario}>
              {campanha.ctaPrimario}
            </button>
            <button
              className="campaign-hero-cta-secondary"
              onClick={handleHeroCtaSecundario}
              disabled={!featured && loading}
            >
              {campanha.ctaSecundario}
            </button>
          </div>
        </div>
        {featured && (
          <div className="campaign-hero-cover" aria-hidden="true">
            <div
              className="campaign-hero-cover-img"
              style={{ backgroundImage: `url(${featured.cover})` }}
            />
            <span className="campaign-hero-cover-pages">{featured.totalPages} páginas</span>
            <span className="campaign-hero-cover-quiz">Quiz Inteligente Disponível</span>
          </div>
        )}
      </section>

      {/* GRID */}
      <section className="campaign-grid-section" ref={gridRef}>
        <h2 className="campaign-grid-title">Explorar por Títulos e Sub-temas</h2>

        {loading ? (
          <div className="campaign-empty">Carregando livros da coleção...</div>
        ) : error ? (
          <div className="campaign-empty">
            Não conseguimos carregar os livros agora. Tente recarregar a página.
          </div>
        ) : books.length === 0 ? (
          <div className="campaign-empty">
            📚 Livros sendo preparados para esta coleção, fique atento!
            <br />
            <small>Em breve, novos títulos aqui.</small>
          </div>
        ) : (
          <div className="campaign-grid">
            {books.map((book) => (
              <CampaignCard
                key={book.id}
                book={book}
                onSelect={() => handleBookClick(book)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
