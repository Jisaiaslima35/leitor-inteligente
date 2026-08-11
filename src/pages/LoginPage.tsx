import { useEffect, useState } from 'react'
import { LogIn, Mail, KeyRound, ArrowLeft, ShieldCheck } from 'lucide-react'
import { useAuth } from '../lib/AuthContext'

interface Props {
  onBack: () => void
  onSuccess?: () => void
}

type Mode = 'magic' | 'password'

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.614z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.583-5.036-3.71H.957v2.332A8.997 8.997 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
    </svg>
  )
}

export function LoginPage({ onBack, onSuccess }: Props) {
  const { signInWithMagicLink, signInWithPassword, signUpWithPassword, signInWithGoogle, isAuthenticated } = useAuth()
  const [mode, setMode] = useState<Mode>('magic')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [isSignup, setIsSignup] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // Redireciona automaticamente quando autentica com sucesso
  useEffect(() => {
    if (isAuthenticated && onSuccess) onSuccess()
  }, [isAuthenticated, onSuccess])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim()) {
      setMessage({ kind: 'err', text: 'Informe seu e-mail' })
      return
    }
    setSubmitting(true)
    setMessage(null)
    try {
      if (mode === 'magic') {
        const r = await signInWithMagicLink(email.trim())
        setMessage(
          r.ok
            ? { kind: 'ok', text: `Link mágico enviado para ${email}. Confira sua caixa de entrada.` }
            : { kind: 'err', text: r.error ?? 'Falha ao enviar link' },
        )
      } else if (isSignup) {
        if (password.length < 6) {
          setMessage({ kind: 'err', text: 'A senha precisa ter pelo menos 6 caracteres' })
          return
        }
        const r = await signUpWithPassword(email.trim(), password, name.trim() || undefined)
        if (r.ok) {
          if (r.needsConfirmation) {
            setMessage({ kind: 'ok', text: `Conta criada! Confirme no e-mail ${email} pra ativar.` })
          } else {
            setMessage({ kind: 'ok', text: 'Conta criada e logado!' })
          }
        } else {
          setMessage({ kind: 'err', text: r.error ?? 'Falha ao cadastrar' })
        }
      } else {
        const r = await signInWithPassword(email.trim(), password)
        setMessage(r.ok ? { kind: 'ok', text: 'Logado!' } : { kind: 'err', text: r.error ?? 'Falha ao entrar' })
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-shell">
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={16} /> voltar
      </button>
      <div className="auth-card">
        <div className="auth-head">
          <div className="auth-mark"><LogIn size={22} /></div>
          <h1>Entrar na sua conta</h1>
          <p>Salve seu progresso de leitura e compre livros pelo seu usuário.</p>
        </div>

        <button
          type="button"
          className="btn-google"
          onClick={async () => {
            setSubmitting(true)
            setMessage(null)
            const r = await signInWithGoogle()
            if (!r.ok) setMessage({ kind: 'err', text: r.error ?? 'Falha ao entrar com Google' })
            setSubmitting(false)
          }}
          disabled={submitting}
        >
          <GoogleIcon /> Entrar com Google
        </button>

        <div className="auth-divider">
          <span>ou use e-mail</span>
        </div>

        <div className="auth-modes" role="tablist">
          <button
            role="tab"
            aria-selected={mode === 'magic'}
            className={`mode-tab ${mode === 'magic' ? 'is-active' : ''}`}
            onClick={() => { setMode('magic'); setIsSignup(false) }}
          >
            <Mail size={14} /> Link mágico
          </button>
          <button
            role="tab"
            aria-selected={mode === 'password'}
            className={`mode-tab ${mode === 'password' ? 'is-active' : ''}`}
            onClick={() => setMode('password')}
          >
            <KeyRound size={14} /> Senha
          </button>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          {mode === 'password' && isSignup && (
            <label className="field">
              <span>Nome</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Como você quer ser chamado"
                autoComplete="name"
              />
            </label>
          )}
          <label className="field">
            <span>E-mail</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seu@email.com"
              autoComplete="email"
              required
            />
          </label>
          {mode === 'password' && (
            <label className="field">
              <span>Senha</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="mínimo 6 caracteres"
                autoComplete={isSignup ? 'new-password' : 'current-password'}
                required
              />
            </label>
          )}

          {message && (
            <div className={`auth-msg auth-msg-${message.kind}`}>{message.text}</div>
          )}

          <button className="btn-primary" type="submit" disabled={submitting}>
            {submitting
              ? 'Enviando...'
              : mode === 'magic'
              ? 'Enviar link mágico'
              : isSignup
              ? 'Criar conta'
              : 'Entrar'}
          </button>
        </form>

        {mode === 'password' && (
          <button className="switch-mode" onClick={() => setIsSignup(!isSignup)}>
            {isSignup ? 'Já tem conta? Entrar' : 'Ainda não tem conta? Cadastrar'}
          </button>
        )}

        <div className="auth-foot">
          <ShieldCheck size={14} />
          <span>Autenticação gerenciada pelo Supabase — sem senha armazenada no app.</span>
        </div>
      </div>
    </div>
  )
}