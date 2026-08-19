/**
 * BuyPage — Rota de campanha /comprar/{ebook_id}
 *
 * Fluxo:
 * 1. Extrai ebook_id e ?src= da URL
 * 2. Se logado: vai direto pro checkout Asaas (via window.location.href)
 * 3. Se NÃO logado: salva em sessionStorage e mostra tela de login
 *    O listener global onAuthStateChange no App.tsx detecta o login
 *    e redireciona pra cá de volta, independente de qual tela
 *    o OAuth deixou o usuário.
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
  const [attempted, setAttempted] = useState(false)

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

  // Persiste o destino pra ser recuperado pelo listener de auth no App.tsx.
  // Salva enquanto o user não tá logado; quando logar, App.tsx lê essa flag
  // e redireciona pra cá com o ebookId preservado.
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

  // Limpa a flag quando o user loga (independente do listener no App).
  // Belt-and-suspenders: se o listener do App já navegou, este aqui só limpa
  // a chave residual; se não navegou, o próprio startCheckout abaixo cuida.
  useEffect(() => {
    if (isAuthenticated) {
      try { sessionStorage.removeItem(STORAGE_KEY) } catch {}
    }
  }, [isAuthenticated])

  // Logado + livro carregado + ainda não tentou → inicia checkout UMA vez
  useEffect(() => {
    if (!isReady || !isAuthenticated || !book || attempted) return
    setAttempted(true)  // trava pra não reentrar
    startCheckout(book, trafficSource).catch((e) => {
      setError(e?.message ?? 'Falha ao iniciar checkout')
      setAttempted(false)  // libera pra retry em caso de erro
    })
  }, [isReady, isAuthenticated, book, attempted, trafficSource])

  // Tela de transição: usuário acabou de autenticar mas o checkout ainda
  // tá sendo preparado. Mostra spinner pra não deixar tela vazia e dar
  // feedback visual de que algo tá acontecendo.
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
            <button className="btn btn-primary" onClick={() => { setAttempted(false); setError(null) }}>
              Tentar de novo
            </button>
          </>
        ) : (
          <p style={{ fontSize: 12, color: 'var(--muted)' }}>
            Se esta tela travar por mais de 10s,{' '}
            <a href={`https://pay.automacaojs.us/api/checkout/redirect?slug=${encodeURIComponent(book.id)}${trafficSource ? `&src=${encodeURIComponent(trafficSource)}` : ''}`}>
              clique aqui pra ir pro checkout manualmente
            </a>.
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

  // Marca visual "estou indo pagar" — banner da StorePage usa isso pra
  // detectar "pagou mas ainda não caiu na biblioteca"
  try {
    localStorage.setItem(
      'leitor-ia:pending-checkout',
      JSON.stringify({ bookId: book.id, bookTitle: book.title, at: Date.now() }),
    )
  } catch {}

  // Navegação hard via window.location.assign — equivalente a location.href
  // mas algumas extensões de browser interceptam o segundo. assign é mais
  // garantido como navegação real (não só atribuição).
  const target = `https://pay.automacaojs.us/api/checkout/redirect?${params.toString()}`
  // Pequeno delay pra garantir que o React já pintou o spinner antes da
  // navegação full-page (evita race onde o browser pinta a home antes de
  // capturar o navigate)
  await new Promise((r) => setTimeout(r, 50))
  window.location.assign(target)
}
