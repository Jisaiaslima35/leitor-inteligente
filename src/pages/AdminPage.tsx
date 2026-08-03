import { useEffect, useMemo, useState } from 'react'
import { RefreshCcw, ShoppingBag, Users, Library, Shield, ChevronUp, ChevronDown, Search, Trash2 } from 'lucide-react'
import type { Book, User } from '../domain/types'
import type { LibraryState, ProgressState } from '../domain/library'
import { ownsBook } from '../domain/library'
import { getProgress } from '../domain/progress'
import { supabase, SUPABASE_READY } from '../lib/supabase'

interface Props {
  library: LibraryState
  progress: ProgressState
  catalog: Book[]
  user: User
  onReset: () => void
}

interface ProfileRow {
  id: string
  email: string
  full_name: string | null
  role: 'user' | 'admin'
  created_at: string
  last_login_at: string | null
  deleted_at: string | null
}

interface PurchaseRow {
  id: string
  user_id: string
  ebook_id: string
  amount_cents: number
  currency: string
  payment_method: string | null
  status: 'pending' | 'paid' | 'refunded' | 'cancelled'
  created_at: string
  paid_at: string | null
}

function formatPrice(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function formatDate(iso?: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

type Tab = 'overview' | 'users' | 'purchases'

export function AdminPage({ library, progress, catalog, user, onReset }: Props) {
  const [tab, setTab] = useState<Tab>('overview')
  const [profiles, setProfiles] = useState<ProfileRow[]>([])
  const [purchases, setPurchases] = useState<PurchaseRow[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const isAdmin = profiles.some((p) => p.id === user.id && p.role === 'admin')

  const loadAll = async () => {
    if (!SUPABASE_READY) {
      setErr('Supabase não configurado (VITE_SUPABASE_URL ausente)')
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const [{ data: profs, error: e1 }, { data: purs, error: e2 }] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, email, full_name, role, created_at, last_login_at, deleted_at')
          .order('created_at', { ascending: false }),
        supabase
          .from('purchases')
          .select('id, user_id, ebook_id, amount_cents, currency, payment_method, status, created_at, paid_at')
          .order('created_at', { ascending: false })
          .limit(200),
      ])
      if (e1) throw new Error(`profiles: ${e1.message}`)
      if (e2) throw new Error(`purchases: ${e2.message}`)
      setProfiles((profs ?? []) as ProfileRow[])
      setPurchases((purs ?? []) as PurchaseRow[])
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAll()
  }, [])

  const filteredProfiles = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return profiles
    return profiles.filter(
      (p) =>
        (p.email ?? '').toLowerCase().includes(q) ||
        (p.full_name ?? '').toLowerCase().includes(q),
    )
  }, [profiles, query])

  const totals = useMemo(() => {
    const paid = purchases.filter((p) => p.status === 'paid')
    const revenue = paid.reduce((sum, p) => sum + p.amount_cents, 0)
    const pending = purchases.filter((p) => p.status === 'pending').length
    return {
      totalUsers: profiles.filter((p) => !p.deleted_at).length,
      totalPurchases: purchases.length,
      revenueCents: revenue,
      pending,
    }
  }, [profiles, purchases])

  const demoStats = useMemo(() => {
    const totalSales = library.purchases.length
    const revenue = library.purchases.reduce((sum, purchase) => {
      const book = catalog.find((item) => item.id === purchase.bookId)
      return sum + (book?.price ?? 0)
    }, 0)
    const readingNow = library.purchases.filter((purchase) =>
      getProgress(progress, purchase.userId, purchase.bookId),
    ).length
    return { totalSales, revenue, readingNow }
  }, [library, progress, catalog])

  const updateRole = async (id: string, role: 'user' | 'admin') => {
    setBusyId(id)
    const { error } = await supabase.from('profiles').update({ role, updated_at: new Date().toISOString() }).eq('id', id)
    if (error) setErr(error.message)
    await loadAll()
    setBusyId(null)
  }

  const softDelete = async (id: string) => {
    if (!confirm('Excluir (soft delete) este usuário? Pode reverter depois.')) return
    setBusyId(id)
    const { error } = await supabase
      .from('profiles')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
    if (error) setErr(error.message)
    await loadAll()
    setBusyId(null)
  }

  return (
    <section>
      <div className="section-title">
        <h2><Shield size={18} style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }} />Painel Admin</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={loadAll} disabled={loading}>
            <RefreshCcw size={16} /> {loading ? 'Carregando...' : 'Atualizar'}
          </button>
          <button className="btn btn-danger" onClick={onReset}>
            <RefreshCcw size={16} /> Reset demo
          </button>
        </div>
      </div>

      {!isAdmin && (
        <div className="kpi-card" style={{ marginBottom: 16, borderColor: 'var(--danger)' }}>
          <strong>Você não é admin no banco.</strong> As métricas reais abaixo só carregam quando seu user tem <code>role='admin'</code> em <code>public.profiles</code>.
        </div>
      )}

      {err && (
        <div className="kpi-card" style={{ marginBottom: 16, borderColor: 'var(--danger)', color: 'var(--danger)' }}>
          {err}
        </div>
      )}

      <nav style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['overview', 'users', 'purchases'] as Tab[]).map((t) => (
          <button
            key={t}
            className={`btn ${tab === t ? 'btn-primary' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'overview' && 'Visão geral'}
            {t === 'users' && `Usuários (${profiles.length})`}
            {t === 'purchases' && `Vendas (${purchases.length})`}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <>
          <div className="admin-grid">
            <div className="kpi-card">
              <div className="label"><Users size={14} style={{ display: 'inline', marginRight: 6 }} />Usuários ativos</div>
              <div className="value">{totals.totalUsers}</div>
              <small style={{ color: 'var(--muted)' }}>{user.email}</small>
            </div>
            <div className="kpi-card">
              <div className="label"><ShoppingBag size={14} style={{ display: 'inline', marginRight: 6 }} />Receita (pagas)</div>
              <div className="value">{formatPrice(totals.revenueCents)}</div>
              <small style={{ color: 'var(--muted)' }}>{totals.pending} pendentes</small>
            </div>
            <div className="kpi-card">
              <div className="label"><Library size={14} style={{ display: 'inline', marginRight: 6 }} />Catálogo</div>
              <div className="value">{catalog.length}</div>
              <small style={{ color: 'var(--muted)' }}>demo: {demoStats.totalSales} vendas simuladas</small>
            </div>
          </div>

          <div className="admin-table" style={{ marginTop: 24 }}>
            <h3 style={{ marginBottom: 12 }}>Catálogo (demo)</h3>
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
        </>
      )}

      {tab === 'users' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--muted)' }} />
              <input
                type="search"
                placeholder="Buscar por email ou nome..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{ width: '100%', padding: '8px 8px 8px 30px', borderRadius: 8, border: '1px solid var(--border)' }}
              />
            </div>
          </div>
          <div className="admin-table">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Nome</th>
                  <th>Role</th>
                  <th>Criado</th>
                  <th>Último login</th>
                  <th>Status</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {filteredProfiles.map((p) => (
                  <tr key={p.id} style={{ opacity: p.deleted_at ? 0.5 : 1 }}>
                    <td><code>{p.email}</code></td>
                    <td>{p.full_name || '—'}</td>
                    <td>
                      <span className={`badge ${p.role === 'admin' ? 'badge-admin' : 'badge-user'}`}>{p.role}</span>
                    </td>
                    <td>{formatDate(p.created_at)}</td>
                    <td>{formatDate(p.last_login_at)}</td>
                    <td>{p.deleted_at ? 'excluído' : 'ativo'}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn"
                        disabled={busyId === p.id || !!p.deleted_at}
                        onClick={() => updateRole(p.id, p.role === 'admin' ? 'user' : 'admin')}
                        title={p.role === 'admin' ? 'Rebaixar para user' : 'Promover para admin'}
                      >
                        {p.role === 'admin' ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                        {p.role === 'admin' ? 'rebaixar' : 'promover'}
                      </button>
                      <button
                        className="btn btn-danger"
                        disabled={busyId === p.id || !!p.deleted_at || p.id === user.id}
                        onClick={() => softDelete(p.id)}
                        title="Soft delete (reversível)"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'purchases' && (
        <div className="admin-table">
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>User</th>
                <th>Ebook</th>
                <th>Valor</th>
                <th>Método</th>
                <th>Status</th>
                <th>Pago em</th>
              </tr>
            </thead>
            <tbody>
              {purchases.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)' }}>Nenhuma venda registrada.</td></tr>
              )}
              {purchases.map((p) => {
                const buyer = profiles.find((pr) => pr.id === p.user_id)
                const book = catalog.find((b) => b.id === p.ebook_id)
                return (
                  <tr key={p.id}>
                    <td>{formatDate(p.created_at)}</td>
                    <td>{buyer?.email ?? <code>{p.user_id.slice(0, 8)}...</code>}</td>
                    <td>{book?.title ?? <code>{p.ebook_id.slice(0, 8)}...</code>}</td>
                    <td>{formatPrice(p.amount_cents)}</td>
                    <td>{p.payment_method ?? '—'}</td>
                    <td><span className={`badge badge-${p.status}`}>{p.status}</span></td>
                    <td>{formatDate(p.paid_at)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
