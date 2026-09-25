import { useEffect, useState } from 'react'
import { BookOpen, Library, Sparkles, ShoppingBag, Shield, LogIn, LogOut, Flame, Upload, Megaphone, ChevronDown, Building2, GraduationCap } from 'lucide-react'
import type { Route } from '../App'
import type { User } from '../domain/types'
import { fetchStreak, type Streak } from '../lib/streak'
import { isAdminEmail, isAdminUser } from '../lib/admin'
import { CAMPANHAS } from '../data/campaigns'
import { useTenant, type TenantEdition } from '../lib/tenant'
import { CreateTenantModal } from './CreateTenantModal'
import { supabase } from '../lib/supabase'

const TABS: { id: Route; label: string; icon: typeof BookOpen }[] = [
  { id: 'home', label: 'Início', icon: Sparkles },
  { id: 'store', label: 'Loja', icon: ShoppingBag },
  { id: 'library', label: 'Biblioteca', icon: Library },
  { id: 'admin', label: 'Admin', icon: Shield },
]

const EMBED_TABS: { id: Route; label: string; icon: typeof BookOpen }[] = [
  { id: 'library', label: 'Minha Biblioteca', icon: Library },
  { id: 'store', label: 'Loja de Livros', icon: ShoppingBag },
]

interface Props {
  route: Route
  onNavigate: (route: Route, bookId?: string) => void
  user: User
  isAuthenticated: boolean
  onSignOut: () => void
}

export function Topbar({ route, onNavigate, user, isAuthenticated, onSignOut }: Props) {
  const { tenant, isEmbed } = useTenant()
  const [streak, setStreak] = useState<Streak | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // 11/09/2026 (v19 — campanhas): dropdown "Campanhas" no nav-tabs.
  const [campaignsOpen, setCampaignsOpen] = useState(false)
  // 23/09/2026 (B2B): dropdown "Soluções Institucionais" e modal de criação de tenant
  const [b2bOpen, setB2bOpen] = useState(false)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [selectedEdition, setSelectedEdition] = useState<TenantEdition>('radio_embed')
  const [selectedCategoryName, setSelectedCategoryName] = useState('Web Rádios')

  const openCreateModal = (ed: TenantEdition, cat: string) => {
    setSelectedEdition(ed)
    setSelectedCategoryName(cat)
    setCreateModalOpen(true)
  }

  useEffect(() => {
    if (!isAuthenticated) {
      setStreak(null)
      return
    }
    let cancelled = false
    fetchStreak().then((s) => {
      if (!cancelled) setStreak(s)
    })
    // Recarrega a cada 60s pra pegar mudanças (ex: usuário acabou de ler)
    const t = setInterval(() => {
      fetchStreak().then((s) => {
        if (!cancelled) setStreak(s)
      })
    }, 60000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [isAuthenticated, user.id])

  // Fecha o menu ao clicar fora
  useEffect(() => {
    if (!menuOpen && !campaignsOpen && !b2bOpen) return
    const onDocClick = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null
      if (!target) return
      if (target.closest('.user-menu')) return
      if (target.closest('.campaigns-menu')) return
      if (target.closest('.b2b-menu')) return
      setMenuOpen(false)
      setCampaignsOpen(false)
      setB2bOpen(false)
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [menuOpen, campaignsOpen, b2bOpen])

  const streakBadge = streak && streak.current_streak >= 1 ? (
    <span
      className="streak-badge"
      title={`Streak atual: ${streak.current_streak} dias | Recorde: ${streak.best_streak} dias`}
    >
      <Flame size={14} />
      <span>{streak.current_streak}</span>
    </span>
  ) : null

  const firstName = (user.name || user.email || 'Você').split(' ')[0]

  // 05/09/2026 (v8 Isaías): aba 🛡️ Admin SÓ aparece pro admin.
  // Usuários comuns NÃO devem nem ver a aba.
  const isAdmin = isAdminEmail(user.email) || isAdminUser(user)
  const [hasTenantAcademicPermission, setHasTenantAcademicPermission] = useState(false)

  const emailLower = (user?.email || '').toLowerCase().trim()
  const isGlobalAdmin = isAuthenticated && (
    emailLower === 'geminijose356@gmail.com' ||
    emailLower.includes('brisacamera34') ||
    isAdminEmail(user?.email) ||
    isAdminUser(user)
  )
  const isTenantOwner = isAuthenticated && !!tenant?.owner_user_id && tenant.owner_user_id === user?.id
  const isSchool = tenant?.type === 'school' || tenant?.edition === 'academic_premium' || tenant?.edition === 'school'

  useEffect(() => {
    if (!isAuthenticated || !user?.id || !tenant?.id || isGlobalAdmin || isTenantOwner) {
      setHasTenantAcademicPermission(false)
      return
    }

    let cancelled = false
    supabase
      .from('user_tenants')
      .select('role')
      .eq('user_id', user.id)
      .eq('tenant_id', tenant.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data && (data.role === 'owner' || data.role === 'admin')) {
          setHasTenantAcademicPermission(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [isAuthenticated, user?.id, tenant?.id, isGlobalAdmin, isTenantOwner])

  const canAccessAcademic =
    isAuthenticated &&
    isSchool &&
    (isGlobalAdmin || isTenantOwner || hasTenantAcademicPermission)

  const academicTab = { id: 'academic' as Route, label: 'Painel Acadêmico', icon: GraduationCap }

  const standardTabs = TABS.filter((tab) => tab.id !== 'admin' || isAdmin)
  let baseTabs = isEmbed ? [...EMBED_TABS] : [...standardTabs]
  if (canAccessAcademic && !baseTabs.some((t) => t.id === 'academic')) {
    baseTabs.push(academicTab)
  }
  const visibleTabs = baseTabs

  // Customização de Marca (Tenant theme)
  const brandTitle =
    tenant?.theme?.brand_name ||
    (tenant && tenant.slug !== 'raiz' ? tenant.name : 'Leitor Inteligente')
  const brandInitial = brandTitle.charAt(0).toUpperCase() || 'L'

  return (
    <header className="topbar">
      <div
        className="brand"
        onClick={() => onNavigate(isEmbed ? 'library' : 'home')}
        role="button"
        style={{ cursor: 'pointer' }}
      >
        {tenant?.theme?.logo_url ? (
          <img
            src={tenant.theme.logo_url}
            alt={brandTitle}
            style={{ height: 28, maxWidth: 120, objectFit: 'contain', marginRight: 8 }}
          />
        ) : (
          <span className="brand-mark">{brandInitial}</span>
        )}
        <span>{brandTitle}</span>
      </div>
      <nav className="nav-tabs" aria-label="Navegação principal">
        {visibleTabs.map((tab) => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              className={`nav-tab ${route === tab.id ? 'is-active' : ''}`}
              onClick={() => onNavigate(tab.id)}
              aria-current={route === tab.id ? 'page' : undefined}
            >
              <Icon size={16} />
              <span className="label">{tab.label}</span>
            </button>
          )
        })}
        {/* Campanhas: apenas fora do modo embed */}
        {!isEmbed && (
          <div className={`campaigns-menu ${campaignsOpen ? 'is-open' : ''}`}>
            <button
              type="button"
              className={`nav-tab ${route === 'campaign' ? 'is-active' : ''}`}
              onClick={() => setCampaignsOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={campaignsOpen}
            >
              <Megaphone size={16} />
              <span className="label">Campanhas</span>
              <ChevronDown size={12} className={`campaigns-caret ${campaignsOpen ? 'is-open' : ''}`} />
            </button>
            {campaignsOpen && (
              <div className="campaigns-menu-panel" role="menu">
                {CAMPANHAS.map((c) => (
                  <button
                    key={c.slug}
                    type="button"
                    className="campaigns-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setCampaignsOpen(false)
                      window.location.hash = `#/tema/${encodeURIComponent(c.slug)}`
                    }}
                  >
                    <span className="campaigns-menu-item-title">{c.badge.replace('COLEÇÃO ESPECIAL: ', '')}</span>
                    <span className="campaigns-menu-item-desc">{c.descricao.slice(0, 70)}…</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {/* 23/09/2026: Vitrine B2B / Institucional (apenas no Leitor Raiz e fora do modo embed) */}
        {!isEmbed && tenant?.slug === 'raiz' && (
          <div className={`campaigns-menu b2b-menu ${b2bOpen ? 'is-open' : ''}`}>
            <button
              type="button"
              className="nav-tab"
              onClick={() => setB2bOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={b2bOpen}
              style={{ color: '#38bdf8', fontWeight: 500 }}
            >
              <Building2 size={16} />
              <span className="label">Soluções Institucionais</span>
              <ChevronDown size={12} className={`campaigns-caret ${b2bOpen ? 'is-open' : ''}`} />
            </button>
            {b2bOpen && (
              <div className="campaigns-menu-panel" role="menu" style={{ minWidth: 260 }}>
                <button
                  type="button"
                  className="campaigns-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setB2bOpen(false)
                    openCreateModal('radio_embed', 'Web Rádios')
                  }}
                >
                  <span className="campaigns-menu-item-title">📻 Web Rádios</span>
                  <span className="campaigns-menu-item-desc">Áudio ao vivo + Leitor embed para o site da sua emissora.</span>
                </button>
                <button
                  type="button"
                  className="campaigns-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setB2bOpen(false)
                    openCreateModal('academic_premium', 'Escolas & Faculdades')
                  }}
                >
                  <span className="campaigns-menu-item-title">🎓 Escolas & Faculdades</span>
                  <span className="campaigns-menu-item-desc">Portal acadêmico, turmas, notas e IA para professores.</span>
                </button>
                <button
                  type="button"
                  className="campaigns-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setB2bOpen(false)
                    openCreateModal('radio_embed', 'Igrejas & Comunidades')
                  }}
                >
                  <span className="campaigns-menu-item-title">⛪ Igrejas & Comunidades</span>
                  <span className="campaigns-menu-item-desc">Acervo devocional, estudos bíblicos e transmissão própria.</span>
                </button>
                <div style={{ borderTop: '1px solid #334155', margin: '6px 0' }} />
                <button
                  type="button"
                  className="campaigns-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setB2bOpen(false)
                    openCreateModal('radio_embed', 'Geral')
                  }}
                  style={{ color: '#38bdf8' }}
                >
                  <span className="campaigns-menu-item-title">🚀 Criar Meu Leitor</span>
                  <span className="campaigns-menu-item-desc">Cadastre sua instituição e gere o código embed.</span>
                </button>
              </div>
            )}
          </div>
        )}
      </nav>
      <div className="user-area">
        {isAuthenticated ? (
          <>
            {streakBadge}
            {!isEmbed && (
              <button
                className="icon-btn"
                onClick={() => onNavigate('upload')}
                title="Enviar meu livro"
                aria-label="Enviar meu livro"
              >
                <Upload size={16} />
                <span className="label">Enviar</span>
              </button>
            )}
            <div className={`user-menu ${menuOpen ? 'is-open' : ''}`}>
              <button
                type="button"
                className="user-name"
                title={user.email}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                Olá, {firstName}
                <span className="user-caret" aria-hidden="true">▾</span>
              </button>
              {menuOpen && (
                <div className="user-menu-panel" role="menu">
                  <div className="user-menu-row">
                    <span className="user-menu-label">Usuário</span>
                    <span className="user-menu-value">{user.name || '—'}</span>
                  </div>
                  <div className="user-menu-row">
                    <span className="user-menu-label">E-mail</span>
                    <span className="user-menu-value user-menu-email">{user.email}</span>
                  </div>
                  <button
                    type="button"
                    className="user-menu-signout"
                    onClick={() => {
                      setMenuOpen(false)
                      onSignOut()
                    }}
                    role="menuitem"
                  >
                    <LogOut size={14} /> Sair
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <button className="icon-btn primary" onClick={() => onNavigate('login')} title="Entrar">
            <LogIn size={16} />
            <span className="label">Entrar</span>
          </button>
        )}
      </div>
      <CreateTenantModal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onGoLogin={() => {
          setCreateModalOpen(false)
          onNavigate('login')
        }}
        initialEdition={selectedEdition}
        initialCategoryName={selectedCategoryName}
      />
    </header>
  )
}