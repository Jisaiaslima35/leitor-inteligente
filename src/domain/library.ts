import type { LibraryState, Purchase } from './types'

export function ownsBook(state: LibraryState, userId: string, bookId: string): boolean {
  return state.purchases.some((purchase) =>
    purchase.userId === userId && purchase.bookId === bookId && purchase.status === 'approved'
  )
}

export function checkoutBook(state: LibraryState, userId: string, bookId: string): LibraryState {
  if (ownsBook(state, userId, bookId)) {
    return state
  }
  const newPurchase: Purchase = {
    id: `purchase-${userId}-${bookId}`,
    userId,
    bookId,
    purchasedAt: new Date().toISOString(),
    status: 'approved',
  }
  return {
    ...state,
    purchases: [...state.purchases, newPurchase],
  }
}

export type { LibraryState, Purchase, ProgressState } from './types'