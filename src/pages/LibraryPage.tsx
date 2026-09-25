import { useEffect, useState, useRef, useCallback } from 'react'
import { BookOpen, Upload, Trash2, Pencil, Circle, CheckCircle2, Plus, X, Code2, ArrowRight, RefreshCw } from 'lucide-react'
import type { Route } from '../App'
import type { ProgressState } from '../domain/library'
import { getProgress } from '../domain/progress'
import { useAuth } from '../lib/AuthContext'
import { useTenant } from '../lib/tenant'
import { supabase } from '../lib/supabase'
import { CategoriaRadioGroup, type CategoriaValue } from '../components/CategoriaRadioGroup'
import { CATEGORIA_LABEL, type Categoria } from '../domain/types'
import { BASE_URL } from '../lib/baseUrl'

interface Props {
  progress: ProgressState
  onNavigate: (route: Route, bookId?: string) => void
}

interface LibraryBook {
  id: string              // slug (bookId / catalog id)
  ebook_id: string        // uuid do ebooks row
  slug: string
  title: string
  author: string
  cover_url: string | null
  pdf_storage_path: string | null
  total_pages: number
  owner_user_id: string | null
  purchased_at: string | null
  payment_status: string
  is_global: boolean
  skill_generated: boolean
  is_published: boolean
  categoria: Categoria
  created_at?: string
}

export function LibraryPage({ progress, onNavigate }: Props) {
  // ─── 1. TODOS OS HOOKS NO TOPO ABSOLUTO (Rules of Hooks) ───────────────────
  const { user } = useAuth()
  const { tenant } = useTenant()
  const userId = user.id

  const [books, setBooks] = useState<LibraryBook[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [isOwnerOrAdmin, setIsOwnerOrAdmin] = useState(false)

  // Controle do formulário institucional de upload
  const [showUploadForm, setShowUploadForm] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadTitle, setUploadTitle] = useState('')
  const [uploadSlug, setUploadSlug] = useState('')
  const [uploadPublishing, setUploadPublishing] = useState(true)
  const [uploadCategoria, setUploadCategoria] = useState<CategoriaValue>('')
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadMsg, setUploadMsg] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Controle do modal de edição
  const [editingBook, setEditingBook] = useState<LibraryBook | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editSlug, setEditSlug] = useState('')
  const [editAuthor, setEditAuthor] = useState('')
  const [editPublished, setEditPublished] = useState(true)
  const [editCategoria, setEditCategoria] = useState<Categoria>('outros')
  const [editBusy, setEditBusy] = useState(false)

  // ─── 2. CARREGAMENTO DOS LIVROS DA BIBLIOTECA DO TENANT ────────────────────
  const loadLibrary = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // 0. Verifica se o usuário é dono ou admin deste tenant
      const email = (user?.email || '').toLowerCase().trim()
      let userIsOwnerOrAdmin =
        email === 'geminijose356@gmail.com' ||
        email.includes('brisacamera34') ||
        (!!tenant?.owner_user_id && tenant.owner_user_id === userId)

      if (!userIsOwnerOrAdmin && tenant?.id && userId) {
        try {
          const { data: member } = await supabase
            .from('user_tenants')
            .select('role')
            .eq('user_id', userId)
            .eq('tenant_id', tenant.id)
            .maybeSingle()

          if (member && (member.role === 'owner' || member.role === 'admin')) {
            userIsOwnerOrAdmin = true
          }
        } catch (err) {
          console.warn('[library] erro ao checar role:', err)
        }
      }
      setIsOwnerOrAdmin(userIsOwnerOrAdmin)

      // 1. Busca estritamente os livros da biblioteca pessoal do usuário
      let query = supabase
        .from('user_library')
        .select(`
          user_id, purchased_at, payment_status, tenant_id,
          ebooks!inner(
            ebook_id:id, slug, title, author, cover_url,
            pdf_storage_path, total_pages, owner_user_id,
            is_global, skill_generated, is_published, categoria, created_at
          )
        `)
        .eq('user_id', userId)

      if (tenant?.id && tenant.slug !== 'raiz') {
        query = query.eq('tenant_id', tenant.id)
      }

      const { data, error: e1 } = await query
        .order('purchased_at', { ascending: false, nullsFirst: false })

      if (e1) {
        console.warn('[library] aviso ao consultar user_library:', e1)
      }

      const map = new Map<string, LibraryBook>()

      for (const row of (data || []) as any[]) {
        const eb = row.ebooks
        if (!eb || !eb.slug) continue
        map.set(eb.ebook_id, {
          id: eb.slug,
          ebook_id: eb.ebook_id,
          slug: eb.slug,
          title: eb.title,
          author: eb.author || 'Autor desconhecido',
          cover_url: eb.cover_url,
          pdf_storage_path: eb.pdf_storage_path,
          total_pages: eb.total_pages || 0,
          owner_user_id: eb.owner_user_id,
          purchased_at: row.purchased_at,
          payment_status: row.payment_status,
          is_global: !!eb.is_global,
          skill_generated: !!eb.skill_generated,
          is_published: eb.is_published !== false,
          categoria: (eb.categoria as Categoria) || 'comum',
          created_at: eb.created_at || row.purchased_at,
        })
      }

      // 2. EXCLUSIVO PARA O DONO / SUPER ADMIN (role == 'owner'):
      // Visualiza a gestão dos livros cadastrados/subidos para o tenant
      if (userIsOwnerOrAdmin && tenant?.id && tenant.slug !== 'raiz') {
        const { data: tenantEbooks, error: e2 } = await supabase
          .from('ebooks')
          .select('id, slug, title, author, cover_url, pdf_storage_path, total_pages, owner_user_id, is_global, skill_generated, is_published, categoria, created_at')
          .eq('tenant_id', tenant.id)
          .order('created_at', { ascending: false })

        if (!e2 && tenantEbooks) {
          for (const eb of tenantEbooks as any[]) {
            if (!eb || !eb.id || map.has(eb.id)) continue
            map.set(eb.id, {
              id: eb.slug,
              ebook_id: eb.id,
              slug: eb.slug,
              title: eb.title,
              author: eb.author || 'Autor desconhecido',
              cover_url: eb.cover_url,
              pdf_storage_path: eb.pdf_storage_path,
              total_pages: eb.total_pages || 0,
              owner_user_id: eb.owner_user_id,
              purchased_at: eb.created_at,
              payment_status: 'institutional_owner',
              is_global: !!eb.is_global,
              skill_generated: !!eb.skill_generated,
              is_published: eb.is_published !== false,
              categoria: (eb.categoria as Categoria) || 'comum',
              created_at: eb.created_at,
            })
          }
        }
      }

      setBooks(Array.from(map.values()))
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [userId, tenant?.id, tenant?.slug, tenant?.owner_user_id, user?.email])

  useEffect(() => {
    loadLibrary()
  }, [loadLibrary])

  // ─── 3. SUBMISSÃO INSTITUCIONAL DE UPLOAD (SEM PREÇO) ──────────────────────
  const submitInstitutionalUpload = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!user || user.id === 'demo-user') {
      alert('Você precisa estar logado para enviar livros.')
      onNavigate('login')
      return
    }

    if (!uploadFile) {
      setUploadMsg('❌ Selecione um arquivo PDF.')
      return
    }

    if (!uploadTitle.trim() || !uploadSlug.trim()) {
      setUploadMsg('❌ Preencha título e slug do livro.')
      return
    }

    if (!uploadCategoria) {
      alert('Escolha a categoria do livro antes de subir.')
      setUploadMsg('❌ Categoria não selecionada.')
      return
    }

    setUploadBusy(true)
    setUploadProgress(0)
    setUploadMsg('Iniciando envio...')

    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (!token) throw new Error('Sessão expirada. Faça login novamente.')

      // 1. Gera signed URL para upload direto ao Storage
      const urlRes = await fetch(`${BASE_URL}upload-api/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ filename: uploadFile.name }),
      })
      if (!urlRes.ok) throw new Error(`Falha ao preparar upload: ${await urlRes.text()}`)
      const { upload_url, storage_path } = await urlRes.json()

      // 2. Upload do PDF via PUT com acompanhamento de progresso
      const xhr = new XMLHttpRequest()
      xhr.upload.addEventListener('progress', (ev) => {
        if (ev.lengthComputable) {
          const pct = Math.round((ev.loaded / ev.total) * 100)
          setUploadProgress(pct)
          setUploadMsg(`Enviando PDF... ${pct}%`)
        }
      })

      await new Promise((resolve, reject) => {
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve(true) : reject(new Error(`Erro HTTP ${xhr.status} no upload`))
        xhr.onerror = () => reject(new Error('Falha de conexão no upload do arquivo'))
        xhr.open('PUT', upload_url)
        xhr.setRequestHeader('Content-Type', uploadFile.type || 'application/octet-stream')
        xhr.send(uploadFile)
      })

      // 3. Processamento no backend (grava price_cents: 0 e vincula ao tenant)
      setUploadMsg('Registrando livro e segmentando páginas...')
      const procRes = await fetch(`${BASE_URL}upload-api/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          storage_path,
          title: uploadTitle.trim(),
          slug: uploadSlug.trim(),
          author: user.name || 'Institucional',
          is_published: uploadPublishing,
          categoria: uploadCategoria,
          tenant_id: tenant?.id,
          total_pages: 0,
        }),
      })

      if (!procRes.ok) throw new Error(`Falha ao processar livro: ${await procRes.text()}`)
      const proc = await procRes.json()

      setUploadMsg(`✅ Livro "${uploadTitle}" cadastrado com sucesso!`)
      setUploadFile(null)
      setUploadTitle('')
      setUploadSlug('')
      setUploadCategoria('')
      setUploadPublishing(true)
      setShowUploadForm(false)

      // Recarrega biblioteca imediatamente
      await loadLibrary()
      setTimeout(() => {
        loadLibrary()
      }, 1000)

      // Se for de programação, abre direto a Sala Dev ou Leitor
      const targetSlug = proc.slug || uploadSlug.trim()
      if (uploadCategoria === 'programacao' || uploadCategoria === 'tecnologia') {
        onNavigate('dev', targetSlug)
      }
    } catch (err: any) {
      setUploadMsg(`❌ ${err?.message || 'Falha no envio do livro'}`)
    } finally {
      setUploadBusy(false)
    }
  }

  // ─── 4. AÇÕES DE GESTÃO: PUBLICAR / EDITAR / EXCLUIR ───────────────────────
  const togglePublished = async (book: LibraryBook) => {
    if (!isOwnerOrAdmin) return
    setBusyId(book.ebook_id)
    try {
      const nextStatus = !book.is_published
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token

      const resp = await fetch(`${BASE_URL}upload-api/api/admin/update-book`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ebook_id: book.ebook_id,
          is_published: nextStatus,
        }),
      })

      if (!resp.ok) {
        // Fallback direto via Supabase se o backend retornar erro
        await supabase
          .from('ebooks')
          .update({ is_published: nextStatus, updated_at: new Date().toISOString() })
          .eq('id', book.ebook_id)
      }

      await loadLibrary()
    } catch (e: any) {
      alert(`Falha ao alterar publicação: ${e.message}`)
    } finally {
      setBusyId(null)
    }
  }

  const deleteEbook = async (book: LibraryBook) => {
    if (!isOwnerOrAdmin) return
    if (!confirm(`Excluir definitivamente o livro "${book.title}"?\n\nEsta ação removerá o livro da sua biblioteca e o arquivo associado.`)) return

    setBusyId(book.ebook_id)
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token

      const resp = await fetch(
        `${BASE_URL}upload-api/api/admin/delete-book?ebook_id=${encodeURIComponent(book.ebook_id)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        },
      )
      const json = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        throw new Error(json.error || `HTTP ${resp.status}`)
      }
      await loadLibrary()
    } catch (e: any) {
      alert(`Erro ao excluir livro: ${e?.message || e}`)
    } finally {
      setBusyId(null)
    }
  }

  const openEdit = (book: LibraryBook) => {
    if (!isOwnerOrAdmin) return
    setEditingBook(book)
    setEditTitle(book.title)
    setEditSlug(book.slug)
    setEditAuthor(book.author || '')
    setEditPublished(book.is_published)
    setEditCategoria(book.categoria || 'outros')
  }

  const closeEdit = () => {
    setEditingBook(null)
    setEditBusy(false)
  }

  const submitEdit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editingBook) return
    setEditBusy(true)

    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token

      const resp = await fetch(`${BASE_URL}upload-api/api/admin/update-book`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ebook_id: editingBook.ebook_id,
          title: editTitle.trim() || editingBook.title,
          slug: editSlug.trim() || editingBook.slug,
          author: editAuthor.trim() || null,
          price_cents: 0,
          is_published: editPublished,
          categoria: editCategoria,
        }),
      })

      if (!resp.ok) {
        // Fallback direto via Supabase se o endpoint admin exigir privilégios extras
        await supabase
          .from('ebooks')
          .update({
            title: editTitle.trim() || editingBook.title,
            slug: editSlug.trim() || editingBook.slug,
            author: editAuthor.trim() || null,
            price_cents: 0,
            is_published: editPublished,
            categoria: editCategoria,
            updated_at: new Date().toISOString(),
          })
          .eq('id', editingBook.ebook_id)
      }

      closeEdit()
      await loadLibrary()
    } catch (e: any) {
      alert(`Falha ao salvar edições: ${e.message}`)
    } finally {
      setEditBusy(false)
    }
  }

  const formatDate = (iso?: string | null) => {
    if (!iso) return '—'
    try {
      return new Date(iso).toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return '—'
    }
  }

  const getCategoriaBadge = (cat?: Categoria) => {
    if (cat === 'programacao') return '💻 Programação / Tecnologia'
    if (cat === 'tecnologia') return '💻 Tecnologia Geral'
    if (cat === 'gospel') return '✝️ Gospel / Cristão'
    if (cat === 'literatura') return '📖 Literatura / Ficção'
    if (cat === 'autoajuda') return '🌱 Autoajuda'
    if (cat === 'batalha-espiritual') return '⚔️ Batalha Espiritual'
    if (cat === 'casamento-familia') return '💍 Casamento & Família'
    if (cat === 'infantil') return '🧸 Infantil'
    return cat ? CATEGORIA_LABEL[cat] || cat : 'Geral'
  }

  // ─── 5. RENDERIZAÇÃO DA PÁGINA ─────────────────────────────────────────────
  return (
    <section style={{ maxWidth: 1100, margin: '0 auto', padding: '16px 0' }}>
      {/* Topo com título e botão de adicionar livro */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Minha Biblioteca</h2>
          <small style={{ color: 'var(--muted)' }}>
            {books.length} {books.length === 1 ? 'livro disponível' : 'livros disponíveis'}
          </small>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => loadLibrary()}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            title="Recarregar biblioteca"
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Atualizar
          </button>
          {isOwnerOrAdmin && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setShowUploadForm(!showUploadForm)}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              {showUploadForm ? <X size={16} /> : <Plus size={16} />}
              {showUploadForm ? 'Fechar formulário' : 'Subir livro'}
            </button>
          )}
        </div>
      </div>

      {/* FORMULÁRIO DE SUBMISSÃO INSTITUCIONAL (Inspirado no Admin, sem preços) */}
      {isOwnerOrAdmin && showUploadForm && (
        <div className="kpi-card" style={{ marginBottom: 28, border: '1px solid var(--border-hover, #475569)', padding: 24, borderRadius: 16 }}>
          <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Upload size={20} />
            Subir livro
          </h3>
          <p style={{ color: 'var(--muted)', marginTop: 4, fontSize: 14 }}>
            Upload institucional — vai direto para sua Biblioteca e (se publicado) fica acessível no acervo.
          </p>

          <form onSubmit={submitInstitutionalUpload} style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 16 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <small style={{ fontWeight: 600 }}>Arquivo do livro (.pdf, .epub, .mobi)</small>
              <input
                type="file"
                accept=".pdf,.epub,.mobi,application/pdf,application/epub+zip"
                onChange={(e) => {
                  const f = e.target.files?.[0] || null
                  setUploadFile(f)
                  if (f && !uploadTitle) {
                    const cleanName = f.name.replace(/\.(pdf|epub|mobi)$/i, '').trim()
                    setUploadTitle(cleanName)
                    setUploadSlug(cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60))
                  }
                }}
                disabled={uploadBusy}
                required
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <small style={{ fontWeight: 600 }}>Título</small>
              <input
                type="text"
                value={uploadTitle}
                onChange={(e) => {
                  setUploadTitle(e.target.value)
                  if (!uploadSlug) {
                    setUploadSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60))
                  }
                }}
                placeholder="Ex: Introdução à Programação com Python"
                disabled={uploadBusy}
                required
                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)' }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <small style={{ fontWeight: 600 }}>Slug (Identificador URL)</small>
              <input
                type="text"
                value={uploadSlug}
                onChange={(e) => setUploadSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))}
                placeholder="meu-livro"
                disabled={uploadBusy}
                required
                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)' }}
              />
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={uploadPublishing}
                onChange={(e) => setUploadPublishing(e.target.checked)}
                disabled={uploadBusy}
              />
              <small style={{ fontWeight: 500 }}>Publicar imediatamente (aparece no acervo da instituição)</small>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <CategoriaRadioGroup
                value={uploadCategoria}
                onChange={(v) => setUploadCategoria(v)}
                disabled={uploadBusy}
                label="Categoria (controla se a Sala Dev é ativada) — escolha obrigatória"
              />
            </label>

            {uploadBusy && (
              <div style={{ marginTop: 8 }}>
                <div style={{ width: '100%', height: 8, backgroundColor: 'var(--border, #334155)', borderRadius: 4, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${uploadProgress}%`,
                      height: '100%',
                      backgroundColor: '#22c55e',
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
              </div>
            )}

            {uploadMsg && (
              <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--bg-secondary, #1e293b)', fontSize: 14 }}>
                {uploadMsg}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={uploadBusy}>
                {uploadBusy ? 'Enviando e processando…' : 'Subir e publicar'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setShowUploadForm(false)}
                disabled={uploadBusy}
              >
                Cancelar
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ESTADOS DE CARREGAMENTO / ERRO */}
      {loading && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--muted)' }}>
          <p>Carregando livros da biblioteca...</p>
        </div>
      )}

      {error && (
        <div style={{ padding: 16, borderRadius: 8, backgroundColor: '#7f1d1d', color: '#fecaca', marginBottom: 20 }}>
          <p style={{ margin: 0 }}>Erro ao carregar acervo: {error}</p>
        </div>
      )}

      {/* ESTADO VAZIO */}
      {!loading && !error && books.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 20px', background: 'var(--bg-elev)', borderRadius: 16, border: '1px dashed var(--line)' }}>
          <BookOpen size={48} style={{ color: 'var(--muted)', margin: '0 auto 16px' }} />
          <h3 style={{ margin: '0 0 8px' }}>Sua biblioteca está vazia</h3>
          {isOwnerOrAdmin ? (
            <>
              <p style={{ color: 'var(--muted)', maxWidth: 440, margin: '0 auto 20px' }}>
                Nenhum livro cadastrado para esta instituição ainda.{' '}
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setShowUploadForm(true)}
                  style={{ textDecoration: 'underline', fontWeight: 600, color: 'var(--accent, #38bdf8)', padding: 0 }}
                >
                  Envie o seu PDF
                </button>{' '}
                para começar agora mesmo.
              </p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setShowUploadForm(true)}
              >
                <Plus size={16} style={{ marginRight: 6 }} />
                Cadastrar primeiro livro
              </button>
            </>
          ) : (
            <>
              <p style={{ color: 'var(--muted)', maxWidth: 440, margin: '0 auto 20px' }}>
                Você ainda não possui nenhum livro adicionado à sua biblioteca nesta instituição.
              </p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onNavigate('store')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <BookOpen size={16} />
                Explorar acervo de livros
              </button>
            </>
          )}
        </div>
      )}

      {/* TABELA DE GESTÃO INSTITUCIONAL (SEM PREÇO, SEM LINKS COMERCIAIS) */}
      {!loading && !error && books.length > 0 && (
        <div className="admin-table">
          <table>
            <thead>
              <tr>
                <th style={{ width: 60 }}>Capa</th>
                <th>Livro</th>
                {isOwnerOrAdmin && <th>Status</th>}
                {isOwnerOrAdmin && <th>Criado</th>}
                <th style={{ textAlign: 'right' }}>Ações</th>
              </tr>
            </thead>
            <tbody>
              {books.map((book) => {
                const item = getProgress(progress, userId, book.id)
                const isTech = book.categoria === 'programacao' || book.categoria === 'tecnologia'

                return (
                  <tr key={book.ebook_id}>
                    {/* Capa */}
                    <td style={{ width: 60 }}>
                      {book.cover_url ? (
                        <img
                          src={book.cover_url}
                          alt=""
                          style={{ width: 48, height: 68, objectFit: 'cover', borderRadius: 6, display: 'block' }}
                        />
                      ) : (
                        <div
                          style={{
                            width: 48,
                            height: 68,
                            background: 'var(--bg-secondary, #334155)',
                            borderRadius: 6,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--muted)',
                          }}
                        >
                          <BookOpen size={20} />
                        </div>
                      )}
                    </td>

                    {/* Informações do Livro */}
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: '0.98rem' }}>{book.title}</strong>
                        {isTech && (
                          <span
                            className="badge"
                            style={{ background: '#0369a1', color: '#e0f2fe', fontSize: 11, padding: '2px 6px', borderRadius: 4 }}
                          >
                            💻 Sala Dev
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.82rem', color: 'var(--muted)', marginTop: 2 }}>
                        {book.author} • <code style={{ fontSize: 11 }}>{book.slug}</code>
                      </div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: 4 }}>
                        Categoria: <strong>{getCategoriaBadge(book.categoria)}</strong>
                        {item && item.percent > 0 && (
                          <span style={{ marginLeft: 8, color: 'var(--accent, #38bdf8)' }}>
                            • Progresso: {item.percent}% (pág. {item.page})
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Status de Publicação (Apenas Dono/Admin) */}
                    {isOwnerOrAdmin && (
                      <td>
                        {book.is_published ? (
                          <span className="badge badge-admin" style={{ padding: '3px 8px', borderRadius: 6 }}>
                            publicado
                          </span>
                        ) : (
                          <span className="badge badge-user" style={{ padding: '3px 8px', borderRadius: 6, background: '#64748b' }}>
                            rascunho
                          </span>
                        )}
                      </td>
                    )}

                    {/* Data de Criação (Apenas Dono/Admin) */}
                    {isOwnerOrAdmin && (
                      <td style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                        {formatDate(book.created_at)}
                      </td>
                    )}

                    {/* Ações Institucionais */}
                    <td>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        {/* Botão de Leitura Padrão */}
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => onNavigate('reader', book.slug || book.id)}
                          style={{ padding: '6px 12px', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 4 }}
                          title="Abrir no leitor interativo"
                        >
                          <BookOpen size={14} />
                          {item && item.percent > 0 ? 'Continuar' : 'Ler'}
                        </button>

                        {/* Botão Direto para a Sala Dev se for de Tecnologia / Programação */}
                        {isTech && (
                          <button
                            type="button"
                            className="btn"
                            onClick={() => onNavigate('dev', book.slug || book.id)}
                            style={{
                              padding: '6px 10px',
                              fontSize: '0.85rem',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 4,
                              background: '#0f766e',
                              color: '#f0fdfa',
                              border: 'none',
                            }}
                            title="Abrir Sala Dev com código, terminal vivo e mentor"
                          >
                            <Code2 size={14} />
                            Sala Dev
                          </button>
                        )}

                        {/* Botões Administrativos: apenas Dono / Admin */}
                        {isOwnerOrAdmin && (
                          <>
                            {/* Publicar / Despublicar */}
                            <button
                              type="button"
                              className="btn"
                              disabled={busyId === book.ebook_id}
                              onClick={() => togglePublished(book)}
                              style={{ padding: '6px 10px', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 4 }}
                              title={book.is_published ? 'Tornar rascunho' : 'Publicar livro'}
                            >
                              {book.is_published ? <Circle size={14} /> : <CheckCircle2 size={14} />}
                              {book.is_published ? 'Despublicar' : 'Publicar'}
                            </button>

                            {/* Editar */}
                            <button
                              type="button"
                              className="btn"
                              disabled={busyId === book.ebook_id}
                              onClick={() => openEdit(book)}
                              style={{ padding: '6px 10px', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 4 }}
                              title="Editar metadados"
                            >
                              <Pencil size={14} />
                              Editar
                            </button>

                            {/* Excluir (Lixeira) */}
                            <button
                              type="button"
                              className="btn btn-danger"
                              disabled={busyId === book.ebook_id}
                              onClick={() => deleteEbook(book)}
                              style={{ padding: '6px 10px' }}
                              title="Excluir livro definitivamente"
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* MODAL DE EDIÇÃO INSTITUCIONAL (SEM PREÇO) */}
      {editingBook && isOwnerOrAdmin && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99999,
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !editBusy) closeEdit()
          }}
        >
          <div
            className="kpi-card"
            style={{
              width: '100%',
              maxWidth: 540,
              backgroundColor: 'var(--bg-elev, #1e293b)',
              borderRadius: 16,
              border: '1px solid var(--border)',
              padding: 24,
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Pencil size={18} />
                Editar livro
              </h3>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={closeEdit}
                disabled={editBusy}
                style={{ padding: 4 }}
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={submitEdit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <small style={{ fontWeight: 600 }}>Título</small>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  disabled={editBusy}
                  required
                  style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)' }}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <small style={{ fontWeight: 600 }}>Slug</small>
                <input
                  type="text"
                  value={editSlug}
                  onChange={(e) => setEditSlug(e.target.value)}
                  disabled={editBusy}
                  required
                  style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)' }}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <small style={{ fontWeight: 600 }}>Autor</small>
                <input
                  type="text"
                  value={editAuthor}
                  onChange={(e) => setEditAuthor(e.target.value)}
                  disabled={editBusy}
                  style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)' }}
                />
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={editPublished}
                  onChange={(e) => setEditPublished(e.target.checked)}
                  disabled={editBusy}
                />
                <small style={{ fontWeight: 500 }}>Publicado (visível no catálogo do tenant)</small>
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <CategoriaRadioGroup
                  value={editCategoria}
                  onChange={(v) => setEditCategoria((v as Categoria) || 'outros')}
                  disabled={editBusy}
                  label="Categoria (controla se a Sala Dev é ativada)"
                  compact
                />
              </label>

              <div style={{ display: 'flex', gap: 10, marginTop: 12, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={closeEdit}
                  disabled={editBusy}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={editBusy}
                >
                  {editBusy ? 'Salvando…' : 'Salvar alterações'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  )
}
