import { useEffect, useMemo, useState, useCallback } from 'react'
import { CheckCircle2, ChevronRight, Sparkles, Target, X, XCircle, RefreshCw } from 'lucide-react'
import { supabase } from '../lib/supabase'

export type QuizQuestion = {
  id: number
  type: 'multiple_choice' | 'true_false' | 'out_of_scope'
  question: string
  options: string[]
  correct_index: number
  explanation: string
}

interface Props {
  open: boolean
  onClose: () => void
  bookId: string
  bookTitle: string
  pageNumber: number
  pageText: string
}

type Phase = 'loading' | 'answering' | 'feedback' | 'result' | 'out_of_scope'

// Constantes espelhando o backend
const SCORE_CORRECT = 10
const SCORE_WRONG = -5
const QUESTIONS_PER_QUIZ = 3

async function fetchQuestions(bookId: string, pageNumber: number, pageText: string): Promise<QuizQuestion[]> {
  const r = await fetch('/leitor-inteligente/api/quiz/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ book_id: bookId, page_number: pageNumber, page_text: pageText }),
  })
  const data = await r.json()
  if (!r.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${r.status}`)
  }
  return data.questions as QuizQuestion[]
}

async function saveScore(bookId: string, pageNumber: number, correct: number, wrong: number): Promise<void> {
  // Pega o token atual do Supabase (sem isso o backend devolve 401)
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData.session?.access_token
  if (!token) {
    console.warn('[quiz] sem token, score não persistido')
    return
  }
  try {
    await fetch('/leitor-inteligente/api/quiz/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ book_id: bookId, page_number: pageNumber, correct, wrong }),
    })
  } catch (e) {
    console.warn('[quiz] save falhou (não-bloqueante):', e)
  }
}

export function QuizModal({ open, onClose, bookId, bookTitle, pageNumber, pageText }: Props) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string | null>(null)
  const [questions, setQuestions] = useState<QuizQuestion[]>([])
  const [currentIdx, setCurrentIdx] = useState(0)
  const [answers, setAnswers] = useState<number[]>([])     // índice da opção clicada por pergunta
  const [revealed, setRevealed] = useState<boolean[]>([])  // já mostrou feedback desta pergunta?
  const [savingScore, setSavingScore] = useState(false)

  const current = questions[currentIdx]
  const correctCount = useMemo(
    () => questions.reduce((acc, q, i) => acc + (answers[i] === q.correct_index ? 1 : 0), 0),
    [questions, answers],
  )
  const wrongCount = QUESTIONS_PER_QUIZ - correctCount
  const totalScore = correctCount * SCORE_CORRECT + wrongCount * SCORE_WRONG

  // Reset ao abrir e dispara fetch
  useEffect(() => {
    if (!open) return
    setPhase('loading')
    setError(null)
    setQuestions([])
    setCurrentIdx(0)
    setAnswers([])
    setRevealed([])
    setSavingScore(false)

    fetchQuestions(bookId, pageNumber, pageText)
      .then((qs) => {
        setQuestions(qs)
        if (qs.length === 1 && qs[0].type === 'out_of_scope') {
          setPhase('out_of_scope')
        } else {
          setPhase('answering')
          setRevealed(qs.map(() => false))
          setAnswers(qs.map(() => -1))
        }
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Erro desconhecido')
        setPhase('result') // mostra erro na tela de resultado
      })
  }, [open, bookId, pageNumber, pageText])

  const pickOption = (optIdx: number) => {
    if (!current || revealed[currentIdx]) return
    const next = [...answers]
    next[currentIdx] = optIdx
    setAnswers(next)
    const nextR = [...revealed]
    nextR[currentIdx] = true
    setRevealed(nextR)
    setPhase('feedback')
  }

  const goNext = () => {
    if (currentIdx + 1 >= questions.length) {
      // última pergunta → calcular score e salvar
      setSavingScore(true)
      saveScore(bookId, pageNumber, correctCount, wrongCount).finally(() => {
        setSavingScore(false)
        setPhase('result')
      })
    } else {
      setCurrentIdx(currentIdx + 1)
      setPhase('answering')
    }
  }

  const handleClose = useCallback(() => {
    onClose()
  }, [onClose])

  // ESC fecha o modal
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, handleClose])

  if (!open) return null

  // ---- RENDER ----
  const isCorrect = current && answers[currentIdx] === current.correct_index
  const hasAnswered = current && answers[currentIdx] !== -1

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Quiz da página"
      onClick={handleClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.75)',
        backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'linear-gradient(160deg, #1f1c2e, #2a2540)',
          border: '1px solid #d4af37',
          borderRadius: 16,
          maxWidth: 560, width: '100%',
          maxHeight: '92vh', overflowY: 'auto',
          padding: '20px 22px',
          color: '#e8e0d0',
          fontFamily: 'inherit',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Target size={20} color="#d4af37" />
          <strong style={{ fontFamily: 'Georgia, serif', color: '#d4af37', fontSize: 18 }}>
            Quiz da Página {pageNumber}
          </strong>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Fechar quiz"
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: '1px solid #6b6280',
              color: '#e8e0d0',
              borderRadius: 8,
              padding: 4,
              cursor: 'pointer',
              display: 'flex',
            }}
          >
            <X size={18} />
          </button>
        </div>
        <small style={{ color: '#a89cc8', display: 'block', marginBottom: 14 }}>
          {bookTitle} · +{SCORE_CORRECT} por acerto · {SCORE_WRONG} por erro
        </small>

        {/* LOADING */}
        {phase === 'loading' && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <div className="spinner" style={{ margin: '0 auto 14px' }} />
            <p style={{ color: '#d4af37' }}>Gerando perguntas com o Professor IA…</p>
          </div>
        )}

        {/* OUT OF SCOPE — página vazia/sem conteúdo */}
        {phase === 'out_of_scope' && current && (
          <div style={{ textAlign: 'center', padding: '24px 12px' }}>
            <Sparkles size={36} color="#6b6280" style={{ margin: '0 auto 12px' }} />
            <h3 style={{ color: '#e8e0d0', fontFamily: 'Georgia, serif', marginBottom: 10 }}>
              Esta página não tem conteúdo suficiente
            </h3>
            <p style={{ color: '#a89cc8', marginBottom: 18 }}>{current.explanation}</p>
            <button
              type="button"
              onClick={handleClose}
              style={{
                background: 'linear-gradient(135deg, #d4af37, #b8962e)',
                color: '#1f1c2e',
                border: 'none',
                padding: '10px 24px',
                borderRadius: 999,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Entendi
            </button>
          </div>
        )}

        {/* ANSWERING / FEEDBACK — uma pergunta por vez */}
        {(phase === 'answering' || phase === 'feedback') && current && (
          <>
            {/* progresso */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
              {questions.map((_, i) => (
                <div
                  key={i}
                  style={{
                    flex: 1, height: 4, borderRadius: 2,
                    background: i < currentIdx
                      ? '#d4af37'
                      : i === currentIdx
                        ? (phase === 'feedback' ? (isCorrect ? '#22c55e' : '#ef4444') : '#d4af37')
                        : '#3a3150',
                  }}
                />
              ))}
            </div>
            <p style={{ color: '#a89cc8', fontSize: 13, marginBottom: 6 }}>
              Pergunta {currentIdx + 1} de {questions.length}
            </p>
            <h3 style={{
              fontFamily: 'Georgia, serif',
              fontSize: 19,
              lineHeight: 1.4,
              color: '#fff',
              marginBottom: 18,
            }}>
              {current.question}
            </h3>

            {/* opções */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {current.options.map((opt, i) => {
                const isPicked = answers[currentIdx] === i
                const isCorrectOpt = i === current.correct_index
                const showFeedback = phase === 'feedback'
                let bg = '#2a2540'
                let border = '1px solid #3a3150'
                let icon: React.ReactNode = null
                if (showFeedback) {
                  if (isCorrectOpt) {
                    bg = 'rgba(34, 197, 94, 0.15)'
                    border = '1px solid #22c55e'
                    icon = <CheckCircle2 size={18} color="#22c55e" />
                  } else if (isPicked && !isCorrectOpt) {
                    bg = 'rgba(239, 68, 68, 0.15)'
                    border = '1px solid #ef4444'
                    icon = <XCircle size={18} color="#ef4444" />
                  }
                } else if (isPicked) {
                  border = '1px solid #d4af37'
                }

                return (
                  <button
                    key={i}
                    type="button"
                    disabled={phase === 'feedback'}
                    onClick={() => pickOption(i)}
                    style={{
                      background: bg,
                      border,
                      color: '#e8e0d0',
                      padding: '12px 14px',
                      borderRadius: 10,
                      textAlign: 'left',
                      cursor: phase === 'feedback' ? 'default' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      fontSize: 15,
                      transition: 'background 0.2s, border 0.2s',
                    }}
                  >
                    <span style={{ flex: 1 }}>{opt}</span>
                    {icon}
                  </button>
                )
              })}
            </div>

            {/* explicação após responder */}
            {phase === 'feedback' && current.explanation && (
              <div style={{
                marginTop: 16,
                padding: '12px 14px',
                background: isCorrect ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                border: `1px solid ${isCorrect ? '#22c55e' : '#ef4444'}`,
                borderRadius: 10,
              }}>
                <strong style={{ color: isCorrect ? '#22c55e' : '#ef4444', display: 'block', marginBottom: 6 }}>
                  {isCorrect ? '🎉 Correto!' : '❌ Errou'}
                </strong>
                <p style={{ margin: 0, color: '#e8e0d0', fontSize: 14, lineHeight: 1.5 }}>
                  {current.explanation}
                </p>
              </div>
            )}

            {/* botão próxima */}
            {phase === 'feedback' && (
              <button
                type="button"
                onClick={goNext}
                disabled={savingScore}
                style={{
                  marginTop: 18,
                  width: '100%',
                  background: 'linear-gradient(135deg, #d4af37, #b8962e)',
                  color: '#1f1c2e',
                  border: 'none',
                  padding: '12px 20px',
                  borderRadius: 10,
                  fontWeight: 700,
                  fontSize: 15,
                  cursor: savingScore ? 'wait' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}
              >
                {savingScore ? 'Salvando…' : currentIdx + 1 >= questions.length ? 'Ver resultado' : 'Próxima pergunta'}
                {!savingScore && <ChevronRight size={18} />}
              </button>
            )}
          </>
        )}

        {/* RESULT — tela final */}
        {phase === 'result' && !error && (
          <div style={{ textAlign: 'center', padding: '12px 4px' }}>
            <h3 style={{ fontFamily: 'Georgia, serif', color: '#d4af37', fontSize: 22, marginBottom: 6 }}>
              Quiz finalizado!
            </h3>
            <p style={{ color: '#a89cc8', marginBottom: 18 }}>
              {bookTitle} · página {pageNumber}
            </p>
            <div style={{
              fontSize: 48,
              fontWeight: 800,
              color: totalScore > 0 ? '#22c55e' : totalScore === 0 ? '#d4af37' : '#ef4444',
              marginBottom: 4,
            }}>
              {totalScore > 0 ? '+' : ''}{totalScore}
            </div>
            <small style={{ color: '#a89cc8', display: 'block', marginBottom: 18 }}>
              {correctCount} acerto{correctCount !== 1 ? 's' : ''} · {wrongCount} erro{wrongCount !== 1 ? 's' : ''} · salvo na sua conta
            </small>

            {/* resumo das respostas */}
            <div style={{ textAlign: 'left', marginBottom: 18 }}>
              {questions.map((q, i) => {
                const userAns = answers[i]
                const ok = userAns === q.correct_index
                return (
                  <div key={i} style={{
                    padding: '10px 12px',
                    marginBottom: 8,
                    background: ok ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                    border: `1px solid ${ok ? '#22c55e' : '#ef4444'}`,
                    borderRadius: 8,
                  }}>
                    <small style={{ color: ok ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
                      {ok ? `+${SCORE_CORRECT}` : SCORE_WRONG} · {ok ? 'Acertou' : 'Errou'}
                    </small>
                    <p style={{ margin: '4px 0 0', fontSize: 13, color: '#e8e0d0' }}>
                      <strong>P{currentIdx + 1}</strong> {q.question}
                    </p>
                  </div>
                )
              })}
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                onClick={handleClose}
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: '1px solid #d4af37',
                  color: '#d4af37',
                  padding: '12px 16px',
                  borderRadius: 10,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Fechar
              </button>
              <button
                type="button"
                onClick={() => {
                  // refazer: força novo fetch via toggle
                  setPhase('loading')
                  setQuestions([])
                  setCurrentIdx(0)
                  setAnswers([])
                  setRevealed([])
                  fetchQuestions(bookId, pageNumber, pageText)
                    .then((qs) => {
                      setQuestions(qs)
                      if (qs.length === 1 && qs[0].type === 'out_of_scope') {
                        setPhase('out_of_scope')
                      } else {
                        setPhase('answering')
                        setRevealed(qs.map(() => false))
                        setAnswers(qs.map(() => -1))
                      }
                    })
                    .catch((e) => {
                      setError(e instanceof Error ? e.message : 'Erro')
                      setPhase('result')
                    })
                }}
                style={{
                  flex: 1,
                  background: 'linear-gradient(135deg, #d4af37, #b8962e)',
                  color: '#1f1c2e',
                  border: 'none',
                  padding: '12px 16px',
                  borderRadius: 10,
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}
              >
                <RefreshCw size={16} /> Refazer
              </button>
            </div>
          </div>
        )}

        {/* RESULT — erro técnico */}
        {phase === 'result' && error && (
          <div style={{ textAlign: 'center', padding: '24px 12px' }}>
            <XCircle size={36} color="#ef4444" style={{ margin: '0 auto 12px' }} />
            <h3 style={{ color: '#ef4444', marginBottom: 8 }}>Não consegui gerar o quiz</h3>
            <p style={{ color: '#a89cc8', marginBottom: 18 }}>{error}</p>
            <button
              type="button"
              onClick={handleClose}
              style={{
                background: 'transparent',
                border: '1px solid #d4af37',
                color: '#d4af37',
                padding: '10px 24px',
                borderRadius: 999,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Fechar
            </button>
          </div>
        )}
      </div>
    </div>
  )
}