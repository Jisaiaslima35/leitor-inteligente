/**
 * BuyPage — Rota de campanha /comprar/{ebook_id}
 *
 * Fluxo:
 * 1. Extrai ebook_id e ?src= da URL
 * 2. Se NÃO logado: mostra botão "Entrar com Google". Após o login, o
 *    listener onAuthStateChange no App.tsx detecta SIGNED_IN, lê
 *    sessionStorage, e navega o user de volta pra cá.
 * 3. Se logado: monta a URL do checkout (Mercado Pago Checkout Pro, transparente)
 *    e mostra um botão grande "Pagar agora R$ X". O user clica → navegação
 *    cross-origin com user gesture → init_point do MP.
 *
 * Por que SEM auto-redirect? Extensões de browser (PWA installer, ad
 * blocker, gerenciador de senhas) interceptam window.location.assign
 * em navegações cross-origin SEM user gesture. A solução é usar o
 * mesmo padrão que funciona no StorePage: anchor <a> clicado pelo user.
 *
 * Esse é o endpoint de divulgação: o link é compartilhável por
 * Instagram/YouTube/WhatsApp/etc — uma URL só, todo mundo cai no checkout.
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

// UUID válido (8-4-4-4-12). Se ebookId não casar, tratamos como slug.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function loadBookFromSupabase(ebookId: string): Promise<Book | null> {
  try {
    // Detecta se é UUID ou slug. Antes usava .or(`id.eq.X,slug.eq.X`) que
    // quebrava com 22P02 — PostgREST infere o tipo da disjunção inteira como
    // UUID (porque a coluna id é UUID) e tenta converter "teste-r5" pra UUID.
    // Caminho de campanha (/comprar/{slug}) → busca por slug. Link interno
    // com uuid → busca por id. Sem .or() = sem ambiguidade de tipo.
    const isUuid = UUID_RE.test(ebookId)
    let query = supabase
      .from('ebooks')
      .select('id, title, author, cover_url, price_cents, slug, shareable')
    query = isUuid ? query.eq('id', ebookId) : query.eq('slug', ebookId)
    const { data, error } = await query.maybeSingle()
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
      categoria: 'outros',
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
  const { isAuthenticated, isReady, user } = useAuth()

  const [book, setBook] = useState<Book | null | undefined>(undefined)
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
  // Estado de "cliquei mas o Mercado Pago ainda não respondeu" — feedback visual
  // durante a navegação cross-origin (que leva 2-4s via CDN Cloudflare).
  const [navigating, setNavigating] = useState(false)

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

  // Persiste o destino enquanto deslogado, pra ser recuperado pelo
  // listener onAuthStateChange no App.tsx quando o user logar.
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

  // Quando loga (independente do listener), limpa a flag residual.
  useEffect(() => {
    if (isAuthenticated) {
      try { sessionStorage.removeItem(STORAGE_KEY) } catch {}
    }
  }, [isAuthenticated])

  // Quando o user está logado e o book tá resolvido, monta a URL do
  // checkout. NÃO chama location.assign — apenas prepara a URL pro
  // user clicar no botão. Garante que a navegação é um user gesture.
  useEffect(() => {
    if (!isReady || !isAuthenticated || !book || checkoutUrl) return
    let cancelled = false
    setBuilding(true)
    setError(null)
    const buildIt = (uid: string, email: string) => {
      const url = buildCheckoutUrl(book, email, uid, trafficSource)
      setCheckoutUrl(url)
      try {
        localStorage.setItem(
          'leitor-ia:pending-checkout',
          JSON.stringify({ bookId: book.id, bookTitle: book.title, at: Date.now() }),
        )
      } catch {}
      setBuilding(false)
    }
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      const sess = data.session
      if (!sess?.user?.id || !sess.user.email) {
        // Sessão inválida → volta pro login
        window.location.hash = `#/login?next=/comprar/${encodeURIComponent(book.id)}${
          trafficSource ? `&src=${encodeURIComponent(trafficSource)}` : ''
        }`
        return
      }
      buildIt(sess.user.id, sess.user.email)
    }).catch((e) => {
      if (cancelled) return
      setError(e?.message ?? 'Falha ao montar checkout')
      setBuilding(false)
    })
    return () => { cancelled = true }
  }, [isReady, isAuthenticated, book, checkoutUrl, trafficSource, user])

  if (book === undefined) {
    return (
      <section className="buy-loading">
        <div className="spinner" />
        <p>Carregando livro...</p>
      </section>
    )
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

  // Logado + book pronto: mostra botão grande de "Pagar agora".
  // O click é um user gesture, então a navegação cross-origin funciona
  // em qualquer browser/extensão.
  return (
    <section className="buy-checkout">
      <div className="buy-checkout-card">
        <h2>Quase lá!</h2>
        <p style={{ color: 'var(--muted)', marginTop: 4 }}>
          Você vai comprar <strong>{book.title}</strong> por{' '}
          <strong style={{ color: 'var(--primary)' }}>
            R$ {(book.price / 100).toFixed(2)}
          </strong>.
        </p>
        {error && <p style={{ color: 'salmon', marginTop: 12 }}>{error}</p>}
        <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {checkoutUrl ? (
            <a
              href={checkoutUrl}
              className="btn btn-primary"
              target="_top"
              rel="noopener"
              onClick={() => {
                // Marca que o user clicou — força o browser a tratar
                // como navegação iniciada pelo user (sem isso, extensões
                // e PWA installers podem bloquear o cross-origin).
                // Também ativa feedback visual durante os 2-4s de espera
                // do `/api/checkout/redirect` (CDN Cloudflare + Mercado Pago).
                try {
                  localStorage.setItem(
                    'leitor-ia:pending-checkout',
                    JSON.stringify({ bookId: book.id, bookTitle: book.title, at: Date.now() }),
                  )
                } catch {}
                setNavigating(true)
              }}
              style={{
                display: 'inline-block',
                textAlign: 'center',
                padding: '14px 24px',
                fontSize: 16,
                fontWeight: 600,
                textDecoration: 'none',
                opacity: navigating ? 0.7 : 1,
                pointerEvents: navigating ? 'none' : 'auto',
              }}
            >
              {navigating ? (
                <>
                  <span className="spinner" style={{ marginRight: 8, verticalAlign: 'middle' }} />
                  Redirecionando pro Mercado Pago…
                </>
              ) : (
                <>💳 Pagar agora R$ {(book.price / 100).toFixed(2)}</>
              )}
            </a>
          ) : building ? (
            <button className="btn btn-primary" disabled>
              <span className="spinner" style={{ marginRight: 8 }} />
              Preparando...
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={() => {
                // Retry: força o efeito a montar de novo resetando checkoutUrl
                setCheckoutUrl(null)
              }}
            >
              Tentar de novo
            </button>
          )}
          <button className="btn btn-ghost" onClick={onGoLibrary}>
            Ver minha biblioteca
          </button>
        </div>
        <small style={{ display: 'block', marginTop: 16, color: 'var(--muted)', fontSize: 12 }}>
          Após o pagamento, o livro entra automaticamente na sua biblioteca.
        </small>
      </div>
    </section>
  )
}
