import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CATALOG } from './domain/catalog'
import type { Book } from './domain/types'
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
import { CheckoutModal } from './components/CheckoutModal'
import { AuthProvider, useAuth } from './lib/AuthContext'
import { SUPABASE_READY } from './lib/supabase'

export type Route = 'home' | 'store' | 'library' | 'reader' | 'admin' | 'login' | 'upload'

const PROTECTED: Route[] = ['library', 'reader', 'admin', 'upload']

function readRoute(): { route: Route; bookId?: string } {
  if (typeof window === 'undefined') return { route: 'home' }
  const hash = window.location.hash.replace('#/', '')
  const [routePart, bookPart] = hash.split('/')
  const route = (routePart as Route) || 'home'
  const bookId = bookPart ? decodeURIComponent(bookPart) : undefined
  return { route, bookId }
}

function InnerApp() {
  const { user, isAuthenticated, isReady, signOut } = useAuth()
  const [{ route, bookId }, setRouteState] = useState(() => readRoute())
  // Inicializa vazio; o useEffect de sync popula quando autenticado
  const [library, setLibrary] = useState<LibraryState>({ purchases: [] })
  const [progress, setProgress] = useState<ProgressState>({})
  const [checkoutTarget, setCheckoutTarget] = useState<Book | null>(null)
  const [syncDone, setSyncDone] = useState(false)
  // Livros do user que NÃO estão no CATALOG hardcoded (livros uploaded)
  const [dynamicBook, setDynamicBook] = useState<Book | null>(null)
  const lastSyncedUser = useRef<string | undefined>(undefined)

  useEffect(() => {
    const onHash = () => setRouteState(readRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
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
      const hashValue = nextBookId ? `#/${nextRoute}/${encodeURIComponent(nextBookId)}` : `#/${nextRoute}`
      window.location.hash = hashValue
      setRouteState({ route: nextRoute, bookId: nextBookId })
      if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
    },
    [isAuthenticated],
  )

  // Tenta achar no CATALOG hardcoded primeiro (livros da loja)
  const catalogBook: Book | undefined = useMemo(() => {
    if (!bookId) return undefined
    return CATALOG.find((book) => book.id === bookId)
  }, [bookId])

  // Se não achou no catalog, busca no Supabase (livros uploaded pelo user)
  useEffect(() => {
    let cancelled = false
    setDynamicBook(null)
    if (!bookId) return
    if (catalogBook) return // já resolveu
    if (!isAuthenticated || !SUPABASE_READY) return

    loadEbookBySlug(bookId).then((row) => {
      if (cancelled || !row) return
      // Constrói um Book "virtual" — sem chunks (usa RAG no Supabase)
      const virtual: Book = {
        id: bookId,
        title: row.title,
        author: row.author,
        cover: row.cover_url || '',
        description: '',
        price: 0,
        totalPages: row.total_pages,
        highlights: [],
        chunks: [],
      }
      setDynamicBook(virtual)
    })
    return () => { cancelled = true }
  }, [bookId, catalogBook, isAuthenticated])

  const activeBook: Book | undefined = catalogBook ?? dynamicBook ?? undefined

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
    const next = await buyBookRemote(checkoutTarget, library)
    setLibrary(next)
    setCheckoutTarget(null)
    navigate('library')
  }, [checkoutTarget, library, navigate])

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
          <StorePage onBuy={handleBuyClick} library={library} />
        )}
        {route === 'library' && isAuthenticated && (
          <LibraryPage progress={progress} onNavigate={navigate} />
        )}
        {route === 'library' && !isAuthenticated && (
          <LoginPage onBack={() => navigate('home')} onSuccess={() => navigate('library')} />
        )}
        {route === 'reader' && activeBook && isAuthenticated && (
          <ReaderPage book={activeBook} progress={progress} onTrack={handleTrack} />
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
        {route === 'reader' && activeBook && !isAuthenticated && (
          <LoginPage
            onBack={() => navigate('home')}
            onSuccess={() => navigate('reader', activeBook.id)}
          />
        )}
        {route === 'admin' && (
          <AdminPage
            library={library}
            progress={progress}
            catalog={CATALOG}
            user={user}
            onReset={handleResetLibrary}
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