// ATENÇÃO: este arquivo NÃO é mais fonte de catálogo/vitrine.
// Vitrine = Supabase (carregado por src/lib/catalogSupabase.ts).
//
// Preservado só pra satisfazer imports legados (ex: BuyPage usa findBookInCatalog
// como fallback benigno — quando o slug não vem do Supabase, cai no array vazio
// e loadBookFromSupabase resolve).
//
// Os chunks de RAG foram movidos pra src/domain/catalogRagChunks.ts.

import type { Book } from './types'
import type { BookChunk } from './rag'

// Catálogo estático REMOVIDO. Supabase é a única fonte oficial da vitrine.
// Manter array vazio pra BuyPage.findBookInCatalog() retornar undefined e
// cair no loadBookFromSupabase() (que é o caminho desejado).
export const CATALOG: Book[] = []

export function findBook(_bookId: string): Book | undefined {
  return undefined
}

export type { Book } from './types'
export type { BookChunk } from './rag'
