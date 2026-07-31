import type { ProgressState, ReadingProgress } from './types'

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function keyFor(userId: string, bookId: string): string {
  return `${userId}::${bookId}`
}

export { keyFor }

export function saveProgress(
  state: ProgressState,
  userId: string,
  bookId: string,
  page: number,
  totalPages: number
): ProgressState {
  const safePage = clamp(Math.floor(page), 1, totalPages)
  const percent = Math.round((safePage / totalPages) * 100)
  const next: ReadingProgress = {
    page: safePage,
    totalPages,
    percent,
    updatedAt: new Date().toISOString(),
  }
  return {
    ...state,
    [keyFor(userId, bookId)]: next,
  }
}

export function getProgress(
  state: ProgressState,
  userId: string,
  bookId: string
): ReadingProgress | null {
  return state[keyFor(userId, bookId)] ?? null
}