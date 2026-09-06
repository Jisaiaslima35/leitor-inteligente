import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Book, Categoria } from './domain/types'
import {
  buyBookRemote,
  fetchRemoteLibrary,
  fetchRemoteProgress,
  loadLibrary,
  loadProgress,
  persistLibrary,
  persistProgress,
  trackProgressRemote,
} from './domain/storage'
import { loadEbookBySlug } from './lib/supabaseStorage'
import type { LibraryState, ProgressState } from './domain/types'
import { Topbar } from './components/Topbar'
import { StorePage } from './pages/StorePage'
import { LibraryPage } from './pages/LibraryPage'
import { ReaderPage } from './pages/ReaderPage'
import { AdminPage } from './pages/AdminPage'
import { HomePage } from './pages/HomePage'
import { LoginPage } from './pages/LoginPage'
import { UploadPage } from './pages/UploadPage'
import { BuyPage } from './pages/BuyPage'
import { DevPage } from './pages/DevPage'
import { CheckoutModal } from './components/CheckoutModal'
import { AuthProvider, useAuth } from './lib/AuthContext'
import { supabase, SUPABASE_READY } from './lib/supabase'
import { isAdminEmail, isAdminUser } from './lib/admin'

export type Route = 'home' | 'store' | 'library' | 'reader' | 'admin' | 'login' | 'upload' | 'comprar' | 'dev'

const PENDING_BUY_KEY = 'leitor-ia:pending-buy'

interface PendingBuy {
  ebookId: string
  trafficSource?: string | null
}

function readPendingBuy(): PendingBuy | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(PENDING_BUY_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!data?.ebookId) return null
    return { ebookId: data.ebookId, trafficSource: data.trafficSource ?? null }
  } catch {
    return null
  }
}

function clearPendingBuy() {
  try { sessionStorage.removeItem(PENDING_BUY_KEY) } catch { /* sem sessionStorage */ }
}

const PROTECTED: Route[] = ['library', 'reader', 'admin', 'upload']

/** Lê o hash e também extrai `?src=...` (traffic source da campanha) e
 *  `?room=<uuid>` (Painel de Estudo em Dupla). */
function readRoute(): {
  route: Route
  bookId?: string
  trafficSource?: string
  room?: string
} {
  if (typeof window === 'undefined') return { route: 'home' }
  const rawHash = window.location.hash.replace('#/', '')
  const [pathPart, queryPart] = rawHash.split('?')
  const [routePart, bookPart] = pathPart.split('/')
  const route = (routePart as Route) || 'home'
  const bookId = bookPart ? decodeURIComponent(bookPart) : undefined
  let trafficSource: string | undefined
  let room: string | undefined
  if (queryPart) {
    const params = new URLSearchParams(queryPart)
    trafficSource = params.get('src') || undefined
    const r = params.get('room')
    if (r && /^[a-zA-Z0-9_-]{4,64}$/.test(r)) room = r
  }
  return { route, bookId, trafficSource, room }
}

function InnerApp() {
  const { user, isAuthenticated, isReady, signOut } = useAuth()
  const [{ route, bookId, trafficSource, room }, setRouteState] = useState(() => readRoute())
  // Inicializa vazio; o useEffect de sync popula quando autenticado
  const [library, setLibrary] = useState<LibraryState>({ purchases: [] })
  const [progress, setProgress] = useState<ProgressState>({})
  const [checkoutTarget, setCheckoutTarget] = useState<Book | null>(null)
  const [syncDone, setSyncDone] = useState(false)
  // Livros do user que NÃO estão no CATALOG hardcoded (livros uploaded)
  const [dynamicBook, setDynamicBook] = useState<Book | null>(null)
  const lastSyncedUser = useRef<string | undefined>(undefined)
  // Modal que aparece quando o polling detecta o livro liberado
  const [pendingRedirect, setPendingRedirect] = useState<{
    bookSlug: string
    redirectUrl: string
    countdown: number
  } | null>(null)

  useEffect(() => {
    const onHash = () => setRouteState(readRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Listener global de mudança de auth: se acabou de logar e tem compra
  // pendente salva, redireciona pro checkout da campanha independente
  // de qual tela o OAuth deixou o usuário (resolve o bug do Google
  // voltar pra URL base em vez de /comprar/{id}).
  useEffect(() => {
    if (!SUPABASE_READY) return
    const { data: sub } = supabase.auth.onAuthStateChange((event, nextSession) => {
      const justLoggedIn = event === 'SIGNED_IN' && !!nextSession?.user
      if (!justLoggedIn) return
      const pending = readPendingBuy()
      if (!pending) return
      // Limpa a flag antes de navegar pra não loopar
      clearPendingBuy()
      const qs = pending.trafficSource ? `?src=${encodeURIComponent(pending.trafficSource)}` : ''
      window.location.hash = `#/comprar/${encodeURIComponent(pending.ebookId)}${qs}`
    })
    return () => { sub.subscription.unsubscribe() }
  }, [])

  // Sincroniza com Supabase quando usuário autentica
  useEffect(() => {
    if (!isReady || !SUPABASE_READY) return
    if (!isAuthenticated) {
      // Não logado: carrega do localStorage como antes (modo demo)
      setLibrary(loadLibrary())
      setProgress(loadProgress())
      setSyncDone(true)
      lastSyncedUser.current = undefined
      return
    }
    if (lastSyncedUser.current === user.id) return
    lastSyncedUser.current = user.id
    setSyncDone(false)
    Promise.all([fetchRemoteLibrary(), fetchRemoteProgress()]).then(([lib, prog]) => {
      const nextLib = lib ?? loadLibrary()
      const nextProg = prog ?? loadProgress()
      setLibrary(nextLib)
      setProgress(nextProg)
      if (lib) persistLibrary(lib)
      if (prog) persistProgress(prog)
      setSyncDone(true)
    })
  }, [isReady, isAuthenticated, user.id])

  const navigate = useCallback(
    (nextRoute: Route, nextBookId?: string) => {
      // Bloqueia rotas protegidas quando não autenticado
      if (PROTECTED.includes(nextRoute) && !isAuthenticated) {
        window.location.hash = '#/login'
        setRouteState({ route: 'login' })
        return
      }
      // 05/09/2026 (v8 Isaías): rota /admin exclusiva do admin (email
      // Brisacamera34@gmail.com OU user.id === ADMIN_USER_ID). Usuário
      // comum tentando navegar é redirecionado pra /library.
      if (nextRoute === 'admin' && !(isAdminEmail(user.email) || isAdminUser(user))) {
        window.location.hash = '#/library'
        setRouteState({ route: 'library' })
        return
      }
      const hashValue = nextBookId ? `#/${nextRoute}/${encodeURIComponent(nextBookId)}` : `#/${nextRoute}`
      window.location.hash = hashValue
      setRouteState({ route: nextRoute, bookId: nextBookId })
      if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
    },
    [isAuthenticated, user.email, user.id],
  )

  // Vitrine = Supabase (filtro server-side admin+publicado+preço>0).
  // O CATALOG hardcoded foi desativado em src/domain/catalog.ts — não usar mais.
  // Pra abrir /reader/{id}, busca o slug OU id direto no Supabase.
  //
  // 04/09/2026 (v3): quando guest (`!isAuthenticated`) + `?room=<id>` válido,
  // busca metadata via endpoint público `/guest-meta` que valida sala viva.
  // SEM `?room=` guest continua sendo bloqueado (vai pra LoginPage na rota).
  const [guestRoomAlive, setGuestRoomAlive] = useState<boolean | null>(null)
  // 05/09 Isaías (v4): dono tem prioridade. `loadedAsGuest=true` só quando
  // o book veio via /guest-meta (anônimo OU logado sem o livro). Quando o
  // usuário logado tem o livro, `loadEbookBySlug` resolve e loadedAsGuest
  // fica false → renderiza como host (não cai em "sessão expirada").
  const [loadedAsGuest, setLoadedAsGuest] = useState<boolean>(false)
  useEffect(() => {
    let cancelled = false
    setDynamicBook(null)
    setGuestRoomAlive(null)
    setLoadedAsGuest(false)
    if (!bookId) return

    const applyMeta = (meta: { id?: string; slug?: string; ebook_id?: string; title?: string; author?: string; cover_url?: string; categoria?: string; total_pages?: number }) => {
      const CATEGORIAS_VALIDAS = new Set(['programacao', 'tecnologia', 'gospel', 'literatura', 'autoajuda', 'outros', 'comum'])
      const cat: Categoria = meta.categoria && CATEGORIAS_VALIDAS.has(meta.categoria)
        ? (meta.categoria as Categoria)
        : 'outros'
      // 05/09/2026 (v7): ordem de prioridade é slug > id > ebook_id > hash.
      // loadEbookBySlug() retorna o slug E ebook_id, mas applyMeta lia só
      // o ebook_id (uuid interno) — daí o `book.id` virava UUID ao invés
      // de slug, e toda chamada ao Supabase filtrava por UUID → 406.
      // Ordem:
      //   1. meta.slug     (campo real retornado por loadEbookBySlug)
      //   2. meta.id       (slug retornado por /guest-meta)
      //   3. meta.ebook_id (uuid, só pra emergencies)
      //   4. bookId        (fallback do hash router)
      const slug = meta.slug || meta.id || meta.ebook_id || bookId
      setDynamicBook({
        id: slug,
        title: meta.title || bookId,
        author: meta.author || '',
        cover: meta.cover_url || '',
        description: '',
        price: 0,
        totalPages: meta.total_pages || 100,
        highlights: [],
        chunks: [],
        categoria: cat,
      })
    }

    // ── DONO (autenticado + Supabase pronto) tem prioridade absoluta ──
    // Se loadEbookBySlug achar o livro na biblioteca, é dono: ignora o
    // /guest-meta mesmo com ?room= na URL. O CollabPanel continua
    // funcionando porque `roomId` é passado pro ReaderPage via prop.
    if (isAuthenticated && SUPABASE_READY) {
      loadEbookBySlug(bookId).then((row) => {
        if (cancelled) return
        if (row) {
          // DONO — book veio da biblioteca, guestMode fica false.
          applyMeta(row as any)
          setLoadedAsGuest(false)
          return
        }
        // Logado mas SEM o livro: cai no fluxo de convidado SE tiver ?room=
        if (room) fetchGuestMeta()
        // Sem room + sem livro → null dinâmico → tela "Livro não encontrado"
      })
      return () => { cancelled = true }
    }

    // ── GUEST anônimo: só entra se tiver convite ──
    if (!isAuthenticated) {
      if (!room) return // sem convite → LoginPage (proteção de venda)
      fetchGuestMeta()
      return () => { cancelled = true }
    }

    // Helper interno: carrega metadata via endpoint público + marca guestMode
    function fetchGuestMeta() {
      fetch(`${import.meta.env.BASE_URL}signed-url-api/guest-meta?slug=${encodeURIComponent(bookId)}&room_id=${encodeURIComponent(room)}`)
        .then((r) => r.json().then((j) => ({ status: r.status, body: j })))
        .then((result) => {
          if (cancelled) return
          if (result.status !== 200 || !result.body?.id) {
            setGuestRoomAlive(false)
            return
          }
          applyMeta(result.body)
          setGuestRoomAlive(true)
          setLoadedAsGuest(true)
        })
        .catch(() => {
          if (!cancelled) setGuestRoomAlive(false)
        })
    }
  }, [bookId, isAuthenticated, room])

  const activeBook: Book | undefined = dynamicBook ?? undefined

  const handleBuyClick = useCallback((book: Book) => {
    if (!isAuthenticated) {
      window.location.hash = '#/login'
      setRouteState({ route: 'login' })
      return
    }
    setCheckoutTarget(book)
  }, [isAuthenticated])

  const handleConfirmCheckout = useCallback(async () => {
    if (!checkoutTarget) return
    // Não navega ainda — buyBookRemote abre checkout em nova aba
    // e a aba original fica viva. Quando o webhook liberar, o polling
    // mostra o modal "redirecionando em 5s" e leva pra Biblioteca.
    const next = await buyBookRemote(checkoutTarget, library)
    setLibrary(next)
    setCheckoutTarget(null)
  }, [checkoutTarget, library])

  const handleResetLibrary = useCallback(() => {
    const empty: LibraryState = { purchases: [] }
    persistLibrary(empty)
    setLibrary(empty)
    const emptyProgress: ProgressState = {}
    persistProgress(emptyProgress)
    setProgress(emptyProgress)
  }, [])

  const handleTrack = useCallback(async (book: Book, page: number) => {
    const next = await trackProgressRemote(progress, book, page)
    setProgress(next)
  }, [progress])

  const handleSignOut = useCallback(async () => {
    await signOut()
    lastSyncedUser.current = undefined
    navigate('home')
  }, [signOut, navigate])

  // Mostra loading enquanto sincroniza do Supabase
  const showSyncLoading = isReady && isAuthenticated && !syncDone

  return (
    <div className="app-shell">
      <Topbar
        route={route}
        onNavigate={navigate}
        user={user}
        isAuthenticated={isAuthenticated}
        onSignOut={handleSignOut}
      />
      <main className="page">
        {showSyncLoading && (
          <div className="sync-loading">
            <div className="spinner" />
            <p>Carregando sua biblioteca...</p>
          </div>
        )}
        {!showSyncLoading && (
          <>
        {route === 'login' && (
          <LoginPage
            onBack={() => navigate('home')}
            onSuccess={() => navigate('library')}
          />
        )}
        {route === 'upload' && isAuthenticated && (
          <UploadPage
            onBack={() => navigate('library')}
            onSuccess={() => navigate('library')}
          />
        )}
        {route === 'home' && (
          <HomePage onNavigate={navigate} onBuy={handleBuyClick} library={library} />
        )}
        {route === 'store' && (
          <StorePage onBuy={handleBuyClick} library={library} onGoLibrary={() => navigate('library')} />
        )}
        {route === 'library' && isAuthenticated && (
          <LibraryPage progress={progress} onNavigate={navigate} />
        )}
        {route === 'library' && !isAuthenticated && (
          <LoginPage onBack={() => navigate('home')} onSuccess={() => navigate('library')} />
        )}
        {route === 'reader' && activeBook && isAuthenticated && !loadedAsGuest && (
          // DONO: autenticado E livro veio da biblioteca (via loadEbookBySlug).
          // Tem prioridade absoluta — ignora `?room=` pro carregamento, mas o
          // `roomId` continua sendo passado pro ReaderPage abrir o CollabPanel.
          <ReaderPage
            book={activeBook}
            progress={progress}
            onTrack={handleTrack}
            onOpenDev={(bookId) => navigate('dev', bookId)}
            roomId={room}
            onCloseCollab={() => navigate('reader', activeBook.id)}
          />
        )}
        {route === 'reader' && activeBook && loadedAsGuest && (
          // CONVIDADO da sala: book veio via /guest-meta (anônimo OU logado
          // sem o livro). onTrack NO-OP — progresso fica só local.
          <ReaderPage
            book={activeBook}
            progress={progress}
            onTrack={() => { /* guest de sala: progresso fica só local */ }}
            onOpenDev={() => undefined}
            roomId={room}
            onCloseCollab={() => navigate(isAuthenticated ? 'library' : 'store')}
            guestMode={true}
          />
        )}
        {route === 'reader' && room && guestRoomAlive === false && (
          // 04/09/2026 (v3): sala expirou enquanto carregava. Tela de compra
          // (proteção de venda — livro nunca vinculado à conta do guest).
          <section>
            <h2 style={{ marginTop: 0 }}>⏱️ Sessão de leitura expirada</h2>
            <p style={{ color: 'var(--muted)' }}>
              A sala do <strong>Estudo em Dupla</strong> terminou — o anfitrião saiu ou passou do tempo limite.
            </p>
            <p style={{ color: 'var(--muted)' }}>
              Pra continuar lendo <em>{bookId}</em>, você pode comprar o livro ou pedir um novo convite.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={() => navigate('comprar', bookId)}>🛒 Comprar o livro</button>
              <button className="btn btn-ghost" onClick={() => navigate('store')}>← Ver loja</button>
            </div>
          </section>
        )}
        {route === 'reader' && !activeBook && bookId && isAuthenticated && (
          <section>
            <h2 style={{ marginTop: 0 }}>📚 Livro não encontrado</h2>
            <p style={{ color: 'var(--muted)' }}>
              O livro <code>{bookId}</code> não está na sua biblioteca.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button className="btn btn-primary" onClick={() => navigate('library')}>← Voltar à biblioteca</button>
              <button className="btn btn-ghost" onClick={() => navigate('upload')}>Enviar outro livro</button>
            </div>
          </section>
        )}
        {route === 'dev' && isAuthenticated && activeBook && activeBook.categoria !== 'programacao' && (
          // 23/08/2026: trava de acesso. Livro não-programação tentou abrir
          // /dev/<slug> direto pela URL. Não chama API, não carrega DevPage,
          // não desperdiça tokens. Só mostra mensagem amigável.
          <section className="dev-blocked">
            <h2>🔒 Sala Dev restrita</h2>
            <p>Esta seção é exclusiva para livros de <strong>programação</strong>.</p>
            <p>O livro <em>"{activeBook.title}"</em> é da categoria <code>{activeBook.categoria}</code>.</p>
            <button className="btn btn-primary" onClick={() => navigate(activeBook ? 'reader' : 'library')}>
              ← Voltar à leitura
            </button>
          </section>
        )}
        {route === 'dev' && isAuthenticated && (!activeBook || activeBook.categoria === 'programacao') && (
          <DevPage
            book={activeBook}
            // 23/08/2026: precisa passar bookId pro navigate, senão o reader
            // renderiza sem activeBook (tela branca). onBack do DevPage chama
            // navigate(route, bookId?) — sem o bookId aqui o ReaderPage nunca
            // acha o livro.
            onBack={() => navigate(activeBook ? 'reader' : 'library', activeBook?.id)}
            roomId={room}
            onCloseCollab={() => navigate('dev', activeBook?.id)}
          />
        )}
        {route === 'dev' && !isAuthenticated && (
          <LoginPage onBack={() => navigate('home')} onSuccess={() => navigate('dev')} />
        )}
        {route === 'reader' && !isAuthenticated && !room && (
          // Guest SEM ?room= → tela de login (proteção de venda).
          // Com ?room= + sala viva → vai pro ReaderPage (acima).
          <LoginPage
            onBack={() => navigate('home')}
            onSuccess={() => navigate('reader', bookId)}
          />
        )}
        {route === 'admin' && (isAdminEmail(user.email) || isAdminUser(user)) && (
          <AdminPage
            library={library}
            progress={progress}
            user={user}
            onReset={handleResetLibrary}
          />
        )}
        {route === 'admin' && !(isAdminEmail(user.email) || isAdminUser(user)) && (
          // 05/09/2026 (v8 Isaías): guarda adicional no render — se o
          // usuário digitou #/admin direto na URL e não é admin, manda
          // pra biblioteca via hash (o listener de hashchange já cuida).
          // Doble check porque navigate() pode ter sido burlado.
          <section>
            <h2 style={{ marginTop: 0 }}>🔒 Acesso restrito</h2>
            <p style={{ color: 'var(--muted)' }}>
              Esta área é exclusiva do administrador do Leitor Inteligente.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button className="btn btn-primary" onClick={() => navigate('library')}>← Voltar à biblioteca</button>
            </div>
          </section>
        )}
        {route === 'comprar' && bookId && (
          <BuyPage
            ebookId={bookId}
            trafficSource={trafficSource ?? null}
            onGoStore={() => navigate('store')}
            onGoLibrary={() => navigate('library')}
          />
        )}
          </>
        )}
      </main>
      {checkoutTarget && (
        <CheckoutModal
          book={checkoutTarget}
          user={user}
          onCancel={() => setCheckoutTarget(null)}
          onConfirm={handleConfirmCheckout}
        />
      )}
    </div>
  )
}

export function App() {
  return (
    <AuthProvider>
      <InnerApp />
    </AuthProvider>
  )
}
