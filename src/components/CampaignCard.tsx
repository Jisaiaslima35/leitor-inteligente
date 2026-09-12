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
  // 11/09/2026: cover undefined ou vazio causava "Render error: Fu" porque
  // `url()` vazio quebra o React (invalid CSS value). Fallback: gradiente verde.
  const coverUrl = book.cover?.trim()
  const coverStyle = coverUrl
    ? { backgroundImage: `url("${coverUrl.replace(/"/g, '\\"')}")` }
    : { backgroundImage: 'linear-gradient(135deg, var(--brand), var(--brand-deep))' }
  const pages = book.totalPages ?? 0

  return (
    <article className="campaign-card" onClick={onSelect} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}
    >
      <div
        className="campaign-card-cover"
        style={coverStyle}
        role="img"
        aria-label={`Capa do livro ${book.title}`}
      >
        <span className="campaign-card-pages">{pages} páginas</span>
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
