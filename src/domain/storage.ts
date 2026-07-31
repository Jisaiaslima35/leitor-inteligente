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
  const next = checkoutBook(state, userId, book.id)
  if (SUPABASE_READY && userId !== DEFAULT_USER.id) {
    const ok = await addRemotePurchase(book.id)
    if (!ok) return state // falha silenciosa — não remove do local
  }
  persistLibrary(next)
  return next
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

export { CATALOG }