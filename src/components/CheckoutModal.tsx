import { X, ShoppingCart } from 'lucide-react'
import type { Book } from '../domain/types'
import type { User } from '../domain/types'

interface Props {
  book: Book
  user: User
  onCancel: () => void
  onConfirm: () => void
}

function formatPrice(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function CheckoutModal({ book, user, onCancel, onConfirm }: Props) {
  return (
    <div className="checkout-modal" role="dialog" aria-modal="true">
      <div className="panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>Confirmar compra</h3>
          <button className="icon-btn" onClick={onCancel} aria-label="Fechar"><X size={18} /></button>
        </div>
        <p style={{ color: 'var(--muted)', margin: '4px 0 0' }}>
          Você está prestes a comprar o livro digital. Após a confirmação, ele entra na sua biblioteca e o progresso fica salvo neste dispositivo.
        </p>
        <div className="summary">
          <div className="row">
            <span>Livro</span>
            <strong>{book.title}</strong>
          </div>
          <div className="row">
            <span>Cliente</span>
            <span>{user.name}</span>
          </div>
          <div className="row total">
            <span>Total</span>
            <span>{formatPrice(book.price)}</span>
          </div>
        </div>
        <div className="actions">
          <button className="btn btn-ghost" onClick={onCancel}>Cancelar</button>
          <button className="btn btn-primary" onClick={onConfirm}>
            <ShoppingCart size={16} /> Pagar e ler agora
          </button>
        </div>
      </div>
    </div>
  )
}