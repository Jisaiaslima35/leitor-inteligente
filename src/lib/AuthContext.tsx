import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session, User as SupabaseUser } from '@supabase/supabase-js'
import { supabase, SUPABASE_READY } from './supabase'
import type { User } from '../domain/types'
import { DEFAULT_USER } from '../domain/types'

interface AuthContextValue {
  user: User
  session: Session | null
  supabaseUser: SupabaseUser | null
  isAuthenticated: boolean
  isReady: boolean
  signInWithMagicLink: (email: string) => Promise<{ ok: boolean; error?: string }>
  signInWithPassword: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>
  signUpWithPassword: (
    email: string,
    password: string,
    fullName?: string,
  ) => Promise<{ ok: boolean; error?: string; needsConfirmation?: boolean }>
  signInWithGoogle: () => Promise<{ ok: boolean; error?: string }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

function toAppUser(sUser: SupabaseUser | null, email: string, fullName?: string): User {
  const name =
    fullName ||
    (sUser?.user_metadata?.full_name as string | undefined) ||
    sUser?.email?.split('@')[0] ||
    email.split('@')[0] ||
    DEFAULT_USER.name
  return {
    id: sUser?.id ?? 'demo-user',
    name,
    email: sUser?.email ?? email,
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [supabaseUser, setSupabaseUser] = useState<SupabaseUser | null>(null)
  const [isReady, setReady] = useState(false)

  useEffect(() => {
    if (!SUPABASE_READY) {
      setReady(true)
      return
    }
    let cancelled = false
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      setSession(data.session)
      setSupabaseUser(data.session?.user ?? null)
      setReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setSupabaseUser(nextSession?.user ?? null)
    })
    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [])

  const value = useMemo<AuthContextValue>(() => {
    const user = toAppUser(supabaseUser, '')
    return {
      user,
      session,
      supabaseUser,
      isAuthenticated: !!session,
      isReady,
      signInWithMagicLink: async (email: string) => {
        if (!SUPABASE_READY) return { ok: false, error: 'Supabase não configurado' }
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: {
            emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
          },
        })
        return error ? { ok: false, error: error.message } : { ok: true }
      },
      signInWithPassword: async (email, password) => {
        if (!SUPABASE_READY) return { ok: false, error: 'Supabase não configurado' }
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) return { ok: false, error: error.message }
        // Força refresh da sessão local (alguns browsers não disparam onAuthStateChange
        // consistentemente após signInWithPassword).
        const { data } = await supabase.auth.getSession()
        if (data.session) {
          setSession(data.session)
          setSupabaseUser(data.session.user)
        }
        return { ok: true }
      },
      signUpWithPassword: async (email, password, fullName) => {
        if (!SUPABASE_READY) return { ok: false, error: 'Supabase não configurado' }
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: fullName ?? '' },
            emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
          },
        })
        if (error) return { ok: false, error: error.message }
        // Mesmo fallback do signIn
        const { data: sessionData } = await supabase.auth.getSession()
        if (sessionData.session) {
          setSession(sessionData.session)
          setSupabaseUser(sessionData.session.user)
        }
        const needsConfirmation = !data.session
        return { ok: true, needsConfirmation }
      },
      signOut: async () => {
        await supabase.auth.signOut()
      },
      signInWithGoogle: async () => {
        if (!SUPABASE_READY) return { ok: false, error: 'Supabase não configurado' }
        const isIframe = typeof window !== 'undefined' && (window !== window.top || window.location.search.includes('mode=embed'))
        const redirectUrl = `${window.location.origin}${window.location.pathname}`

        if (isIframe) {
          // No modo embed/iframe o Google bloqueia OAuth direto com erro 403 (X-Frame-Options)
          // Geramos a URL e abrimos em popup isolado
          const { data, error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
              redirectTo: redirectUrl,
              skipBrowserRedirect: true,
              queryParams: {
                prompt: 'select_account',
              },
            },
          })
          if (error || !data?.url) {
            return { ok: false, error: error?.message || 'Falha ao iniciar autenticação Google' }
          }

          const width = 500
          const height = 650
          const left = Math.max(0, (window.screen.width - width) / 2)
          const top = Math.max(0, (window.screen.height - height) / 2)
          const popup = window.open(
            data.url,
            'google_oauth_popup',
            `width=${width},height=${height},top=${top},left=${left},status=no,toolbar=no,menubar=no`
          )

          return new Promise<{ ok: boolean; error?: string }>((resolve) => {
            let resolved = false
            const checkSession = async () => {
              const { data: sessData } = await supabase.auth.getSession()
              if (sessData?.session && !resolved) {
                resolved = true
                clearInterval(timer)
                if (popup && !popup.closed) popup.close()
                setSession(sessData.session)
                setSupabaseUser(sessData.session.user)
                resolve({ ok: true })
                return true
              }
              return false
            }

            const timer = setInterval(async () => {
              const ok = await checkSession()
              if (!ok && popup?.closed) {
                clearInterval(timer)
                setTimeout(async () => {
                  if (!resolved) {
                    const finalOk = await checkSession()
                    if (!finalOk) resolve({ ok: false, error: 'Login pelo Google foi cancelado ou fechado' })
                  }
                }, 500)
              }
            }, 800)
          })
        }

        // Fluxo padrão fora de iframe
        const { error } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: redirectUrl,
            queryParams: {
              prompt: 'select_account',
            },
          },
        })
        return error ? { ok: false, error: error.message } : { ok: true }
      },
    }
  }, [session, supabaseUser, isReady])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth deve ser usado dentro de <AuthProvider>')
  return ctx
}