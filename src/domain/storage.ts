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
  // PRIMEIRO: abre janela de checkout sincronamente (dentro do user gesture
  // do click em "Confirmar"). Browsers matam popup se window.open vier
  // depois de await. Depois preenchemos a URL.
  const slug = book.id
  const returnUrl = 'https://preview.automacaojs.us/leitor-inteligente/#/library?from=asaas&book=' + encodeURIComponent(slug)
  const checkoutTab = window.open('about:blank', '_blank', 'noopener,noreferrer')

  const userId = await currentUserId()
  const userEmail = await currentUserEmail()
  const next = checkoutBook(state, userId, book.id)

  // Se logado e Supabase OK, chama payment server pra criar checkout dinâmico
  if (SUPABASE_READY && userId !== DEFAULT_USER.id && userEmail) {
    if (!checkoutTab) {
      // Popup bloqueado — cai pro redirect direto
      console.warn('[payment] popup bloqueado, usando redirect direto')
      pollUntilLibraryHas(slug, null, returnUrl, 60000).catch(() => {})
      try {
        const useSimulationFb = (window as any).__CAKTO_SIMULATION__ === true
        const endpointFb = useSimulationFb ? '/api/payment/simulate-flow' : '/api/checkout/create'
        const rFb = await fetch(`https://pay.automacaojs.us${endpointFb}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ebook_slug: book.id,
            customer_email: userEmail,
            customer_id: userId,
            success_url: 'https://preview.automacaojs.us/leitor-inteligente/#/library',
            cancel_url: 'https://preview.automacaojs.us/leitor-inteligente/#/store',
          }),
        })
        const dataFb = await rFb.json()
        if (dataFb.ok && dataFb.checkout_url) {
          window.location.href = dataFb.checkout_url
        }
      } catch (e) {
        console.error('[payment] exception fallback:', e)
      }
      return next
    }

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
        // Redireciona a janela já aberta pra URL do checkout Asaas
        try { checkoutTab.location.href = data.checkout_url } catch { /* aba já fechada — fallback */ }
        pollUntilLibraryHas(slug, checkoutTab, returnUrl, 60000).catch(() => {})
        return next  // usuário volta via polling quando webhook liberar
      }
      console.error('[payment] erro:', data.error)
      try { checkoutTab.close() } catch { /* aba já fechada */ }
      return state
    } catch (e) {
      console.error('[payment] exception:', e)
      try { checkoutTab.close() } catch { /* aba já fechada */ }
      return state
    }
  }

  // Não logado: não precisava de checkout, fecha a janela vazia que abrimos
  if (checkoutTab) {
    try { checkoutTab.close() } catch { /* aba já fechada */ }
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
 * Roda na aba original (a que abriu checkout em window.open).
 * Quando o webhook do Asaas libera o item na user_library:
 *   1. fecha a aba de checkout (se ainda aberta)
 *   2. dispara CustomEvent 'leitor:library-updated' — o App.tsx escuta
 *      e mostra o modal "Você será redirecionado em 5s" + navega pra
 *      Biblioteca
 *
 * `timeoutMs` default = 5min. Asaas sandbox às vezes demora 30-90s.
 */
export async function pollUntilLibraryHas(
  bookSlug: string,
  checkoutTab: Window | null,
  redirectUrl: string,
  timeoutMs: number = 300000,
): Promise<boolean> {
  if (!SUPABASE_READY) return false
  const { data: session } = await supabase.auth.getSession()
  if (!session.session) return false

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000))
    const lib = await loadRemoteLibrary()
    if (lib && lib.purchases.some((p) => p.bookId === bookSlug)) {
      // Livro liberado! Fecha checkout (se ainda aberto) e avisa o App
      try { checkoutTab?.close() } catch { /* aba já fechada — ignora */ }
      window.dispatchEvent(new CustomEvent('leitor:library-updated', {
        detail: { bookSlug, redirectUrl },
      }))
      return true
    }
  }
  return false
}

export { CATALOG }