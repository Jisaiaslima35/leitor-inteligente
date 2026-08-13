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

// === Validação de sessão Supabase ===
// getSession() retorna a sessão do localStorage do cliente Supabase JS. Se a anon
// key foi rotacionada pelo backend ou o token expirou, getSession() retorna
// sessão nula mesmo com UI mostrando "logado". Confiamos só em getSession(),
// nunca no estado React.
async function getValidSession(): Promise<{ userId: string; email: string } | null> {
  if (!SUPABASE_READY) return null
  const { data } = await supabase.auth.getSession()
  const s = data.session
  if (!s?.user?.id || !s.user.email) return null
  return { userId: s.user.id, email: s.user.email }
}

export async function buyBookRemote(book: Book, state: LibraryState): Promise<LibraryState> {
  // DECISÃO 13/08/2026 (revisão): fluxo via GET redirect no servidor.
  //
  // Por que GET e não POST+location.href:
  //   - window.location.href após fetch async falha silencioso em mobile (gesture
  //     timeout, popup blocker, session perdida)
  //   - Solução: uma única navegação GET para /api/checkout/redirect no backend.
  //     Server cria checkout e retorna 302 direto pro Asaas. Browser trata como
  //     navegação normal, sem race condition.
  //
  // Bug de segurança corrigido:
  //   - Antes: se getSession() retornasse null, o código caía no fallback
  //     `persistLibrary(next)` que liberava o livro sem pagar. Risco: rotação
  //     de anon key quebrou sessão e mostrou bug "fecha e abre a aba" — porque
  //     o livro era persistido localmente (sem Asaas, sem webhook), a aba voltava
  //     ao mesmo ponto ("pisca"), e ninguém era notificado.
  //   - Agora: se NÃO tem sessão Supabase válida, NÃO persiste. Pede login.
  //
  // Fluxo após pagamento: user volta pro Leitor (sucesso_url = /library), vê o
  // livro na Biblioteca e nas Compras. Sem polling client-side.
  const slug = book.id

  // 1. Sessão válida é obrigatória para comprar. Sem sessão = pedir login.
  const sess = await getValidSession()
  if (!sess) {
    console.warn('[payment] sem sessão Supabase válida — redireciona pra login')
    try { window.localStorage.removeItem('leitor-ia:pending-checkout') } catch {}
    window.location.hash = '#/login?reason=checkout&book=' + encodeURIComponent(book.id)
    return state  // NÃO persiste nada
  }

  // 2. Marca flag visual pra Loja mostrar "Pagou?" quando voltar
  if (hasStorage()) {
    try {
      window.localStorage.setItem(
        'leitor-ia:pending-checkout',
        JSON.stringify({ bookId: slug, bookTitle: book.title, at: Date.now() }),
      )
    } catch { /* sem storage — segue sem banner */ }
  }

  // 3. Navegação GET direta para o endpoint de redirect do backend.
  // GET em window.location.href é o jeito mais robusto em mobile: o browser
  // não cancela um redirect que veio de um user gesture (click), mesmo que o
  // usuário esteja offline por 1s durante o request.
  const backUrl = 'https://preview.automacaojs.us/leitor-inteligente/#/library'
  const redirectUrl =
    `https://pay.automacaojs.us/api/checkout/redirect` +
    `?slug=${encodeURIComponent(book.id)}` +
    `&email=${encodeURIComponent(sess.email)}` +
    `&uid=${encodeURIComponent(sess.userId)}` +
    `&back=${encodeURIComponent(backUrl)}`

  window.location.href = redirectUrl

  // Nunca chega aqui (browser mudou de página). Mas tipamos o retorno.
  return state
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