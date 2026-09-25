import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { GraduationCap, CheckCircle2, XCircle, AlertCircle, Award, BookOpen, Clock, FileCheck, Printer } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { getFormativeGrade } from '../lib/academic'
import { AcademicReportPrintModal } from './AcademicReportPrintModal'

export interface Question {
  id: number
  question: string
  options: string[]
  correctIndex: number
  explanation: string
}

interface Props {
  isOpen: boolean
  onClose: () => void
  ebookId: string
  ebookTitle: string
  userId?: string
  tenantId: string
  chapterTitle?: string
  pageStart?: number
  pageEnd?: number
  pageRange?: string
  tenantName?: string
  studentName?: string
  studentIdentifier?: string
}

function resolveStudent(
  authUser: any,
  fallbackUserId?: string,
  overrideName?: string,
  overrideId?: string
) {
  if (authUser?.id) {
    const name =
      (overrideName && overrideName !== 'Leitor Demo' && !overrideName.startsWith('Convidado'))
        ? overrideName
        : authUser.user_metadata?.full_name || authUser.user_metadata?.name || authUser.email?.split('@')[0] || 'Estudante'
    return {
      userId: authUser.id,
      studentIdentifier: overrideId || authUser.email || authUser.id,
      studentName: name,
      isGuest: false,
    }
  }

  // Se veio identificação formal via props
  let sName = (overrideName || '').trim()
  let sId = (overrideId || '').trim()

  // Se não veio por prop, verifica localStorage filtrando nomes genéricos
  if (typeof window !== 'undefined') {
    if (!sName || sName === 'Leitor Demo' || sName.startsWith('Convidado')) {
      const stored = (localStorage.getItem('leitor-ia:student-name') || '').trim()
      if (stored && stored !== 'Leitor Demo' && !stored.startsWith('Convidado')) {
        sName = stored
      }
    }
    if (!sId) {
      sId = (localStorage.getItem('leitor-ia:student-id') || '').trim()
    }
  }

  // Se fallbackUserId é UUID válido (caso autenticado sem session pronta)
  if (fallbackUserId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fallbackUserId)) {
    return {
      userId: fallbackUserId,
      studentIdentifier: sId || fallbackUserId,
      studentName: (sName && sName !== 'Leitor Demo') ? sName : 'Estudante',
      isGuest: false,
    }
  }

  if (!sName || sName === 'Leitor Demo' || sName.startsWith('Convidado')) {
    sName = 'Estudante em Avaliação'
  }
  if (!sId) {
    sId = `MAT-${Date.now().toString(36).toUpperCase()}`
  }

  return {
    userId: null,
    studentIdentifier: sId,
    studentName: sName,
    isGuest: true,
  }
}

export function AcademicAssessmentModal({
  isOpen,
  onClose,
  ebookId,
  ebookTitle,
  userId,
  tenantId,
  chapterTitle,
  pageStart,
  pageEnd,
  pageRange,
  tenantName,
  studentName,
  studentIdentifier,
}: Props) {
  const [loading, setLoading] = useState(true)
  const [assessment, setAssessment] = useState<any | null>(null)
  const [submission, setSubmission] = useState<any | null>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [selectedAnswers, setSelectedAnswers] = useState<Record<number, number>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [printModalOpen, setPrintModalOpen] = useState(false)

  const finalPageRange =
    pageRange ||
    (pageStart && pageEnd ? `Páginas ${pageStart} a ${pageEnd}` : (chapterTitle?.trim() || 'Páginas 1 a 10'))
  const activeChapter = finalPageRange

  useEffect(() => {
    if (!isOpen || !ebookId || !tenantId) return
    loadAssessmentAndSubmission()
  }, [isOpen, ebookId, tenantId, userId, finalPageRange])

  const loadAssessmentAndSubmission = async () => {
    setLoading(true)
    setError(null)
    try {
      const safeEbookId = String(ebookId).trim()

      // 1. Buscar avaliação oficial para o livro + intervalo no tenant
      let { data: assess, error: assessErr } = await supabase
        .from('academic_assessments')
        .select('*')
        .eq('ebook_id', safeEbookId)
        .eq('tenant_id', tenantId)
        .eq('page_range', finalPageRange)
        .maybeSingle()

      if (!assess) {
        // Fallback para chapter_title se criado anteriormente com esse nome
        const { data: legacyAssess } = await supabase
          .from('academic_assessments')
          .select('*')
          .eq('ebook_id', safeEbookId)
          .eq('tenant_id', tenantId)
          .eq('chapter_title', finalPageRange)
          .maybeSingle()
        if (legacyAssess) {
          assess = legacyAssess
        }
      }

      if (!assess) {
        // Se ainda não existir para este intervalo, solicita geração inteligente com extração do PDF
        try {
          const apiRes = await fetch('/academic/generate-assessment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              book_slug: safeEbookId,
              ebook_id: safeEbookId,
              ebook_title: ebookTitle,
              page_start: pageStart || 1,
              page_end: pageEnd || pageStart || 1,
              page_range: finalPageRange,
              tenant_id: tenantId,
            }),
          })
          if (apiRes.ok) {
            const apiJson = await apiRes.json()
            if (apiJson?.assessment) {
              assess = apiJson.assessment
            }
          }
        } catch (apiErr) {
          console.warn('[AcademicAssessmentModal] Geração IA via API falhou, usando fallback estruturado:', apiErr)
        }

        // Fallback local caso a API não retorne
        if (!assess) {
          const defaultQuestions: Question[] = [
            {
              id: 1,
              question: `Qual é o tema central e a proposta de conhecimento desenvolvida em "${activeChapter}" da obra "${ebookTitle}"?`,
              options: [
                'Desenvolvimento de competências teóricas e práticas aplicadas ao contexto deste capítulo',
                'Apenas relatos biográficos sem aplicação técnica ou conceitual',
                'Crítica isolada sem propostas de metodologia ou aprendizado',
                'Entretenimento sem relação com fundamentação ou estudo',
              ],
              correctIndex: 0,
              explanation: `O ${activeChapter} fundamenta conceitos essenciais e desenvolve a compreensão aplicada do leitor.`,
            },
            {
              id: 2,
              question: `Segundo as premissas desenvolvidas pelo autor em "${activeChapter}", qual fator é determinante para o domínio dos conteúdos?`,
              options: [
                'Leitura passiva e memorização rasa de termos',
                'Estudo reflexivo, aplicação contínua e compreensão dos princípios fundamentais',
                'Adoção de métodos aleatórios sem base teórica',
                'Desconsideração dos dados históricos e do contexto prático',
              ],
              correctIndex: 1,
              explanation: 'O método enfatiza a disciplina reflexiva aliada à prática continuada.',
            },
            {
              id: 3,
              question: `Ao longo de "${activeChapter}", como são estruturados os argumentos principais para validação do raciocínio?`,
              options: [
                'Com base em evidências, análise crítica e articulação conceitual consistente',
                'Através de suposições não comprovadas',
                'Exclusivamente por opiniões subjetivas de terceiros',
                'Sem uma ordem lógica de exposição dos tópicos',
              ],
              correctIndex: 0,
              explanation: 'A solidez da obra reside na coerência argumentativa e nas evidências mobilizadas.',
            },
            {
              id: 4,
              question: `De que maneira a assimilação destes princípios impacta o desenvolvimento do estudante em "${activeChapter}"?`,
              options: [
                'Potencializa a capacidade de tomada de decisão, análise crítica e resolução de problemas',
                'Não gera impacto perceptível nas competências do aluno',
                'Limita a criatividade a fórmulas rígidas e obsoletas',
                'Incentiva o abandono de técnicas complementares de pesquisa',
              ],
              correctIndex: 0,
              explanation: 'O estudo estruturado amplia a visão técnica e estratégica na prática profissional.',
            },
            {
              id: 5,
              question: `Qual síntese melhor expressa a conclusão e as lições fundamentais consolidadas em "${activeChapter}"?`,
              options: [
                'A excelência é alcançada pela união entre fundamentação sólida, consistência e discernimento',
                'Não há diretrizes finais ou ensinamentos aproveitáveis',
                'O conhecimento adquirido deve ser guardado sem aplicação social ou técnica',
                'Os conceitos apresentados aplicam-se apenas a cenários teóricos ideais',
              ],
              correctIndex: 0,
              explanation: 'A síntese final orienta a aplicação ética e sustentável do aprendizado.',
            },
          ]

          const { data: created } = await supabase
            .from('academic_assessments')
            .insert({
              ebook_id: safeEbookId,
              tenant_id: tenantId,
              title: `Avaliação Oficial: ${activeChapter}`,
              chapter_title: activeChapter,
              page_range: pageRange || null,
              questions: defaultQuestions,
            })
            .select()
            .maybeSingle()

          assess = created || {
            id: `assess-${Date.now()}`,
            questions: defaultQuestions,
            chapter_title: activeChapter,
          }
        }
      }

      setAssessment(assess)
      const qList: Question[] = assess?.questions || []
      setQuestions(qList)

      // 2. Verificar se o estudante já possui submissão para este caderno oficial
      const { data: { session } } = await supabase.auth.getSession()
      const student = resolveStudent(session?.user, userId, studentName, studentIdentifier)

      if (assess?.id && !assess.id.startsWith('assess-')) {
        let q = supabase.from('academic_submissions').select('*').eq('assessment_id', assess.id)
        if (student.userId) {
          q = q.eq('user_id', student.userId)
        } else if (student.studentIdentifier) {
          q = q.eq('student_identifier', student.studentIdentifier)
        }
        const { data: sub } = await q.maybeSingle()
        if (sub) {
          setSubmission(sub)
        }
      }
    } catch (e: any) {
      setError(e.message || 'Falha ao carregar avaliação oficial.')
    } finally {
      setLoading(false)
    }
  }

  const handleSelectOption = (questionIndex: number, optionIndex: number) => {
    if (submission) return // Prova já realizada não permite alteração
    setSelectedAnswers((prev) => ({
      ...prev,
      [questionIndex]: optionIndex,
    }))
  }

  const handleSubmitAssessment = async () => {
    if (questions.length === 0) return
    const answeredCount = Object.keys(selectedAnswers).length
    if (answeredCount < questions.length) {
      setError(`Você respondeu ${answeredCount} de ${questions.length} questões. Responda todas antes de entregar.`)
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      let correct = 0
      questions.forEach((q, idx) => {
        if (selectedAnswers[idx] === q.correctIndex) {
          correct += 1
        }
      })

      const total = questions.length
      const score = Number(((correct / total) * 10).toFixed(1))
      const passed = score >= 7.0

      const { data: { session } } = await supabase.auth.getSession()
      const student = resolveStudent(session?.user, userId, studentName, studentIdentifier)
      const safeEbookId = String(ebookId).trim()

      let currentAssessmentId = assessment?.id
      if (!currentAssessmentId || currentAssessmentId.startsWith('assess-')) {
        const { data: created } = await supabase
          .from('academic_assessments')
          .insert({
            ebook_id: safeEbookId,
            tenant_id: tenantId,
            title: `Avaliação Oficial: ${finalPageRange}`,
            chapter_title: finalPageRange,
            page_range: finalPageRange,
            questions: questions,
          })
          .select()
          .maybeSingle()

        if (created?.id) {
          currentAssessmentId = created.id
        }
      }

      let detectedRoomId: string | null = null
      if (typeof window !== 'undefined') {
        const hashQuery = window.location.hash.split('?')[1] || ''
        const searchParams = new URLSearchParams(hashQuery || window.location.search)
        detectedRoomId = searchParams.get('room')
      }

      const payload = {
        assessment_id: currentAssessmentId,
        user_id: student.userId,
        tenant_id: tenantId,
        ebook_id: safeEbookId,
        chapter_title: finalPageRange,
        page_range: finalPageRange,
        room_id: detectedRoomId,
        score,
        total_questions: total,
        correct_answers: correct,
        answers: selectedAnswers,
        passed,
        student_name: student.studentName,
        student_identifier: student.studentIdentifier,
      }

      const { data: savedSub, error: subErr } = await supabase
        .from('academic_submissions')
        .insert(payload)
        .select()
        .single()

      if (subErr) {
        throw new Error(subErr.message || 'Erro ao registrar submissão acadêmica.')
      }

      setError(null)
      setSubmission(savedSub || payload)
    } catch (err: any) {
      console.error('[AcademicAssessmentModal] Erro ao submeter avaliação:', err)
      setError(err?.message || 'Falha ao enviar avaliação.')
    } finally {
      setSubmitting(false)
    }
  }

  if (!isOpen) return null
  if (typeof document === 'undefined') return null

  const formativeGrade = submission ? getFormativeGrade(submission.score) : null

  return createPortal(
    <>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 999999,
          backgroundColor: 'rgba(0, 0, 0, 0.82)',
          backdropFilter: 'blur(6px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          boxSizing: 'border-box',
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && !submitting) onClose()
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 680,
            maxHeight: '92vh',
            backgroundColor: '#0f172a',
            color: '#f8fafc',
            borderRadius: 20,
            border: '1px solid #334155',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Cabeçalho */}
          <div
            style={{
              padding: '20px 24px',
              borderBottom: '1px solid #1e293b',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              backgroundColor: '#0f172a',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 12,
                  backgroundColor: 'rgba(168, 85, 247, 0.15)',
                  border: '1px solid rgba(168, 85, 247, 0.4)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#c084fc',
                }}
              >
                <GraduationCap size={22} />
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: '#ffffff' }}>
                  Avaliação Oficial de Desempenho
                </h3>
                <p style={{ margin: 0, fontSize: '0.82rem', color: '#94a3b8' }}>
                  {ebookTitle} • <strong style={{ color: '#c084fc' }}>📖 {activeChapter}</strong>
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              disabled={submitting}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#94a3b8',
                fontSize: '1.6rem',
                cursor: 'pointer',
                lineHeight: 1,
              }}
            >
              &times;
            </button>
          </div>

          {/* Corpo */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
            {loading && (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#94a3b8' }}>
                <p>Carregando caderno oficial ({activeChapter})...</p>
              </div>
            )}

            {error && (
              <div
                style={{
                  padding: '12px 16px',
                  borderRadius: 10,
                  backgroundColor: 'rgba(239, 68, 68, 0.15)',
                  border: '1px solid rgba(239, 68, 68, 0.4)',
                  color: '#fca5a5',
                  marginBottom: 20,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  fontSize: '0.88rem',
                }}
              >
                <AlertCircle size={18} />
                <span>{error}</span>
              </div>
            )}

            {/* CASO JÁ TENHA SIDO SUBMETIDA: MOSTRAR CLASSIFICAÇÃO FORMATIVA + BOTÃO DE IMPRESSÃO */}
            {!loading && submission && formativeGrade && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div
                  style={{
                    padding: 24,
                    borderRadius: 16,
                    backgroundColor: formativeGrade.bgColor,
                    border: `1px solid ${formativeGrade.borderColor}`,
                    textAlign: 'center',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
                    <Award size={48} style={{ color: formativeGrade.color }} />
                  </div>

                  {/* Badge de Conceito Formativo */}
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '5px 14px',
                      borderRadius: 999,
                      fontSize: '0.9rem',
                      fontWeight: 800,
                      backgroundColor: formativeGrade.borderColor,
                      color: '#ffffff',
                      marginBottom: 10,
                      boxShadow: `0 4px 14px ${formativeGrade.borderColor}40`,
                    }}
                  >
                    <span>{formativeGrade.icon}</span>
                    <span>{formativeGrade.label}</span>
                  </div>

                  <h2 style={{ fontSize: '2.5rem', fontWeight: 800, margin: '4px 0', color: '#ffffff' }}>
                    {Number(submission.score).toFixed(1)} <span style={{ fontSize: '1.2rem', color: '#94a3b8' }}>/ 10.0</span>
                  </h2>

                  <div style={{ marginTop: 6, fontSize: '0.92rem', color: '#e2e8f0', fontWeight: 600 }}>
                    Estudante: <span style={{ color: '#c084fc' }}>{submission.student_name}</span>
                    {submission.student_identifier && (
                      <span style={{ color: '#94a3b8', fontSize: '0.8rem', marginLeft: 8, fontFamily: 'monospace' }}>
                        ({submission.student_identifier})
                      </span>
                    )}
                  </div>

                  <div style={{ marginTop: 4, fontSize: '0.84rem', color: '#7c3aed', fontWeight: 700 }}>
                    📖 {submission.chapter_title || activeChapter}
                  </div>

                  <p style={{ margin: '8px 0 0', color: '#cbd5e1', fontSize: '0.92rem' }}>
                    Acertos: <strong>{submission.correct_answers}</strong> de <strong>{submission.total_questions || 5}</strong> questões
                  </p>

                  <p style={{ margin: '6px 0 0', color: '#94a3b8', fontSize: '0.8rem', maxWidth: 480, marginInline: 'auto' }}>
                    {formativeGrade.description}
                  </p>

                  {/* Botão de Impressão do Boletim Oficial */}
                  <div style={{ marginTop: 18 }}>
                    <button
                      type="button"
                      onClick={() => setPrintModalOpen(true)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '10px 20px',
                        borderRadius: 10,
                        backgroundColor: '#7c3aed',
                        color: '#ffffff',
                        fontWeight: 700,
                        fontSize: '0.88rem',
                        border: 'none',
                        cursor: 'pointer',
                        boxShadow: '0 4px 14px rgba(124, 58, 237, 0.4)',
                        transition: 'transform 0.15s ease',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.transform = 'translateY(-1px) scale(1.02)')}
                      onMouseLeave={(e) => (e.currentTarget.style.transform = 'translateY(0) scale(1)')}
                    >
                      <Printer size={16} />
                      <span>Imprimir Comprovante / Boletim</span>
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    padding: 14,
                    borderRadius: 12,
                    backgroundColor: 'rgba(2, 6, 23, 0.6)',
                    border: '1px solid #1e293b',
                    fontSize: '0.82rem',
                    color: '#94a3b8',
                    lineHeight: 1.5,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <FileCheck size={20} style={{ color: '#38bdf8', flexShrink: 0 }} />
                  <span>
                    <strong>Tentativa Única Registrada:</strong> Sua avaliação para o <em>{submission.chapter_title || activeChapter}</em> foi protocolada no Painel do Gestor desta instituição.
                  </span>
                </div>

                {/* Revisão das Questões */}
                <h4 style={{ margin: '16px 0 8px', fontSize: '1rem', color: '#f8fafc', fontWeight: 600 }}>
                  Gabarito e Justificativas Pedagógicas:
                </h4>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {questions.map((q, qIndex) => {
                    const userAns = submission.answers?.[qIndex] ?? submission.answers?.[String(qIndex)]
                    const isCorrect = userAns === q.correctIndex

                    return (
                      <div
                        key={q.id || qIndex}
                        style={{
                          padding: 16,
                          borderRadius: 12,
                          backgroundColor: '#1e293b',
                          border: isCorrect ? '1px solid #22c55e' : '1px solid #ef4444',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
                          <span style={{ fontSize: '0.92rem', fontWeight: 600, color: '#ffffff' }}>
                            {qIndex + 1}. {q.question}
                          </span>
                          {isCorrect ? (
                            <span style={{ color: '#22c55e', fontSize: '0.78rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
                              <CheckCircle2 size={14} /> +2.0
                            </span>
                          ) : (
                            <span style={{ color: '#ef4444', fontSize: '0.78rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
                              <XCircle size={14} /> 0.0
                            </span>
                          )}
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {q.options.map((opt, optIndex) => {
                            const isChosen = userAns === optIndex
                            const isRight = q.correctIndex === optIndex

                            let bg = '#0f172a'
                            let border = '#334155'
                            if (isRight) {
                              bg = 'rgba(34, 197, 94, 0.15)'
                              border = '#22c55e'
                            } else if (isChosen && !isRight) {
                              bg = 'rgba(239, 68, 68, 0.15)'
                              border = '#ef4444'
                            }

                            return (
                              <div
                                key={optIndex}
                                style={{
                                  padding: '8px 12px',
                                  borderRadius: 8,
                                  border: `1px solid ${border}`,
                                  backgroundColor: bg,
                                  fontSize: '0.84rem',
                                  color: isRight ? '#86efac' : isChosen ? '#fca5a5' : '#cbd5e1',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                }}
                              >
                                <span>{opt}</span>
                                {isRight && <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#22c55e' }}>Gabarito Oficial</span>}
                                {isChosen && !isRight && <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#ef4444' }}>Sua Escolha</span>}
                              </div>
                            )
                          })}
                        </div>

                        {q.explanation && (
                          <div
                            style={{
                              marginTop: 10,
                              padding: '8px 12px',
                              borderRadius: 8,
                              backgroundColor: 'rgba(15, 23, 42, 0.6)',
                              fontSize: '0.8rem',
                              color: '#94a3b8',
                              borderLeft: '3px solid #7c3aed',
                            }}
                          >
                            <strong>Justificativa da IA:</strong> {q.explanation}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* CASO NÃO TENHA SIDO SUBMETIDA: MOSTRAR CADERNO DE PROVA */}
            {!loading && !submission && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div
                  style={{
                    padding: 14,
                    borderRadius: 12,
                    backgroundColor: 'rgba(168, 85, 247, 0.1)',
                    border: '1px solid rgba(168, 85, 247, 0.3)',
                    fontSize: '0.84rem',
                    color: '#e9d5ff',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <BookOpen size={20} style={{ color: '#c084fc', flexShrink: 0 }} />
                  <span>
                    Caderno com 5 questões formativas sobre o <strong>{activeChapter}</strong>. Leia atentamente e selecione a alternativa correta.
                  </span>
                </div>

                {questions.map((q, qIndex) => {
                  const currentSelected = selectedAnswers[qIndex]

                  return (
                    <div
                      key={q.id || qIndex}
                      style={{
                        padding: 18,
                        borderRadius: 14,
                        backgroundColor: '#1e293b',
                        border: '1px solid #334155',
                      }}
                    >
                      <h4 style={{ margin: '0 0 12px', fontSize: '0.95rem', fontWeight: 600, color: '#ffffff', lineHeight: 1.4 }}>
                        {qIndex + 1}. {q.question}
                      </h4>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {q.options.map((opt, optIndex) => {
                          const isSelected = currentSelected === optIndex

                          return (
                            <button
                              key={optIndex}
                              type="button"
                              onClick={() => handleSelectOption(qIndex, optIndex)}
                              style={{
                                padding: '10px 14px',
                                borderRadius: 10,
                                border: `1px solid ${isSelected ? '#c084fc' : '#334155'}`,
                                backgroundColor: isSelected ? 'rgba(168, 85, 247, 0.15)' : '#0f172a',
                                color: isSelected ? '#f5d0fe' : '#cbd5e1',
                                textAlign: 'left',
                                fontSize: '0.88rem',
                                cursor: 'pointer',
                                transition: 'all 0.15s ease',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 10,
                              }}
                            >
                              <div
                                style={{
                                  width: 18,
                                  height: 18,
                                  borderRadius: '50%',
                                  border: `2px solid ${isSelected ? '#c084fc' : '#64748b'}`,
                                  backgroundColor: isSelected ? '#c084fc' : 'transparent',
                                  flexShrink: 0,
                                }}
                              />
                              <span>{opt}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Rodapé / Botão de Ação */}
          <div
            style={{
              padding: '16px 24px',
              borderTop: '1px solid #1e293b',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              backgroundColor: '#0f172a',
            }}
          >
            <button
              onClick={onClose}
              disabled={submitting}
              className="btn btn-ghost"
              style={{ padding: '8px 16px' }}
            >
              Fechar
            </button>

            {!submission && !loading && (
              <button
                onClick={handleSubmitAssessment}
                disabled={submitting || Object.keys(selectedAnswers).length < questions.length}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 24px',
                  borderRadius: 10,
                  background: 'linear-gradient(135deg, #7c3aed 0%, #2563eb 100%)',
                  color: '#ffffff',
                  fontWeight: 700,
                  fontSize: '0.92rem',
                  border: 'none',
                  cursor: submitting || Object.keys(selectedAnswers).length < questions.length ? 'not-allowed' : 'pointer',
                  opacity: submitting || Object.keys(selectedAnswers).length < questions.length ? 0.6 : 1,
                  boxShadow: '0 4px 14px rgba(37, 99, 235, 0.4)',
                }}
              >
                <GraduationCap size={18} />
                <span>{submitting ? 'Gravando Submissão...' : 'Entregar Avaliação Oficial'}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Modal de Impressão Oficial do Boletim */}
      <AcademicReportPrintModal
        isOpen={printModalOpen}
        onClose={() => setPrintModalOpen(false)}
        submission={{
          ...submission,
          ebook_title: ebookTitle,
          chapter_title: submission?.chapter_title || activeChapter,
          page_range: submission?.page_range || pageRange,
        }}
        questions={questions}
        tenantName={tenantName}
      />
    </>,
    document.body
  )
}
