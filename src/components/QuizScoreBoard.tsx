import { useEffect, useState } from 'react'
import { Trophy, BookOpen, CheckCircle2, XCircle, Target } from 'lucide-react'
import {
  QuizScoreData,
  getLocalQuizScore,
  saveLocalQuizScore,
  fetchRemoteQuizScore,
} from '../lib/quizScore'

interface Props {
  bookId: string
  bookTitle?: string
  // muda toda vez que o QuizModal termina um quiz (incrementar 1 → refetch/reload)
  reloadKey: number
}

export function QuizScoreBoard({ bookId, bookTitle, reloadKey }: Props) {
  // Inicialização síncrona offline-first: leitura imediata do localStorage
  const [score, setScore] = useState<QuizScoreData>(() => getLocalQuizScore(bookId))

  useEffect(() => {
    let active = true

    // 1. Garante que o score local esteja atualizado na troca de livro ou reload
    const local = getLocalQuizScore(bookId)
    setScore(local)

    // 2. Consulta o backend de forma assíncrona tolerante a falhas (com Bearer token)
    fetchRemoteQuizScore(bookId).then((remote) => {
      if (!active || !remote) return

      // Se o backend tem mais quizzes completados que o local, adota os dados do backend
      if (remote.quizzesCompleted >= local.quizzesCompleted) {
        saveLocalQuizScore(bookId, remote)
        setScore(remote)
      } else if (local.quizzesCompleted > remote.quizzesCompleted) {
        // Se o local tem quizzes mais recentes (ex.: realizados offline), mantém o local
        setScore(local)
      }
    })

    return () => {
      active = false
    }
  }, [bookId, reloadKey])

  const total = score.totalPoints
  const quizzes = score.quizzesCompleted
  const correct = score.correctAnswers
  const wrong = score.wrongAnswers
  const best = score.bestStreak

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
        marginBottom: 12,
        padding: '12px 18px',
        background: 'linear-gradient(135deg, #1e1b2e 0%, #2c2440 50%, #1f1b30 100%)',
        border: '1px solid rgba(212, 175, 55, 0.4)',
        borderRadius: 12,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 16,
        color: '#e8e0d0',
        boxShadow: '0 4px 18px rgba(0, 0, 0, 0.35)',
      }}
    >
      {/* 🏆 Placar: X pts */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: 'rgba(212, 175, 55, 0.15)',
            border: '1px solid rgba(212, 175, 55, 0.3)',
          }}
        >
          <Trophy size={18} color="#d4af37" />
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <strong style={{ fontFamily: 'Georgia, serif', color: '#d4af37', fontSize: 14 }}>
            Placar:
          </strong>
          <span style={{ fontSize: 24, fontWeight: 800, color: scoreColor, lineHeight: 1 }}>
            {total > 0 ? `+${total}` : total}
          </span>
          <span style={{ fontSize: 12, color: '#a89cc8' }}>pts</span>
        </div>
      </div>

      {/* Separador vertical */}
      <div style={{ width: 1, height: 24, background: 'rgba(168, 156, 200, 0.25)' }} aria-hidden="true" />

      {/* 📝 Quizzes: N */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <BookOpen size={16} color="#a89cc8" />
        <span style={{ fontSize: 13, color: '#c4b5fd' }}>
          Quizzes:{' '}
          <strong style={{ color: '#ffffff', fontSize: 14 }}>{quizzes}</strong>
        </span>
      </div>

      {/* Separador vertical */}
      <div style={{ width: 1, height: 24, background: 'rgba(168, 156, 200, 0.25)' }} aria-hidden="true" />

      {/* ✅ Acertos: A | ❌ Erros: E */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#4ade80' }}>
          <CheckCircle2 size={15} color="#22c55e" />
          <span>
            Acertos: <strong style={{ color: '#ffffff' }}>{correct}</strong>
          </span>
        </div>
        <span style={{ color: 'rgba(168, 156, 200, 0.4)' }}>|</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#f87171' }}>
          <XCircle size={15} color="#ef4444" />
          <span>
            Erros: <strong style={{ color: '#ffffff' }}>{wrong}</strong>
          </span>
        </div>
      </div>

      {/* Melhor Sequência (opcional, quando > 0) */}
      {best > 0 && (
        <>
          <div style={{ width: 1, height: 24, background: 'rgba(168, 156, 200, 0.25)' }} aria-hidden="true" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#a89cc8' }}>
            <Target size={14} color="#a89cc8" />
            <span>melhor rodada:</span>
            <strong style={{ color: '#e8e0d0' }}>{best}/3</strong>
          </div>
        </>
      )}

      {/* Título do Livro */}
      {bookTitle && (
        <>
          <div style={{ width: 1, height: 24, background: 'rgba(168, 156, 200, 0.25)' }} aria-hidden="true" />
          <small
            style={{
              color: '#a89cc8',
              fontSize: 12,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 240,
            }}
            title={bookTitle}
          >
            📖 {bookTitle}
          </small>
        </>
      )}
    </div>
  )
}