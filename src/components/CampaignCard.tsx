// Card de livro dentro de uma campanha temática (/tema/<slug>).
//
// Diferente do BookCard (vitrine comercial):
//   - sem preço (campanha é acesso único, não venda avulsa)
//   - CTA sempre "Começar a Estudar" — abre CheckoutModal se user não tem
//     o livro, ou leva pro reader se já comprou
//   - descrição abaixo do título, com fallback se vier vazia do banco
//
// Recebe callbacks prontos da CampaignPage — não conhece checkout/login.

import type { Book } from '../domain/types'
import { ArrowRight } from 'lucide-react'

interface Props {
  book: Book
  onSelect: () => void
}

const FALLBACK_DESC = 'Clique em "Começar a Estudar" pra abrir este livro na sua biblioteca.'

export function CampaignCard({ book, onSelect }: Props) {
  const desc = book.description?.trim() || FALLBACK_DESC

  return (
    <article className="campaign-card" onClick={onSelect} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}
    >
      <div
        className="campaign-card-cover"
        style={{ backgroundImage: `url(${book.cover})` }}
        role="img"
        aria-label={`Capa do livro ${book.title}`}
      >
        <span className="campaign-card-pages">{book.totalPages} páginas</span>
      </div>
      <div className="campaign-card-body">
        <h3>{book.title}</h3>
        <div className="campaign-card-author">por {book.author || 'Autor não identificado'}</div>
        <p className="campaign-card-desc">{desc}</p>
        <button className="campaign-card-cta" onClick={(e) => { e.stopPropagation(); onSelect() }}>
          Começar a Estudar <ArrowRight size={14} />
        </button>
      </div>
    </article>
  )
}
