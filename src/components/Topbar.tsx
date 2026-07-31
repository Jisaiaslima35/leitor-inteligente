import { useEffect, useState } from 'react'
import { BookOpen, Library, Sparkles, ShoppingBag, Shield, LogIn, LogOut, Flame, Upload } from 'lucide-react'
import type { Route } from '../App'
import type { User } from '../domain/types'
import { fetchStreak, type Streak } from '../lib/streak'

const TABS: { id: Route; label: string; icon: typeof BookOpen }[] = [
  { id: 'home', label: 'Início', icon: Sparkles },
  { id: 'store', label: 'Loja', icon: ShoppingBag },
  { id: 'library', label: 'Biblioteca', icon: Library },
  { id: 'admin', label: 'Admin', icon: Shield },
]

interface Props {
  route: Route
  onNavigate: (route: Route, bookId?: string) => void
  user: User
  isAuthenticated: boolean
  onSignOut: () => void
}

export function Topbar({ route, onNavigate, user, isAuthenticated, onSignOut }: Props) {
  const [streak, setStreak] = useState<Streak | null>(null)

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

  const streakBadge = streak && streak.current_streak >= 1 ? (
    <span
      className="streak-badge"
      title={`Streak atual: ${streak.current_streak} dias | Recorde: ${streak.best_streak} dias`}
    >
      <Flame size={14} />
      <span>{streak.current_streak}</span>
    </span>
  ) : null

  return (
    <header className="topbar">
      <div className="brand" onClick={() => onNavigate('home')} role="button">
        <span className="brand-mark">L</span>
        <span>Leitor Inteligente</span>
      </div>
      <nav className="nav-tabs" aria-label="Navegação principal">
        {TABS.map((tab) => {
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
      </nav>
      <div className="user-area">
        {isAuthenticated ? (
          <>
            {streakBadge}
            <button
              className="icon-btn"
              onClick={() => onNavigate('upload')}
              title="Enviar meu livro"
            >
              <Upload size={16} />
              <span className="label">Enviar</span>
            </button>
            <span className="user-name">Olá, {user.name.split(' ')[0]}</span>
            <button className="icon-btn" onClick={onSignOut} title="Sair">
              <LogOut size={16} />
              <span className="label">Sair</span>
            </button>
          </>
        ) : (
          <button className="icon-btn primary" onClick={() => onNavigate('login')} title="Entrar">
            <LogIn size={16} />
            <span className="label">Entrar</span>
          </button>
        )}
      </div>
    </header>
  )
}