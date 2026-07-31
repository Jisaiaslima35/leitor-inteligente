import { BookCard } from '../components/BookCard'
import type { Book } from '../domain/types'
import type { LibraryState } from '../domain/library'
import { ownsBook } from '../domain/library'
import { CATALOG } from '../domain/catalog'

interface Props {
  onBuy: (book: Book) => void
  library: LibraryState
}

export function StorePage({ onBuy, library }: Props) {
  return (
    <section>
      <div className="section-title">
        <h2>Loja</h2>
        <small>Catálogo comercial • pagamento demonstrativo</small>
      </div>
      <div className="book-grid">
        {CATALOG.map((book) => (
          <BookCard
            key={book.id}
            book={book}
            owned={ownsBook(library, 'demo-user', book.id)}
            onBuy={() => onBuy(book)}
            onRead={() => undefined}
          />
        ))}
      </div>
    </section>
  )
}
