import type { Book } from './types'
import type { BookChunk } from './rag'
import { HABIT_BOOK_CHUNKS } from './habitBook'

export const CATALOG: Book[] = [
  {
    id: 'o-poder-do-habito',
    title: 'O Poder do Hábito',
    author: 'Charles Duhigg',
    description:
      'Por que fazemos o que fazemos na vida e nos negócios. Um clássico moderno sobre a ciência por trás dos hábitos e como reprogramá-los.',
    price: 2990,
    totalPages: 354,
    cover: 'https://images.unsplash.com/photo-1544947950-fa07a98d237f?w=600&h=900&fit=crop',
    highlights: [
      'O loop do hábito: deixa, rotina, recompensa',
      'Hábitos angulares e o poder das pequenas vitórias',
      'Como empresas como Starbucks usam a ciência dos hábitos',
      'Método para reescrever qualquer hábito em 4 passos',
    ],
    chunks: HABIT_BOOK_CHUNKS,
  },
  {
    id: 'focus-book',
    title: 'Foco Absoluto',
    author: 'Daniel Goleman',
    description:
      'A ciência do foco, da atenção e do desempenho máximo. Aprenda a treinar a atenção para resultados extraordinários.',
    price: 3990,
    totalPages: 248,
    cover: 'https://images.unsplash.com/photo-1495446815901-a7297e633e8d?w=600&h=900&fit=crop',
    highlights: [
      'Atenção: o recurso mais escasso do século 21',
      'Os três tipos de foco e como treiná-los',
      'Como o estresse destrói a atenção',
      'Hábitos diários para foco profundo',
    ],
    chunks: [
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
  },
  {
    id: 'creative-mind',
    title: 'A Mente Criativa',
    author: 'Tom Kelley',
    description:
      'Técnicas para liberar o potencial criativo e construir uma vida cheia de ideias originais e realizações significativas.',
    price: 3490,
    totalPages: 196,
    cover: 'https://images.unsplash.com/photo-1532012197267-da84d127e765?w=600&h=900&fit=crop',
    highlights: [
      'Confiança criativa: como despertá-la',
      'O método dos sete caminhos para inovar',
      'Técnica do brainstorm radical',
      'Como montar um time criativo de alta performance',
    ],
    chunks: [
      {
        id: 'creative-confidence',
        title: 'Confiança criativa',
        page: 22,
        text: 'Confiança criativa é a crença de que você tem ideias boas e a capacidade de fazê-las acontecer. É uma habilidade treinável, não um talento nato.',
      },
    ],
  },
  {
    id: 'fabricante-de-lagrimas',
    title: 'O Fabricante de Lágrimas',
    author: 'Erin Doom',
    description: 'O fenômeno internacional da literatura jovem adulta. Nica e Rigel, dois adolescentes adotados pela mesma família, descobrem que carregam cicatrizes que os tornaram quem são. Uma história de amor, dor e superação que já conquistou milhões de leitores.',
    price: 1999,
    totalPages: 653,
    cover: 'https://images.unsplash.com/photo-1543002588-bfa74002ed7e?w=600&h=900&fit=crop',
    highlights: [
      'Um dos maiores best-sellers da literatura jovem adulta',
      'História de amor, dor e superação entre dois adolescentes adotados',
      'Adaptação cinematográfica em desenvolvimento',
      'Profundo, emocionante e inesquecível',
    ],
    chunks: [
      {
        id: 'n-personagem',
        title: 'Nica — a protagonista',
        page: 244,
        text: 'Nica tem 17 anos e carrega nas costas o peso de uma infância em orfanatos. Sensível, marcada por experiências dolorosas e com medo de ser rejeitada, ela aprendeu a se proteger do mundo.',
      },
    ],
  },
  {
    id: 'biblia-dake-galatas',
    title: 'Bíblia de Estudo Dake — Gálatas',
    author: 'Finis Jennings Dake',
    description: 'Estudo exegético do livro de Gálatas. Inclui sumário, 8 doutrinas em destaque, divisões por versículo, referências cruzadas e notas teológicas.',
    price: 0,
    totalPages: 12,
    // Capa carregada dinamicamente do Supabase Storage via getCoverURL(bookId)
    cover: '',
    highlights: [
      '8 doutrinas em destaque na Epístola aos Gálatas',
      'Justificação pela fé sem as obras da lei',
      'Abolição da lei de Moisés no contexto da nova aliança',
      'Estudo exegético versículo por versículo',
    ],
    chunks: [
      {
        id: 'galatas-justificacao',
        title: 'Justificação pela fé',
        page: 2,
        text: 'A justificação é somente pela fé, sem as obras da lei (2.15-3.29). Paulo corrige os gálatas que estavam sendo influenciados por mestres judaizantes vindos da Judéia.',
      },
    ],
  },
  {
    id: 'teste-r5',
    title: 'Ebook Teste R$5 — Hermes',
    author: 'Isaías (teste)',
    description: 'Ebook criado pra testar checkout dinâmico do Asaas sandbox. Pode deletar depois.',
    price: 500,
    totalPages: 10,
    cover: '',
    highlights: [
      'Teste de checkout dinâmico',
      'Integração Asaas sandbox',
      'Webhook PAYMENT_RECEIVED',
    ],
    chunks: [],
  },
]

export function findBook(bookId: string): Book | undefined {
  return CATALOG.find((book) => book.id === bookId)
}

export type { Book } from './types'
export type { BookChunk } from './rag'
