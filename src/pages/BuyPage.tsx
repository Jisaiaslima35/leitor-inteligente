/**
 * BuyPage — Rota de campanha /comprar/{ebook_id}
 *
 * Fluxo:
 * 1. Extrai ebook_id e ?src= da URL
 * 2. Se logado: vai direto pro checkout Asaas
 * 3. Se NÃO logado: salva em sessionStorage e redireciona pro login
 *    com `?next=/comprar/{ebook_id}` (LoginPage cuida do redirect pós-auth)
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

async function loadBookFromSupabase(ebookId: string): Promise<Book | null> {
  // Pra livros do catálogo que o user subiu (não estão no CATALOG hardcoded)
  // ou pra campanhas em ebooks custom, busca no Supabase
  try {
    const { data, error } = await supabase
      .from('ebooks')
      .select('id, title, author, cover_url, price_cents, slug, shareable')
      .or(`id.eq.${ebookId},slug.eq.${ebookId}`)
      .maybeSingle()
    if (error || !data) return null
    if (data.shareable === false) return null  // não-divulgável
    return {
      id: data.slug || data.id,  // create_checkout usa slug
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

export function BuyPage({ ebookId, trafficSource, onGoStore, onGoLibrary }: Props) {
  const { isAuthenticated, isReady } = useAuth()
  const [book, setBook] = useState<Book | null | undefined>(undefined)  // undefined=loading, null=not found
  const [error, setError] = useState<string | null>(null)

  // Resolve o livro: CATALOG primeiro, depois Supabase
  useEffect(() => {
    let cancelled = false
    const found = findBookInCatalog(ebookId)
    if (found) {
      setBook(found)
      return
    }
    loadBookFromSupabase(ebookId).then((b) => {
      if (cancelled) return
      setBook(b)  // pode ser null
    })
    return () => { cancelled = true }
  }, [ebookId])

  // Persiste o destino pro LoginPage usar pós-auth
  useEffect(() => {
    if (isReady && !isAuthenticated) {
      try {
        sessionStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ ebookId, trafficSource, at: Date.now() }),
        )
      } catch { /* sem sessionStorage, segue sem flag */ }
    }
  }, [isReady, isAuthenticated, ebookId, trafficSource])

  // Logado + livro carregado → inicia checkout
  useEffect(() => {
    if (!isReady || !isAuthenticated || !book) return
    startCheckout(book, trafficSource)
  }, [isReady, isAuthenticated, book, trafficSource])

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
  if (!isAuthenticated) {
    return (
      <section className="buy-redirect">
        <h2>🔐 Login necessário</h2>
        <p style={{ color: 'var(--muted)' }}>
          Pra comprar <strong>{book.title}</strong>, faça login com Google.
          Você volta automaticamente pra cá.
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

  return (
    <section className="buy-checkout">
      <h2>Preparando checkout...</h2>
      <p style={{ color: 'var(--muted)' }}>
        Você será redirecionado pro pagamento de <strong>{book.title}</strong> (R$ {(book.price / 100).toFixed(2)}).
      </p>
      {error && <p style={{ color: 'salmon' }}>{error}</p>}
    </section>
  )
}

async function startCheckout(book: Book, trafficSource: string | null) {
  const { data: sessData } = await supabase.auth.getSession()
  const sess = sessData?.session
  if (!sess?.user?.id || !sess.user.email) {
    // sessão sumiu (token expirado); volta pro login
    window.location.hash = `#/login?next=/comprar/${encodeURIComponent(book.id)}${
      trafficSource ? `&src=${encodeURIComponent(trafficSource)}` : ''
    }`
    return
  }
  const backUrl = 'https://preview.automacaojs.us/leitor-inteligente/#/library'
  const params = new URLSearchParams({
    slug: book.id,
    email: sess.user.email,
    uid: sess.user.id,
    back: backUrl,
  })
  if (trafficSource) params.set('src', trafficSource)

  // Marca visual "estou indo pagar"
  try {
    localStorage.setItem(
      'leitor-ia:pending-checkout',
      JSON.stringify({ bookId: book.id, bookTitle: book.title, at: Date.now() }),
    )
  } catch {}
  // Limpa a flag de pending-buy
  try { sessionStorage.removeItem(STORAGE_KEY) } catch {}

  // Navegação GET (mais robusto em mobile que fetch + location.href)
  window.location.href = `https://pay.automacaojs.us/api/checkout/redirect?${params.toString()}`
}
