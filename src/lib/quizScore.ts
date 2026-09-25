import { supabase } from './supabase'
import { BASE_URL } from './baseUrl'

export interface QuizScoreData {
  totalPoints: number      // Soma acumulativa (permite valores positivos e negativos)
  quizzesCompleted: number // Total de quizzes respondidos
  correctAnswers: number   // Total de acertos acumulados
  wrongAnswers: number     // Total de erros acumulados
  bestStreak: number       // Melhor sequência de acertos em uma única rodada
}

export const SCORE_CORRECT = 10
export const SCORE_WRONG = -5

function getStorageKey(bookId: string): string {
  return `quiz_score_${bookId}`
}

/**
 * Lê o placar local do livro a partir do localStorage.
 * Retorna zeros estruturados caso não exista.
 */
export function getLocalQuizScore(bookId: string): QuizScoreData {
  if (typeof window === 'undefined' || !bookId) {
    return { totalPoints: 0, quizzesCompleted: 0, correctAnswers: 0, wrongAnswers: 0, bestStreak: 0 }
  }
  try {
    const raw = localStorage.getItem(getStorageKey(bookId))
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        totalPoints: typeof parsed.totalPoints === 'number' ? parsed.totalPoints : 0,
        quizzesCompleted: typeof parsed.quizzesCompleted === 'number' ? parsed.quizzesCompleted : 0,
        correctAnswers: typeof parsed.correctAnswers === 'number' ? parsed.correctAnswers : 0,
        wrongAnswers: typeof parsed.wrongAnswers === 'number' ? parsed.wrongAnswers : 0,
        bestStreak: typeof parsed.bestStreak === 'number' ? parsed.bestStreak : 0,
      }
    }
  } catch (e) {
    console.warn('[quizScore] Erro ao ler score do localStorage:', e)
  }
  return { totalPoints: 0, quizzesCompleted: 0, correctAnswers: 0, wrongAnswers: 0, bestStreak: 0 }
}

/**
 * Salva o placar local do livro no localStorage.
 */
export function saveLocalQuizScore(bookId: string, data: QuizScoreData): void {
  if (typeof window === 'undefined' || !bookId) return
  try {
    localStorage.setItem(getStorageKey(bookId), JSON.stringify(data))
  } catch (e) {
    console.warn('[quizScore] Erro ao salvar score no localStorage:', e)
  }
}

/**
 * Aplica o resultado de uma rodada de quiz:
 * - Correta: +10 pts
 * - Errada: -5 pts
 * Salva imediatamente no localStorage (offline-first) e retorna o score atualizado + delta da rodada.
 */
export function applyQuizResultToScore(
  bookId: string,
  correct: number,
  wrong: number,
): { updated: QuizScoreData; roundDelta: number } {
  const current = getLocalQuizScore(bookId)
  const roundDelta = correct * SCORE_CORRECT + wrong * SCORE_WRONG

  const updated: QuizScoreData = {
    totalPoints: current.totalPoints + roundDelta,
    quizzesCompleted: current.quizzesCompleted + 1,
    correctAnswers: current.correctAnswers + correct,
    wrongAnswers: current.wrongAnswers + wrong,
    bestStreak: Math.max(current.bestStreak, correct),
  }

  saveLocalQuizScore(bookId, updated)
  return { updated, roundDelta }
}

/**
 * Busca o placar acumulado no backend Supabase (/api/quiz/score).
 * Se autenticado, recupera a soma remota. Se houver falha (401/500/offline), retorna null sem quebrar.
 */
export async function fetchRemoteQuizScore(bookId: string): Promise<QuizScoreData | null> {
  if (!bookId) return null
  try {
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData.session?.access_token
    if (!token) return null

    const r = await fetch(
      `${BASE_URL}api/quiz/score?book_id=${encodeURIComponent(bookId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    )

    if (!r.ok) {
      console.warn(`[quizScore] GET /api/quiz/score respondeu status ${r.status}`)
      return null
    }

    const data = await r.json()
    if (!data.ok) return null

    return {
      totalPoints: typeof data.total_score === 'number' ? data.total_score : 0,
      quizzesCompleted: typeof data.quizzes_count === 'number' ? data.quizzes_count : 0,
      correctAnswers: typeof data.correct_answers === 'number' ? data.correct_answers : 0,
      wrongAnswers: typeof data.wrong_answers === 'number' ? data.wrong_answers : 0,
      bestStreak: typeof data.best_correct === 'number' ? data.best_correct : 0,
    }
  } catch (e) {
    console.warn('[quizScore] Falha de conexão ao buscar score remoto:', e)
    return null
  }
}

/**
 * Envia o resultado do quiz para o backend (/api/quiz/save).
 * Se `roomId` for informado, persiste também em `academic_evaluations`
 * (visão de turma — Sala de Aula Interativa).
 * Execução assíncrona tolerante a falhas (não-bloqueante).
 */
export async function syncQuizScoreWithBackend(
  bookId: string,
  pageNumber: number,
  correct: number,
  wrong: number,
  opts?: { roomId?: string; studentName?: string },
): Promise<boolean> {
  if (!bookId) return false
  try {
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData.session?.access_token
    if (!token) {
      console.info('[quizScore] Usuário não logado, score mantido exclusivamente no localStorage')
      return false
    }

    const payload: Record<string, unknown> = {
      book_id: bookId,
      page_number: pageNumber,
      correct,
      wrong,
    }
    if (opts?.roomId) payload.room_id = opts.roomId
    if (opts?.studentName) payload.student_name = opts.studentName

    const r = await fetch(`${BASE_URL}api/quiz/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    })

    if (!r.ok) {
      console.warn(`[quizScore] POST /api/quiz/save retornou ${r.status}`)
      return false
    }

    const resJson = await r.json()
    return !!resJson.ok
  } catch (e) {
    console.warn('[quizScore] sync com backend falhou (offline/timeout):', e)
    return false
  }
}
