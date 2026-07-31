import { ArrowRight, Sparkles } from 'lucide-react'
import type { Route } from '../App'
import type { LibraryState } from '../domain/library'
import type { Book } from '../domain/types'
import { BookCard } from '../components/BookCard'
import { CATALOG } from '../domain/catalog'
import { ownsBook } from '../domain/library'

interface Props {
  onNavigate: (route: Route, bookId?: string) => void
  onBuy: (book: Book) => void
  library: LibraryState
}

export function HomePage({ onNavigate, onBuy, library }: Props) {
  const featured = CATALOG[0]
  return (
    <section>
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
            {ownsBook(library, 'demo-user', featured.id) ? (
              <button className="btn btn-secondary" onClick={() => onNavigate('reader', featured.id)}>
                Continuar lendo
              </button>
            ) : (
              <button className="btn btn-secondary" onClick={() => onBuy(featured)}>
                Comprar o destaque
              </button>
            )}
          </div>
        </div>
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
      </div>

      <div className="section-title">
        <h2>Destaques da semana</h2>
        <small>3 livros pensados pra mudar sua rotina</small>
      </div>
      <div className="book-grid">
        {CATALOG.map((book) => (
          <BookCard
            key={book.id}
            book={book}
            owned={ownsBook(library, 'demo-user', book.id)}
            onBuy={() => onBuy(book)}
            onRead={() => onNavigate('reader', book.id)}
          />
        ))}
      </div>
    </section>
  )
}