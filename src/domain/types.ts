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
  /** Categoria do livro — controla quais features extras habilita.
   *  Adicionado 23/08/2026: Sala Dev só abre se === 'programacao'. */
  categoria: Categoria
}

/** Categorias oficiais do Leitor.
 *  24/08/2026 (P4 Isaías): reduzido pra 2 categorias. Todo upload é
 *  OBRIGATÓRIO escolher uma das duas — sem default silencioso no
 *  backend (retorna 400). Schema Supabase: CHECK constraint + NOT NULL.
 *    comum       → livro comum (ficção, gospel, autoajuda, etc)
 *    programacao → livro de Tecnologia ou Programação (Sala Dev ON)
 */
export type Categoria =
  | 'comum'         // livro comum — sem Área Dev
  | 'programacao'   // Tecnologia ou Programação — Sala Dev habilitada

export const CATEGORIAS: Categoria[] = ['comum', 'programacao']

export const CATEGORIA_LABEL: Record<Categoria, string> = {
  comum: 'Livro comum',
  programacao: 'Livro de Tecnologia ou programação',
}