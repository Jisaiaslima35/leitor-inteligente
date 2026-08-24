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
 *  24/08/2026 (P4 Isaías): reduzido pra 2 categorias.
 *  24/08/2026 (P8 Isaías): expandido pra 7 valores (6 novos pro usuário
 *  escolher no radio obrigatório). 'comum' continua existindo pra não
 *  quebrar os 19 livros legados do P4. Schema Supabase:
 *  CHECK constraint cobre todos os 7 valores.
 *
 *    comum         → livro comum (legado P4, fica como bucket genérico)
 *    programacao   → Tecnologia ou Programação (Sala Dev habilitada)
 *    tecnologia    → Tecnologia Geral (sem Área Dev por enquanto)
 *    gospel        → literatura gospel/evangélica
 *    literatura    → ficção/clássicos/poesia
 *    autoajuda     → desenvolvimento pessoal/produtividade
 *    outros        → catch-all (espécies não mapeadas)
 */
export type Categoria =
  | 'comum'
  | 'programacao'
  | 'tecnologia'
  | 'gospel'
  | 'literatura'
  | 'autoajuda'
  | 'outros'

export const CATEGORIAS: Categoria[] = [
  'comum',
  'programacao',
  'tecnologia',
  'gospel',
  'literatura',
  'autoajuda',
  'outros',
]

export const CATEGORIA_LABEL: Record<Categoria, string> = {
  comum: 'Livro comum',
  programacao: 'Programação / Tecnologia',
  tecnologia: 'Tecnologia Geral',
  gospel: 'Gospel / Cristão',
  literatura: 'Literatura / Ficção',
  autoajuda: 'Autoajuda / Crescimento',
  outros: 'Outros',
}