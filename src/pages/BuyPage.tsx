/**
 * BuyPage — Rota de campanha /comprar/{ebook_id}
 *
 * Fluxo:
 * 1. Extrai ebook_id e ?src= da URL
 * 2. Se logado: vai direto pro checkout Asaas (via form submit)
 * 3. Se NÃO logado: salva em sessionStorage e mostra tela de login
 *    O listener global onAuthStateChange no App.tsx detecta o login
 *    e redireciona pra cá de volta, independente de qual tela
 *    o OAuth deixou o usuário.
 *
 * Esse é o endpoint de divulgação: o link é compartilhável por
 * Instagram/YouTube/WhatsApp/etc — uma URL só, todo mundo cai no checkout.
 *
 * IMPORTANTE: usamos form submit (POST) com `target=_top` em vez de
 * `window.location.assign` porque algumas extensões de browser (PWA
 * installers, ad blockers) interceptam atribuições programáticas de
 * location.href/assign, mas NÃO interceptam submissão de form. O form
 * submit é a forma mais garantida de fazer navegação cross-origin.
 */
import { useEffect, useState } from 'react'
import { useAuth } from '../lib/AuthContext'
import { CATALOG } from '../domain/catalog'
import type { Book } from '../domain/types'
import { supabase } from '../lib/supabase'

interface Props {
  ebookId: string
  trafficSource: string | null
  onGoStore: () => void
  onGoLibrary: () => void
}

const STORAGE_KEY = 'leitor-ia:pending-buy'

function findBookInCatalog(ebookId: string): Book | undefined {
  return CATALOG.find((b) => b.id === ebookId)
}

async function loadBookFromSupabase(ebookId: string): Promise<Book | null> {
  try {
    const { data, error } = await supabase
      .from('ebooks')
      .select('id, title, author, cover_url, price_cents, slug, shareable')
      .or(`id.eq.${ebookId},slug.eq.${ebookId}`)
      .maybeSingle()
    if (error || !data) return null
    if (data.shareable === false) return null
    return {
      id: data.slug || data.id,
      title: data.title,
      author: data.author || 'Desconhecido',
      cover: data.cover_url || '',
      description: '',
      price: data.price_cents || 2990,
      totalPages: 0,
      highlights: [],
      chunks: [],
    }
  } catch {
    return null
  }
}

function buildCheckoutUrl(book: Book, email: string, uid: string, trafficSource: string | null) {
  const backUrl = 'https://preview.automacaojs.us/leitor-inteligente/#/library'
  const params = new URLSearchParams({
    slug: book.id,
    email,
    uid,
    back: backUrl,
  })
  if (trafficSource) params.set('src', trafficSource)
  return `https://pay.automacaojs.us/api/checkout/redirect?${params.toString()}`
}

export function BuyPage({ ebookId, trafficSource, onGoStore, onGoLibrary }: Props) {
  const { isAuthenticated, isReady } = useAuth()
  const [book, setBook] = useState<Book | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [attempted, setAttempted] = useState(false)
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null)  // quando setado, mostra botão "Ir pro checkout"

  useEffect(() => {
    let cancelled = false
    const found = findBookInCatalog(ebookId)
    if (found) {
      setBook(found)
      return
    }
    loadBookFromSupabase(ebookId).then((b) => {
      if (cancelled) return
      setBook(b)
    })
    return () => { cancelled = true }
  }, [ebookId])

  useEffect(() => {
    if (isReady && !isAuthenticated) {
      try {
        sessionStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ ebookId, trafficSource, at: Date.now() }),
        )
      } catch { /* sem sessionStorage */ }
    }
  }, [isReady, isAuthenticated, ebookId, trafficSource])

  useEffect(() => {
    if (isAuthenticated) {
      try { sessionStorage.removeItem(STORAGE_KEY) } catch {}
    }
  }, [isAuthenticated])

  // Tenta auto-redirecionar quando logado + book pronto. Se após 1.5s
  // ainda estiver na tela (ou seja, alguma extensão bloqueou o assign),
  // expõe o link clicável como fallback.
  useEffect(() => {
    if (!isReady || !isAuthenticated || !book || attempted) return
    setAttempted(true)

    let cancelled = false
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null

    startCheckout(book, trafficSource)
      .then((url) => {
        if (cancelled || !url) return
        // Tenta auto-navegar. Se o browser bloquear, o fallbackTimer abaixo
        // expõe o botão manual.
        fallbackTimer = setTimeout(() => {
          if (!cancelled) setCheckoutUrl(url)  // expõe botão de fallback
        }, 1500)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e?.message ?? 'Falha ao iniciar checkout')
        setAttempted(false)
      })

    return () => {
      cancelled = true
      if (fallbackTimer) clearTimeout(fallbackTimer)
    }
  }, [isReady, isAuthenticated, book, attempted, trafficSource])

  const showAuthTransition = isAuthenticated && book !== null

  if (book === undefined) {
    return <div className="buy-loading"><p>Carregando livro...</p></div>
  }
  if (book === null) {
    return (
      <section className="buy-error">
        <h2>📚 Livro não disponível</h2>
        <p style={{ color: 'var(--muted)' }}>
          Este link de campanha não corresponde a um livro divulgável.
        </p>
        <button className="btn btn-primary" onClick={onGoStore}>Ver catálogo</button>
      </section>
    )
  }
  if (showAuthTransition) {
    return (
      <section className="buy-checkout-transition">
        <div className="spinner" aria-label="Carregando" />
        <h2>Preparando seu checkout...</h2>
        <p style={{ color: 'var(--muted)' }}>
          Você será redirecionado pro pagamento de <strong>{book.title}</strong> (R$ {(book.price / 100).toFixed(2)}).
        </p>
        {error ? (
          <>
            <p style={{ color: 'salmon' }}>{error}</p>
            <button
              className="btn btn-primary"
              onClick={() => { setAttempted(false); setError(null); setCheckoutUrl(null) }}
            >
              Tentar de novo
            </button>
          </>
        ) : checkoutUrl ? (
          <>
            <p style={{ color: 'salmon', fontSize: 13 }}>
              O navegador não navegou automaticamente. Toque no botão abaixo pra abrir o checkout:
            </p>
            <a
              href={checkoutUrl}
              className="btn btn-primary"
              target="_top"
              rel="noopener"
              style={{ display: 'inline-block', marginTop: 8, textDecoration: 'none' }}
            >
              Ir pro checkout →
            </a>
          </>
        ) : (
          <p style={{ fontSize: 12, color: 'var(--muted)' }}>
            Aguardando redirecionamento...
          </p>
        )}
      </section>
    )
  }
  if (!isAuthenticated) {
    return (
      <section className="buy-redirect">
        <h2>🔐 Login necessário</h2>
        <p style={{ color: 'var(--muted)' }}>
          Pra comprar <strong>{book.title}</strong>, faça login com Google.
          Você volta automaticamente pro checkout.
        </p>
        <button
          className="btn btn-primary"
          onClick={() => {
            try {
              sessionStorage.setItem(
                STORAGE_KEY,
                JSON.stringify({ ebookId, trafficSource, at: Date.now() }),
              )
            } catch {}
            window.location.hash = `#/login?next=/comprar/${encodeURIComponent(ebookId)}${
              trafficSource ? `&src=${encodeURIComponent(trafficSource)}` : ''
            }`
          }}
        >
          Entrar com Google
        </button>
      </section>
    )
  }

  return null
}

/**
 * Tenta iniciar o checkout.
 * Retorna a URL construída (pro fallback manual) ou null se sessão inválida.
 *
 * Estratégia em camadas:
 * 1. location.assign (navegação direta) — funciona em 95% dos casos
 * 2. Se após 1.5s a tela ainda tá visível, o BuyPage expõe o link
 *    clicável <a target="_top"> com a MESMA URL — funciona em qualquer
 *    browser, mesmo com extensões bloqueando location.assign
 */
async function startCheckout(book: Book, trafficSource: string | null): Promise<string | null> {
  const { data: sessData } = await supabase.auth.getSession()
  const sess = sessData?.session
  if (!sess?.user?.id || !sess.user.email) {
    window.location.hash = `#/login?next=/comprar/${encodeURIComponent(book.id)}${
      trafficSource ? `&src=${encodeURIComponent(trafficSource)}` : ''
    }`
    return null
  }
  const url = buildCheckoutUrl(book, sess.user.email, sess.user.id, trafficSource)

  // Marca visual "estou indo pagar" — banner da StorePage usa isso
  try {
    localStorage.setItem(
      'leitor-ia:pending-checkout',
      JSON.stringify({ bookId: book.id, bookTitle: book.title, at: Date.now() }),
    )
  } catch {}

  // Tenta auto-navegar. Se a aba já tiver sumido (sucesso), a próxima
  // linha nem executa. Se não navegar, o BuyPage mostra o fallback
  // clicável depois de 1.5s.
  window.location.assign(url)

  return url
}
