import { useEffect, useState } from 'react'
import type { Book } from '../domain/types'
import { supabase } from '../lib/supabase'
import { ShareMenu } from './ShareMenu'

interface Props {
  book: Book
  owned: boolean
  onBuy: () => void
  onRead: () => void
  showShare?: boolean  // default true; esconde no carrinho/checkout onde não faz sentido
  readersCount?: number  // prova social: quantas pessoas estão lendo (0 = não mostra)
}

function formatPrice(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function BookCard({ book, owned, onBuy, onRead, showShare = true, readersCount }: Props) {
  // Tenta usar a capa real do Supabase se o slug existir lá.
  // Se não existir (placeholder catalog), usa a URL hardcoded do book.cover.
  const [liveCover, setLiveCover] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    async function fetchCover() {
      const { data } = await supabase
        .from('ebooks')
        .select('cover_url, shareable')
        .eq('slug', book.id)
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
        {readersCount && readersCount > 0 ? (
          <div
            className="reader-count"
            style={{
              fontSize: 13,
              color: 'var(--accent, #d4af37)',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              margin: '4px 0 0',
            }}
            aria-label={`${readersCount} pessoas estão lendo este livro`}
          >
            <span aria-hidden="true">👥</span>
            <span>{readersCount} {readersCount === 1 ? 'pessoa lendo' : 'pessoas lendo'}</span>
          </div>
        ) : null}
        <div className="price">{formatPrice(book.price)}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {owned ? (
            <button className="btn btn-primary" onClick={onRead}>Abrir leitor</button>
          ) : (
            <button className="btn btn-primary" onClick={onBuy}>Comprar agora</button>
          )}
          {showShare && <ShareMenu ebookSlug={book.id} bookTitle={book.title} />}
        </div>
      </div>
    </article>
  )
}
