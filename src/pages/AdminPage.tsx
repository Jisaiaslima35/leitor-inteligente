import { useMemo } from 'react'
import { RefreshCcw, ShoppingBag, Users, Library } from 'lucide-react'
import type { Book, User } from '../domain/types'
import type { LibraryState, ProgressState } from '../domain/library'
import { ownsBook } from '../domain/library'
import { getProgress } from '../domain/progress'

interface Props {
  library: LibraryState
  progress: ProgressState
  catalog: Book[]
  user: User
  onReset: () => void
}

function formatPrice(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function AdminPage({ library, progress, catalog, user, onReset }: Props) {
  const stats = useMemo(() => {
    const totalSales = library.purchases.length
    const revenue = library.purchases.reduce((sum, purchase) => {
      const book = catalog.find((item) => item.id === purchase.bookId)
      return sum + (book?.price ?? 0)
    }, 0)
    const readingNow = library.purchases.filter((purchase) => getProgress(progress, purchase.userId, purchase.bookId)).length
    return { totalSales, revenue, readingNow }
  }, [library, progress, catalog])

  return (
    <section>
      <div className="section-title">
        <h2>Painel Admin</h2>
        <button className="btn btn-danger" onClick={onReset}>
          <RefreshCcw size={16} /> Resetar biblioteca de testes
        </button>
      </div>

      <div className="admin-grid">
        <div className="kpi-card">
          <div className="label"><Users size={14} style={{ display: 'inline', marginRight: 6 }} />Usuário ativo</div>
          <div className="value">{user.name}</div>
          <small style={{ color: 'var(--muted)' }}>{user.email}</small>
        </div>
        <div className="kpi-card">
          <div className="label"><ShoppingBag size={14} style={{ display: 'inline', marginRight: 6 }} />Vendas (demo)</div>
          <div className="value">{stats.totalSales}</div>
          <small style={{ color: 'var(--muted)' }}>{formatPrice(stats.revenue)} em receita simulada</small>
        </div>
        <div className="kpi-card">
          <div className="label"><Library size={14} style={{ display: 'inline', marginRight: 6 }} />Leituras em andamento</div>
          <div className="value">{stats.readingNow}</div>
          <small style={{ color: 'var(--muted)' }}>{catalog.length} livros no catálogo</small>
        </div>
      </div>

      <div className="admin-table" style={{ marginTop: 24 }}>
        <table>
          <thead>
            <tr>
              <th>Livro</th>
              <th>Status</th>
              <th>Progresso</th>
              <th>Preço</th>
            </tr>
          </thead>
          <tbody>
            {catalog.map((book) => {
              const owned = ownsBook(library, 'demo-user', book.id)
              const item = getProgress(progress, 'demo-user', book.id)
              return (
                <tr key={book.id}>
                  <td>{book.title}<br /><small style={{ color: 'var(--muted)' }}>{book.author}</small></td>
                  <td>{owned ? 'Comprado' : 'Disponível'}</td>
                  <td>{item ? `${item.percent}% (p. ${item.page}/${item.totalPages})` : '—'}</td>
                  <td>{formatPrice(book.price)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}