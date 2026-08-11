import { CATALOG } from './catalog'
import type { Book, LibraryState, ProgressState, User } from './types'
import { DEFAULT_USER } from './types'
import { checkoutBook } from './library'
import { saveProgress } from './progress'
import { SUPABASE_READY, supabase } from '../lib/supabase'
import {
  addRemotePurchase,
  loadRemoteLibrary,
  loadRemoteProgress,
  saveRemoteProgress,
} from '../lib/supabaseStorage'

const LIBRARY_KEY = 'leitor-ia:library'
const PROGRESS_KEY = 'leitor-ia:progress'
const USER_KEY = 'leitor-ia:user'

function hasStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function readJson<T>(key: string, fallback: T): T {
  if (!hasStorage()) return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson<T>(key: string, value: T): void {
  if (!hasStorage()) return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // sem cota ou storage indisponível — segue sem persistir
  }
}

export function loadUser(): User {
  return readJson<User>(USER_KEY, DEFAULT_USER)
}

export function loadLibrary(): LibraryState {
  return readJson<LibraryState>(LIBRARY_KEY, { purchases: [] })
}

export function loadProgress(): ProgressState {
  return readJson<ProgressState>(PROGRESS_KEY, {})
}

export function persistLibrary(state: LibraryState): void {
  writeJson(LIBRARY_KEY, state)
}

export function persistProgress(state: ProgressState): void {
  writeJson(PROGRESS_KEY, state)
}

// Versões async que sincronizam com Supabase quando há sessão
async function currentUserId(): Promise<string> {
  if (SUPABASE_READY) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.user) return data.session.user.id
  }
  return DEFAULT_USER.id
}

export async function buyBookRemote(book: Book, state: LibraryState): Promise<LibraryState> {
  const userId = await currentUserId()
  const userEmail = await currentUserEmail()
  const next = checkoutBook(state, userId, book.id)

  // Se logado e Supabase OK, chama payment server pra criar checkout dinâmico
  if (SUPABASE_READY && userId !== DEFAULT_USER.id && userEmail) {
    try {
      // Em modo teste (CAKTO bloqueado pelo Cloudflare), usa simulate-flow
      // Em produção, usa checkout/create
      // Por padrão agora: usa Asaas real (criar checkout dinâmico)
      const useSimulation = (window as any).__CAKTO_SIMULATION__ === true
      const endpoint = useSimulation ? '/api/payment/simulate-flow' : '/api/checkout/create'
      const payload = {
        __simulate: useSimulation,
        ebook_slug: book.id,
        customer_email: userEmail,
        customer_id: userId,
        success_url: 'https://preview.automacaojs.us/leitor-inteligente/#/library',
        cancel_url: 'https://preview.automacaojs.us/leitor-inteligente/#/store',
      }
      const r = await fetch(`https://pay.automacaojs.us${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await r.json()
      if (data.ok && data.checkout_url) {
        // Redireciona pro checkout Asaas. Quando o webhook confirmar,
        // pollUntilLibraryHas detecta e volta pro Leitor automaticamente.
        const slug = book.id
        const returnUrl = 'https://preview.automacaojs.us/leitor-inteligente/#/library?from=asaas&book=' + encodeURIComponent(slug)
        pollUntilLibraryHas(slug, returnUrl, 60000).catch(() => {})
        window.location.href = data.checkout_url
        return next  // usuário vai voltar depois do pagamento
      }
      console.error('[payment] erro:', data.error)
      return state
    } catch (e) {
      console.error('[payment] exception:', e)
      return state
    }
  }

  persistLibrary(next)
  return next
}

async function currentUserEmail(): Promise<string | null> {
  if (SUPABASE_READY) {
    const { data } = await supabase.auth.getSession()
    return data.session?.user?.email ?? null
  }
  return null
}

export async function trackProgressRemote(
  state: ProgressState,
  book: Book,
  page: number,
): Promise<ProgressState> {
  const userId = await currentUserId()
  const next = saveProgress(state, userId, book.id, page, book.totalPages)
  if (SUPABASE_READY && userId !== DEFAULT_USER.id) {
    await saveRemoteProgress(book.id, page)
  }
  persistProgress(next)
  return next
}

export async function fetchRemoteLibrary(): Promise<LibraryState | null> {
  return loadRemoteLibrary()
}

export async function fetchRemoteProgress(): Promise<ProgressState | null> {
  return loadRemoteProgress()
}

/**
 * Monitora se um ebook específico foi liberado na user_library.
 * Usado após redirecionar pro Asaas checkout — quando o webhook do Asaas
 * confirmar o pagamento, o item aparece na user_library.
 *
 * Quando detectar, redireciona o user de volta pro Leitor automaticamente.
 */
export async function pollUntilLibraryHas(
  bookSlug: string,
  redirectUrl: string,
  timeoutMs: number = 60000,
): Promise<boolean> {
  if (!SUPABASE_READY) return false
  const { data: session } = await supabase.auth.getSession()
  if (!session.session) return false

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000))
    const lib = await loadRemoteLibrary()
    if (lib && lib.purchases.some((p) => p.bookId === bookSlug)) {
      // Livro liberado! Redireciona de volta pro Leitor
      window.location.href = redirectUrl
      return true
    }
  }
  return false
}

export { CATALOG }