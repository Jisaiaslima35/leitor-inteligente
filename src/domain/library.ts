import type { LibraryState, Purchase } from './types'

export function ownsBook(state: LibraryState, userId: string, bookId: string): boolean {
  return state.purchases.some((purchase) =>
    purchase.userId === userId && purchase.bookId === bookId && purchase.status === 'approved'
  )
}

export function checkoutBook(state: LibraryState, userId: string, bookId: string): LibraryState {
  // NÃO adiciona o livro aqui — isso era o bug. A compra só vai pra biblioteca
  // depois que o webhook do provider (Asaas/Cakto) confirmar o pagamento.
  // Por enquanto retorna state inalterado.
  return state
}

export type { LibraryState, Purchase, ProgressState } from './types'