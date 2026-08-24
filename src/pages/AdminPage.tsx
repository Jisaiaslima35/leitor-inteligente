import { useEffect, useMemo, useState } from 'react'
import { RefreshCcw, ShoppingBag, Users, Library, Shield, ChevronUp, ChevronDown, Search, Trash2, Upload, BookOpen, CheckCircle2, Circle, Pencil, X } from 'lucide-react'
import type { User, Categoria } from '../domain/types'
import { CATEGORIAS, CATEGORIA_LABEL } from '../domain/types'
import type { LibraryState, ProgressState } from '../domain/library'
import { ownsBook } from '../domain/library'
import { getProgress } from '../domain/progress'
import { supabase, SUPABASE_READY } from '../lib/supabase'
import { CampaignLinkButton } from '../components/CampaignLinkButton'
import { ADMIN_USER_ID, isAdminUser } from '../lib/admin'

const ADMIN_TOKEN = 'admin-bypass-leitor-2026'

interface Props {
  library: LibraryState
  progress: ProgressState
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

interface EbookRow {
  id: string
  slug: string
  title: string
  author: string | null
  cover_url: string | null
  price_cents: number
  is_published: boolean
  owner_user_id: string | null
  pdf_storage_path: string | null
  created_at: string
  // 23/08/2026: adicionado na migration categoria. Default 'outros' pra
  // livros antigos. Permite habilitar Sala Dev pra livros programacao.
  categoria: Categoria | null
}

function formatPrice(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function formatDate(iso?: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

type Tab = 'overview' | 'users' | 'purchases' | 'ebooks'

export function AdminPage({ library, progress, user, onReset }: Props) {
  const [tab, setTab] = useState<Tab>('overview')
  const [profiles, setProfiles] = useState<ProfileRow[]>([])
  const [purchases, setPurchases] = useState<PurchaseRow[]>([])
  const [myEbooks, setMyEbooks] = useState<EbookRow[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  // Upload admin
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadTitle, setUploadTitle] = useState('')
  const [uploadSlug, setUploadSlug] = useState('')
  const [uploadPrice, setUploadPrice] = useState('990')
  const [uploadPublishing, setUploadPublishing] = useState(true)
  const [uploadCategoria, setUploadCategoria] = useState<Categoria>('programacao')
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadMsg, setUploadMsg] = useState<string | null>(null)

  // Identificação do admin vem de src/lib/admin.ts (centralizada).
  const isAdmin = isAdminUser(user) || profiles.some((p) => p.id === user.id && p.role === 'admin')

  const loadAll = async () => {
    if (!SUPABASE_READY) {
      setErr('Supabase não configurado (VITE_SUPABASE_URL ausente)')
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const [{ data: profs, error: e1 }, { data: purs, error: e2 }, { data: ebooks, error: e3 }] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, email, full_name, role, created_at, last_login_at, deleted_at')
          .order('created_at', { ascending: false }),
        supabase
          .from('purchases')
          .select('id, user_id, ebook_id, amount_cents, currency, payment_method, status, created_at, paid_at')
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('ebooks')
          .select('id, slug, title, author, cover_url, price_cents, is_published, owner_user_id, pdf_storage_path, created_at, categoria')
          .eq('owner_user_id', ADMIN_USER_ID)
          .order('created_at', { ascending: false }),
      ])
      if (e1) throw new Error(`profiles: ${e1.message}`)
      if (e2) throw new Error(`purchases: ${e2.message}`)
      if (e3) throw new Error(`ebooks: ${e3.message}`)
      setProfiles((profs ?? []) as ProfileRow[])
      setPurchases((purs ?? []) as PurchaseRow[])
      setMyEbooks((ebooks ?? []) as EbookRow[])
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

  const togglePublished = async (ebook: EbookRow) => {
    setBusyId(ebook.id)
    const { error } = await supabase
      .from('ebooks')
      .update({ is_published: !ebook.is_published, updated_at: new Date().toISOString() })
      .eq('id', ebook.id)
    if (error) setErr(error.message)
    await loadAll()
    setBusyId(null)
  }

  const deleteEbook = async (ebook: EbookRow) => {
    if (!confirm(`Excluir "${ebook.title}"?\n\nIsso remove o livro, TODAS as vendas e liberações de biblioteca relacionadas, e apaga o PDF/capa do storage.\n\nEsta ação não pode ser desfeita.`)) return
    setBusyId(ebook.id)
    setErr(null)
    try {
      const resp = await fetch(
        `/leitor-inteligente/upload-api/api/admin/delete-book?ebook_id=${encodeURIComponent(ebook.id)}`,
        {
          method: 'DELETE',
          headers: { 'X-Admin-Token': ADMIN_TOKEN },
        },
      )
      const json = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        setErr(`❌ ${json.error || `HTTP ${resp.status}`}`)
      } else {
        setErr(null)
        alert(`✅ ${json.message || 'Livro removido.'}`)
      }
    } catch (e: any) {
      setErr(`❌ ${e?.message || 'Falha ao excluir'}`)
    } finally {
      await loadAll()
      setBusyId(null)
    }
  }

  // Modal de edição (título, slug, autor, preço, is_published, shareable).
  // Sem descrição por enquanto (Isaías msg 19/08: descrição fica pra depois).
  const [editing, setEditing] = useState<EbookRow | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editSlug, setEditSlug] = useState('')
  const [editAuthor, setEditAuthor] = useState('')
  const [editPrice, setEditPrice] = useState('')
  const [editPublished, setEditPublished] = useState(true)
  const [editShareable, setEditShareable] = useState(true)
  const [editCategoria, setEditCategoria] = useState<Categoria>('outros')
  const [editBusy, setEditBusy] = useState(false)

  const openEdit = (ebook: EbookRow) => {
    setEditing(ebook)
    setEditTitle(ebook.title)
    setEditSlug(ebook.slug)
    setEditAuthor(ebook.author || '')
    setEditPrice(String(ebook.price_cents))
    setEditPublished(ebook.is_published)
    setEditShareable(true) // default true; ebooks admin normalmente são compartilháveis
    setEditCategoria(ebook.categoria || 'outros')
    setErr(null)
  }
  const closeEdit = () => {
    if (editBusy) return
    setEditing(null)
  }
  const submitEdit = async () => {
    if (!editing) return
    setEditBusy(true)
    setErr(null)
    try {
      const resp = await fetch('/leitor-inteligente/upload-api/api/admin/update-book', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
        body: JSON.stringify({
          ebook_id: editing.id,
          title: editTitle.trim() || editing.title,
          slug: editSlug.trim() || editing.slug,
          author: editAuthor.trim() || null,
          price_cents: Math.max(0, parseInt(editPrice, 10) || 0),
          is_published: editPublished,
          shareable: editShareable,
          categoria: editCategoria,
        }),
      })
      const json = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        setErr(`❌ ${json.error || `HTTP ${resp.status}`}`)
      } else {
        setEditing(null)
      }
    } catch (e: any) {
      setErr(`❌ ${e?.message || 'Falha ao salvar'}`)
    } finally {
      setEditBusy(false)
      await loadAll()
    }
  }

  const submitAdminUpload = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isAdmin) {
      setUploadMsg('❌ Você não é admin.')
      return
    }
    if (!uploadFile || !uploadTitle || !uploadSlug) {
      setUploadMsg('❌ Preencha arquivo, título e slug.')
      return
    }
    setUploadBusy(true)
    setUploadMsg(null)
    try {
      const form = new FormData()
      form.append('file', uploadFile)
      form.append('title', uploadTitle)
      form.append('slug', uploadSlug)
      form.append('price_cents', uploadPrice || '0')
      form.append('is_published', String(uploadPublishing))
      form.append('categoria', uploadCategoria)
      form.append('admin_token', 'admin-bypass-leitor-2026')
      const resp = await fetch('/leitor-inteligente/upload-api/api/admin/upload-book', {
        method: 'POST',
        headers: { 'X-Admin-Token': 'admin-bypass-leitor-2026' },
        body: form,
      })
      const json = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        setUploadMsg(`❌ ${json.error || `HTTP ${resp.status}`}`)
      } else {
        setUploadMsg(`✅ Livro "${json.title}" criado (${json.slug}). ${json.indexed ? 'Indexado.' : 'Indexação em background.'}`)
        setUploadFile(null)
        setUploadTitle('')
        setUploadSlug('')
        setUploadPrice('990')
        await loadAll()
      }
    } catch (err: any) {
      setUploadMsg(`❌ ${err?.message || 'Falha no upload'}`)
    } finally {
      setUploadBusy(false)
    }
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

      <nav style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {(['overview', 'ebooks', 'users', 'purchases'] as Tab[]).map((t) => (
          <button
            key={t}
            className={`btn ${tab === t ? 'btn-primary' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'overview' && 'Visão geral'}
            {t === 'ebooks' && `Meus livros (${myEbooks.length})`}
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
              <div className="label"><Library size={14} style={{ display: 'inline', marginRight: 6 }} />Meu catálogo</div>
              <div className="value">{myEbooks.length}</div>
              <small style={{ color: 'var(--muted)' }}>
                {myEbooks.filter((b) => b.is_published).length} publicados
              </small>
            </div>
          </div>

          <div className="admin-table" style={{ marginTop: 24 }}>
            <h3 style={{ marginBottom: 12 }}>Vitrine ativa (publicados)</h3>
            <table>
              <thead>
                <tr>
                  <th>Livro</th>
                  <th>Status</th>
                  <th>Preço</th>
                  <th>Campanha</th>
                </tr>
              </thead>
              <tbody>
                {myEbooks.filter((b) => b.is_published).map((book) => (
                  <tr key={book.id}>
                    <td>{book.title}<br /><small style={{ color: 'var(--muted)' }}>{book.author || '—'}</small></td>
                    <td><CheckCircle2 size={14} style={{ display: 'inline', marginRight: 4, color: 'var(--accent)' }} />Publicado</td>
                    <td>{formatPrice(book.price_cents)}</td>
                    <td><CampaignLinkButton ebookSlug={book.slug} /></td>
                  </tr>
                ))}
                {myEbooks.filter((b) => b.is_published).length === 0 && (
                  <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)' }}>Nenhum ebook publicado. Use a aba "Meus livros" pra subir um.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'ebooks' && (
        <>
          {isAdmin && (
            <div className="kpi-card" style={{ marginBottom: 24 }}>
              <h3 style={{ marginTop: 0 }}>
                <Upload size={18} style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }} />
                Subir livro livre
              </h3>
              <p style={{ color: 'var(--muted)', marginTop: 4, fontSize: 14 }}>
                Upload administrativo — não passa por pagamento, vai direto pra sua Biblioteca e (se publicado) pra Loja/Início.
              </p>
              <form onSubmit={submitAdminUpload} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <small>PDF do livro</small>
                  <input
                    type="file"
                    accept="application/pdf"
                    onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                    disabled={uploadBusy}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <small>Título</small>
                  <input
                    type="text"
                    value={uploadTitle}
                    onChange={(e) => {
                      setUploadTitle(e.target.value)
                      if (!uploadSlug) {
                        // auto-gera slug do título
                        setUploadSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60))
                      }
                    }}
                    placeholder="O Pequeno Príncipe"
                    disabled={uploadBusy}
                    style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border)' }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <small>Slug (URL: /comprar/{uploadSlug || 'meu-livro'})</small>
                  <input
                    type="text"
                    value={uploadSlug}
                    onChange={(e) => setUploadSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))}
                    placeholder="meu-livro"
                    disabled={uploadBusy}
                    style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border)' }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <small>Preço (em centavos — 990 = R$ 9,90)</small>
                  <input
                    type="number"
                    min="0"
                    value={uploadPrice}
                    onChange={(e) => setUploadPrice(e.target.value)}
                    disabled={uploadBusy}
                    style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border)' }}
                  />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={uploadPublishing}
                    onChange={(e) => setUploadPublishing(e.target.checked)}
                    disabled={uploadBusy}
                  />
                  <small>Publicar imediatamente (aparece em Loja/Início)</small>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <small>Categoria (23/08: controla se Sala Dev aparece)</small>
                  <select
                    value={uploadCategoria}
                    onChange={(e) => setUploadCategoria(e.target.value as Categoria)}
                    disabled={uploadBusy}
                    style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)' }}
                  >
                    {CATEGORIAS.map(c => (
                      <option key={c} value={c}>{CATEGORIA_LABEL[c]}</option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="btn btn-primary" disabled={uploadBusy}>
                  {uploadBusy ? 'Enviando…' : 'Subir e publicar'}
                </button>
                {uploadMsg && (
                  <div style={{ padding: 8, borderRadius: 8, background: 'var(--bg-secondary)' }}>
                    {uploadMsg}
                  </div>
                )}
              </form>
            </div>
          )}

          <div className="admin-table">
            <h3 style={{ marginTop: 0, marginBottom: 12 }}>
              <BookOpen size={18} style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }} />
              Minha biblioteca de admin
            </h3>
            <table>
              <thead>
                <tr>
                  <th>Capa</th>
                  <th>Livro</th>
                  <th>Preço</th>
                  <th>Status</th>
                  <th>Criado</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {myEbooks.length === 0 && (
                  <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)' }}>Nenhum livro seu ainda. Use o formulário acima pra subir o primeiro.</td></tr>
                )}
                {myEbooks.map((book) => (
                  <tr key={book.id}>
                    <td style={{ width: 60 }}>
                      {book.cover_url ? (
                        <img src={book.cover_url} alt="" style={{ width: 50, height: 70, objectFit: 'cover', borderRadius: 4 }} />
                      ) : (
                        <div style={{ width: 50, height: 70, background: 'var(--bg-secondary)', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
                          <BookOpen size={18} />
                        </div>
                      )}
                    </td>
                    <td>
                      <strong>{book.title}</strong><br />
                      <small style={{ color: 'var(--muted)' }}>{book.author || '—'} • {book.slug}</small>
                    </td>
                    <td>{formatPrice(book.price_cents)}</td>
                    <td>
                      {book.is_published ? (
                        <span className="badge badge-admin">publicado</span>
                      ) : (
                        <span className="badge badge-user">rascunho</span>
                      )}
                    </td>
                    <td>{formatDate(book.created_at)}</td>
                    <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        className="btn"
                        disabled={busyId === book.id}
                        onClick={() => togglePublished(book)}
                        title={book.is_published ? 'Despublicar' : 'Publicar'}
                      >
                        {book.is_published ? <Circle size={14} /> : <CheckCircle2 size={14} />}
                        {book.is_published ? 'Despublicar' : 'Publicar'}
                      </button>
                      <button
                        className="btn"
                        disabled={busyId === book.id}
                        onClick={() => openEdit(book)}
                        title="Editar metadados (título, slug, autor, preço)"
                      >
                        <Pencil size={14} />
                        Editar
                      </button>
                      <CampaignLinkButton ebookSlug={book.slug} />
                      <button
                        className="btn btn-danger"
                        disabled={busyId === book.id}
                        onClick={() => deleteEbook(book)}
                        title="Excluir definitivamente"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
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
                const book = myEbooks.find((b) => b.id === p.ebook_id)
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

      {/* Modal de edição inline (sem descrição por enquanto, Isaías msg 19/08). */}
      {editing && (
        <div
          onClick={closeEdit}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--bg-primary)', borderRadius: 12, padding: 24,
              maxWidth: 480, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>
                <Pencil size={18} style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }} />
                Editar livro
              </h3>
              <button className="btn" onClick={closeEdit} disabled={editBusy}><X size={14} /></button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <small>Título</small>
                <input type="text" value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                  style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border)' }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <small>Slug</small>
                <input type="text" value={editSlug} onChange={(e) => setEditSlug(e.target.value)}
                  style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border)' }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <small>Autor</small>
                <input type="text" value={editAuthor} onChange={(e) => setEditAuthor(e.target.value)}
                  style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border)' }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <small>Preço (centavos — 990 = R$ 9,90)</small>
                <input type="number" min="0" value={editPrice} onChange={(e) => setEditPrice(e.target.value)}
                  style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border)' }} />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={editPublished} onChange={(e) => setEditPublished(e.target.checked)} />
                <small>Publicado (aparece em Loja/Início)</small>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={editShareable} onChange={(e) => setEditShareable(e.target.checked)} />
                <small>Compartilhável (link de campanha funciona)</small>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <small>Categoria (Sala Dev só abre se for Programação)</small>
                <select
                  value={editCategoria}
                  onChange={(e) => setEditCategoria(e.target.value as Categoria)}
                  style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)' }}
                >
                  {CATEGORIAS.map(c => (
                    <option key={c} value={c}>{CATEGORIA_LABEL[c]}</option>
                  ))}
                </select>
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={closeEdit} disabled={editBusy}>Cancelar</button>
              <button className="btn btn-primary" onClick={submitEdit} disabled={editBusy}>
                {editBusy ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
