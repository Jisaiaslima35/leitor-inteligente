export interface BookChunk {
  id: string
  title: string
  page: number
  text: string
}

export interface RagSource {
  id: string
  title: string
  page: number
  excerpt: string
}

export interface RagAnswer {
  answer: string
  sources: RagSource[]
}

const STOPWORDS = new Set([
  'a','o','as','os','de','da','do','das','dos','e','ou','em','no','na','nos','nas',
  'para','por','que','com','um','uma','é','foi','ser','ter','se','sua','seu',
  'the','of','and','to','in','on','for','with','is','are'
])

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
}

function scoreChunk(question: string, chunk: BookChunk): number {
  const tokens = tokenize(question)
  if (tokens.length === 0) return 0
  const lower = `${chunk.title} ${chunk.text}`.toLowerCase()
  return tokens.reduce((score, token) => (lower.includes(token) ? score + 1 : score), 0)
}

export function retrieveContext(question: string, chunks: BookChunk[], topK = 2): BookChunk[] {
  return [...chunks]
    .map((chunk) => ({ chunk, score: scoreChunk(question, chunk) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((item) => item.chunk)
}

function excerptFrom(chunk: BookChunk): string {
  const trimmed = chunk.text.trim()
  return trimmed.length > 180 ? `${trimmed.slice(0, 180).trim()}…` : trimmed
}

export function answerQuestion(question: string, chunks: BookChunk[]): RagAnswer {
  const matches = retrieveContext(question, chunks, 1)
  if (matches.length === 0) {
    return {
      answer:
        'Ainda não encontrei um trecho do livro que responda diretamente. Tente reformular com palavras diferentes, ou me peça para explicar o conceito.',
      sources: [],
    }
  }
  const best = matches[0]
  return {
    answer:
      `Em "${best.title}" (página ${best.page}) o autor explica que ${best.text.replace(/\.$/, '').toLowerCase()}.` +
      ` Por isso, para sua pergunta, vale observar a deixa que dispara a rotina e a recompensa que a mantém.`,
    sources: [
      {
        id: best.id,
        title: best.title,
        page: best.page,
        excerpt: excerptFrom(best),
      },
    ],
  }
}