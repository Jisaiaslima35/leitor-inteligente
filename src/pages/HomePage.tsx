import { useEffect, useState } from 'react'
import { ArrowRight, Sparkles } from 'lucide-react'
import type { Route } from '../App'
import type { LibraryState } from '../domain/library'
import type { Book } from '../domain/types'
import { BookCard } from '../components/BookCard'
import { VoiceMentorSection } from '../components/VoiceMentorSection'
import { loadCatalogFromSupabase, loadReaderCountsBySlug } from '../lib/catalogSupabase'
import { useTenant } from '../lib/tenant'
import { ownsBook } from '../domain/library'

interface Props {
  onNavigate: (route: Route, bookId?: string) => void
  onBuy: (book: Book) => void
  library: LibraryState
}

export function HomePage({ onNavigate, onBuy, library }: Props) {
  const { tenant } = useTenant()
  const [books, setBooks] = useState<Book[]>([])
  const [readerCounts, setReaderCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      loadCatalogFromSupabase(tenant?.id),
      loadReaderCountsBySlug(),
    ]).then(([catalog, counts]) => {
      if (cancelled) return
      setBooks(catalog.books)
      setReaderCounts(counts)
      setError(catalog.error)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [tenant?.id])

  const featured = books[0]

  return (
    <section className="home-container">
      {/* 1. Hero / Banner Principal de Destaque */}
      <div className="hero">
        <div>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', color: 'var(--accent)', fontWeight: 700, letterSpacing: '0.05em' }}>
            <Sparkles size={16} /> LEITOR INTELIGENTE
          </span>
          <h1>Compre um livro. Converse com ele como se fosse um professor particular.</h1>
          <p>
            A primeira plataforma de leitura com IA generativa embutida: compre, abra o PDF no navegador, marque onde parou
            e pergunte em texto ou voz sobre qualquer trecho — tudo sem sair do app.
          </p>
          <div className="hero-actions">
            <button className="btn btn-primary" onClick={() => onNavigate('store')}>
              Ver loja <ArrowRight size={16} />
            </button>
            {featured && (ownsBook(library, 'demo-user', featured.id) ? (
              <button className="btn btn-secondary" onClick={() => onNavigate('reader', featured.id)}>
                Continuar lendo
              </button>
            ) : (
              <button className="btn btn-secondary" onClick={() => onBuy(featured)}>
                Comprar o destaque
              </button>
            ))}
          </div>
        </div>
        {featured && (
          <div style={{ position: 'relative' }}>
            <div style={{
              width: '100%', aspectRatio: '3/4',
              backgroundImage: `url(${featured.cover})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              borderRadius: 18,
              boxShadow: '0 30px 60px rgba(0,0,0,0.4)',
              transform: 'rotate(3deg)',
            }} aria-hidden="true" />
          </div>
        )}
      </div>

      {/* 2. Card Interativo do Professor IA / Conversa por Voz */}
      {books.length > 0 && (
        <div className="voice-mentor-wrapper">
          <VoiceMentorSection
            books={books}
            defaultBookId={featured?.id}
            onNavigate={onNavigate}
            onBuy={onBuy}
          />
        </div>
      )}

      {/* 3. Título da Seção: E-books / Catálogo de Livros */}
      <div className="section-title">
        <div>
          <h2>E-books / Catálogo de Livros</h2>
          <small>Obras completas com suporte ao Professor IA e Modo Mentor</small>
        </div>
        <button
          className="btn btn-ghost"
          style={{ fontSize: '0.85rem', padding: '8px 14px' }}
          onClick={() => onNavigate('store')}
        >
          Ver todos os livros <ArrowRight size={14} />
        </button>
      </div>

      {/* 4. Grid com os Cards dos Livros */}
      {loading ? (
        <p style={{ color: 'var(--muted)', padding: '24px 0', textAlign: 'center' }}>Carregando catálogo…</p>
      ) : error ? (
        <p style={{ color: 'var(--muted)', padding: '24px 0', textAlign: 'center' }}>
          Catálogo temporariamente indisponível. Tente recarregar.
        </p>
      ) : books.length === 0 ? (
        <p style={{ color: 'var(--muted)', padding: '24px 0', textAlign: 'center' }}>
          Nenhum ebook publicado pelo administrador ainda.
        </p>
      ) : (
        <div className="book-grid">
          {books.map((book) => (
            <BookCard
              key={book.id}
              book={book}
              owned={ownsBook(library, 'demo-user', book.id)}
              onBuy={() => onBuy(book)}
              onRead={() => onNavigate('reader', book.id)}
              readersCount={readerCounts[book.id]}
            />
          ))}
        </div>
      )}
    </section>
  )
}
