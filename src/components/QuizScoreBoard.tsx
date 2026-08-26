import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Trophy, Target, BookOpen } from 'lucide-react'

interface Score {
  total_score: number
  quizzes_count: number
  best_correct: number
}

interface Props {
  bookId: string
  bookTitle?: string
  // muda toda vez que o QuizModal termina um quiz (incrementar 1 → refetch)
  reloadKey: number
}

export function QuizScoreBoard({ bookId, bookTitle, reloadKey }: Props) {
  const [score, setScore] = useState<Score | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)

    ;(async () => {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (!token) {
        if (!cancelled) {
          setScore(null)
          setLoading(false)
        }
        return
      }
      try {
        const r = await fetch(
          `/leitor-inteligente/api/quiz/score?book_id=${encodeURIComponent(bookId)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        const data = await r.json()
        if (cancelled) return
        if (data.ok) {
          setScore(data)
        } else {
          setErr(data.error || 'Falha ao buscar placar')
        }
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : 'Erro')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [bookId, reloadKey])

  // Sem sessão: nem mostra o placar
  if (!loading && !score && !err) return null

  const total = score?.total_score ?? 0
  const quizzes = score?.quizzes_count ?? 0
  const best = score?.best_correct ?? 0
  const scoreColor =
    total > 0 ? '#22c55e' : total === 0 ? '#d4af37' : '#ef4444'

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Placar de quizzes do livro"
      data-testid="quiz-score-board"
      style={{
        marginTop: 20,
        marginBottom: 4,
        padding: '14px 18px',
        background: 'linear-gradient(135deg, #2a2540, #3a3150)',
        border: '1px solid #d4af37',
        borderRadius: 12,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 18,
        color: '#e8e0d0',
        boxShadow: '0 4px 16px rgba(212, 175, 55, 0.15)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Trophy size={20} color="#d4af37" />
        <strong style={{ fontFamily: 'Georgia, serif', color: '#d4af37', fontSize: 15 }}>
          Placar do Quiz
        </strong>
      </div>

      {/* Pontuação total — destaque principal */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginLeft: 8 }}>
        <span style={{ fontSize: 28, fontWeight: 800, color: scoreColor, lineHeight: 1 }}>
          {loading && !score ? '…' : `${total > 0 ? '+' : ''}${total}`}
        </span>
        <span style={{ fontSize: 13, color: '#a89cc8' }}>pts</span>
      </div>

      {/* Separador vertical */}
      <div style={{ width: 1, height: 28, background: '#4a4060' }} aria-hidden="true" />

      {/* Quizzes respondidos */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <BookOpen size={16} color="#a89cc8" />
        <span style={{ fontSize: 13 }}>
          <strong style={{ color: '#e8e0d0' }}>{quizzes}</strong>{' '}
          <span style={{ color: '#a89cc8' }}>
            quiz{quizzes !== 1 ? 'zes' : ''} feito{quizzes !== 1 ? 's' : ''}
          </span>
        </span>
      </div>

      {/* Melhor rodada */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Target size={16} color="#a89cc8" />
        <span style={{ fontSize: 13 }}>
          <span style={{ color: '#a89cc8' }}>melhor </span>
          <strong style={{ color: '#e8e0d0' }}>{best}</strong>
          <span style={{ color: '#a89cc8' }}>/3 acertos</span>
        </span>
      </div>

      {bookTitle && (
        <>
          <div style={{ width: 1, height: 28, background: '#4a4060' }} aria-hidden="true" />
          <small style={{ color: '#a89cc8', fontSize: 12 }}>
            📖 {bookTitle}
          </small>
        </>
      )}

      {err && (
        <small style={{ color: '#ef4444', fontSize: 12 }}>⚠ {err}</small>
      )}
    </div>
  )
}