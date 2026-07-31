import { useEffect, useState } from 'react'
import { LogIn, Mail, KeyRound, ArrowLeft, ShieldCheck } from 'lucide-react'
import { useAuth } from '../lib/AuthContext'

interface Props {
  onBack: () => void
  onSuccess?: () => void
}

type Mode = 'magic' | 'password'

export function LoginPage({ onBack, onSuccess }: Props) {
  const { signInWithMagicLink, signInWithPassword, signUpWithPassword, isAuthenticated } = useAuth()
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