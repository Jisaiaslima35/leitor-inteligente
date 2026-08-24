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

/** Categorias oficiais do Leitor. Default no Supabase: 'outros'
 *  (admin tem que marcar explicitamente como 'programacao' pra
 *  habilitar Sala Dev). */
export type Categoria =
  | 'programacao'   // Sala Dev habilitada
  | 'tecnologia'    // futuro: tech geral, sem playground de código
  | 'gospel'
  | 'literatura'
  | 'autoajuda'
  | 'outros'

export const CATEGORIAS: Categoria[] = [
  'programacao', 'tecnologia', 'gospel', 'literatura', 'autoajuda', 'outros',
]

export const CATEGORIA_LABEL: Record<Categoria, string> = {
  programacao: 'Programação',
  tecnologia: 'Tecnologia (geral)',
  gospel: 'Gospel / Religioso',
  literatura: 'Literatura',
  autoajuda: 'Autoajuda',
  outros: 'Outros',
}