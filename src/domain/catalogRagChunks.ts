// Chunks de RAG (Retrieval-Augmented Generation) por slug de livro.
// Fonte: src/domain/catalog.ts original (preservada por instrução de Isaías).
//
// NÃO usar este arquivo como fonte de CATÁLOGO/VITRINE. Vitrine = Supabase.
// Aqui é só material pro Leitor IA (chat com o livro).
//
// Quando o admin publica um novo livro, os chunks são gerados pelo
// upload_book.py e gravados em outro lugar (futuro: tabela ebook_chunks).
// Por enquanto, os livros hardcoded aqui continuam disponíveis pra
// reuso caso o admin decida republicar.

import type { BookChunk } from './rag'

export const RAG_CHUNKS_BY_SLUG: Record<string, BookChunk[]> = {
  'o-poder-do-habito': [],  // HABIT_BOOK_CHUNKS (importado sob demanda em habitBook.ts)
  'focus-book': [
    {
      id: 'attention',
      title: 'A anatomia da atenção',
      page: 28,
      text: 'A atenção opera em dois modos: foco estreito, quando precisamos resolver um problema específico, e foco aberto, que capta sinais do ambiente.',
    },
    {
      id: 'smartphone',
      title: 'A distração digital',
      page: 88,
      text: 'Cada notificação interrompe o fluxo de foco profundo e custa até 23 minutos para que o cérebro recupere a linha de raciocínio original.',
    },
  ],
  'creative-mind': [
    {
      id: 'creative-confidence',
      title: 'Confiança criativa',
      page: 22,
      text: 'Confiança criativa é a crença de que você tem ideias boas e a capacidade de fazê-las acontecer. É uma habilidade treinável, não um talento nato.',
    },
  ],
  'fabricante-de-lagrimas': [
    {
      id: 'n-personagem',
      title: 'Nica — a protagonista',
      page: 244,
      text: 'Nica tem 17 anos e carrega nas costas o peso de uma infância em orfanatos. Sensível, marcada por experiências dolorosas e com medo de ser rejeitada, ela aprendeu a se proteger do mundo.',
    },
  ],
  'biblia-dake-galatas': [
    {
      id: 'galatas-justificacao',
      title: 'Justificação pela fé',
      page: 2,
      text: 'A justificação é somente pela fé, sem as obras da lei (2.15-3.29). Paulo corrige os gálatas que estavam sendo influenciados por mestres judaizantes vindos da Judéia.',
    },
  ],
  'teste-r5': [],
}

export function getRagChunksForSlug(slug: string): BookChunk[] {
  return RAG_CHUNKS_BY_SLUG[slug] || []
}
