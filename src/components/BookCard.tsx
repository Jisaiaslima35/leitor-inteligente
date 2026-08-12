import { useEffect, useState } from 'react'
import type { Book } from '../domain/types'
import { supabase } from '../lib/supabase'

interface Props {
  book: Book
  owned: boolean
  onBuy: () => void
  onRead: () => void
}

function formatPrice(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function BookCard({ book, owned, onBuy, onRead }: Props) {
  // Tenta usar a capa real do Supabase se o slug existir lá.
  // Se não existir (placeholder catalog), usa a URL hardcoded do book.cover.
  const [liveCover, setLiveCover] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    async function fetchCover() {
      const { data } = await supabase
        .from('ebooks')
        .select('cover_url')
        .eq('slug', book.id)
        .not('cover_url', 'is', null)
        .maybeSingle()
      if (!cancelled && data?.cover_url) {
        setLiveCover(data.cover_url)
      }
    }
    fetchCover()
    return () => { cancelled = true }
  }, [book.id])

  const coverSrc = liveCover || book.cover

  return (
    <article className="book-card">
      <div
        className="book-cover"
        style={{ backgroundImage: `url(${coverSrc})` }}
        role="img"
        aria-label={`Capa do livro ${book.title}`}
      >
        <span className="badge">{book.totalPages} páginas</span>
      </div>
      <div className="book-body">
        <div>
          <h3>{book.title}</h3>
          <div className="author">por {book.author}</div>
        </div>
        <p className="description">{book.description}</p>
        <div className="price">{formatPrice(book.price)}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {owned ? (
            <button className="btn btn-primary" onClick={onRead}>Abrir leitor</button>
          ) : (
            <button className="btn btn-primary" onClick={onBuy}>Comprar agora</button>
          )}
        </div>
      </div>
    </article>
  )
}
