import type { LibraryState, Purchase } from './types'

export function ownsBook(state: LibraryState, userId: string, bookId: string): boolean {
  return state.purchases.some((purchase) =>
    purchase.userId === userId && purchase.bookId === bookId && purchase.status === 'approved'
  )
}

export function checkoutBook(state: LibraryState, userId: string, bookId: string): LibraryState {
  if (ownsBook(state, userId, bookId)) return state

  const next: Purchase = {
    id: `${userId}-${bookId}`,
    userId,
    bookId,
    status: 'approved',
    purchasedAt: new Date().toISOString(),
  }

  return {
    purchases: [...state.purchases, next],
  }
}

export type { LibraryState, Purchase, ProgressState } from './types'