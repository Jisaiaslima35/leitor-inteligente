import type { BookChunk } from './rag'

export interface User {
  id: string
  name: string
  email: string
}

export const DEFAULT_USER: User = {
  id: 'demo-user',
  name: 'Leitor Demo',
  email: 'demo@leitor.ia',
}

export interface Purchase {
  id: string
  userId: string
  bookId: string
  status: 'approved'
  purchasedAt: string
  ownerUserId?: string | null
}

export interface LibraryState {
  purchases: Purchase[]
}

export interface ReadingProgress {
  page: number
  totalPages: number
  percent: number
  updatedAt: string
}

export type ProgressState = Record<string, ReadingProgress>

export interface Book {
  id: string
  title: string
  author: string
  cover: string
  description: string
  price: number
  totalPages: number
  highlights: string[]
  chunks: readonly BookChunk[]
}