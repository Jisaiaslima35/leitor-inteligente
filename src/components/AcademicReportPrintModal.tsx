import React from 'react'
import { Printer, X, GraduationCap, CheckCircle2, XCircle, Award } from 'lucide-react'
import { getFormativeGrade } from '../lib/academic'

interface Question {
  id: number
  question: string
  options: string[]
  correctIndex: number
  explanation: string
}

interface Props {
  isOpen: boolean
  onClose: () => void
  submission: {
    id?: string
    student_name?: string
    student_identifier?: string
    score: number
    total_questions?: number
    correct_answers?: number
    passed?: boolean
    completed_at: string
    ebook_title?: string
    chapter_title?: string
    page_range?: string
    room_id?: string
    answers?: Record<string | number, number>
  } | null
  questions?: Question[]
  tenantName?: string
}

export function AcademicReportPrintModal({
  isOpen,
  onClose,
  submission,
  questions = [],
  tenantName,
}: Props) {
  if (!isOpen || !submission) return null

  const grade = getFormativeGrade(submission.score)
  const answers = submission.answers || {}

  const handlePrint = () => {
    window.print()
  }

  const formattedDate = new Date(submission.completed_at).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <div
      className="academic-print-modal-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999999,
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <style>{`
        @media screen {
          .academic-print-container {
            max-height: 90vh;
            overflow-y: auto;
            max-width: 820px;
            width: 100%;
            background: #ffffff;
            color: #0f172a;
            border-radius: 16px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
          }
        }

        @media print {
          body * {
            visibility: hidden !important;
          }
          .academic-print-sheet, .academic-print-sheet * {
            visibility: visible !important;
          }
          .academic-print-sheet {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            margin: 0 !important;
            padding: 20mm !important;
            background: #ffffff !important;
            color: #000000 !important;
            font-size: 11pt !important;
          }
          .no-print {
            display: none !important;
          }
          @page {
            size: A4 portrait;
            margin: 10mm;
          }
        }
      `}</style>

      <div className="academic-print-container">
        {/* Barra de Ações Superior (Apenas Tela) */}
        <div
          className="no-print"
          style={{
            padding: '16px 24px',
            backgroundColor: '#0f172a',
            color: '#ffffff',
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <GraduationCap style={{ color: '#c084fc' }} size={22} />
            <span style={{ fontWeight: 700, fontSize: '1rem' }}>
              Boletim e Comprovante de Avaliação Oficial
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              onClick={handlePrint}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 18px',
                borderRadius: 8,
                backgroundColor: '#7c3aed',
                color: '#ffffff',
                fontWeight: 700,
                fontSize: '0.88rem',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              <Printer size={16} />
              Imprimir / Salvar PDF
            </button>

            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: '#94a3b8',
                cursor: 'pointer',
                padding: 4,
                display: 'flex',
              }}
              title="Fechar"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Folha Oficial Impressa / Pré-visualização */}
        <div className="academic-print-sheet" style={{ padding: '36px 40px' }}>
          {/* Cabeçalho Institucional */}
          <div
            style={{
              borderBottom: '2px solid #0f172a',
              paddingBottom: 16,
              marginBottom: 20,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div style={{ fontSize: '0.85rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 1, color: '#64748b' }}>
                {tenantName || 'Instituição de Ensino'} • Coordenação Pedagógica
              </div>
              <h1 style={{ margin: '4px 0 0', fontSize: '1.45rem', fontWeight: 900, color: '#0f172a' }}>
                COMPROVANTE OFICIAL DE AVALIAÇÃO ACADÊMICA
              </h1>
              <div style={{ fontSize: '0.82rem', color: '#475569', marginTop: 4 }}>
                Leitor Inteligente • Plataforma de Aprendizagem Interativa e Gamificada
              </div>
            </div>

            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '0.78rem', color: '#64748b', fontWeight: 600 }}>CÓDIGO DE REGISTRO</div>
              <div style={{ fontFamily: 'monospace', fontSize: '0.85rem', fontWeight: 700, color: '#0f172a' }}>
                #{submission.id ? submission.id.slice(0, 13).toUpperCase() : 'OFICIAL-REG'}
              </div>
            </div>
          </div>

          {/* Quadro de Dados do Estudante e da Aplicação */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 14,
              padding: '16px 20px',
              backgroundColor: '#f8fafc',
              border: '1px solid #cbd5e1',
              borderRadius: 10,
              marginBottom: 24,
            }}
          >
            <div>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>
                Estudante / Aluno:
              </span>
              <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#0f172a', marginTop: 2 }}>
                {submission.student_name || 'Estudante'}
              </div>
              <div style={{ fontSize: '0.82rem', color: '#475569', marginTop: 2, fontFamily: 'monospace' }}>
                Matrícula/CPF: {submission.student_identifier || 'Identificação Regular'}
              </div>
            </div>

            <div>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>
                Material Didático:
              </span>
              <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#0f172a', marginTop: 2 }}>
                {submission.ebook_title || 'Livro de Estudo'}
              </div>
              <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#7c3aed', marginTop: 3 }}>
                📖 Intervalo Avaliado: {submission.page_range || (submission.chapter_title?.startsWith('Página') ? submission.chapter_title : `Páginas ${submission.chapter_title || 'Geral'}`)}
              </div>
            </div>

            <div>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>
                Data e Horário da Conclusão:
              </span>
              <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#0f172a', marginTop: 2 }}>
                {formattedDate}
              </div>
            </div>

            <div>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>
                Ambiente / Sala de Estudo:
              </span>
              <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#0f172a', marginTop: 2, fontFamily: 'monospace' }}>
                {submission.room_id ? `Sala Colaborativa: ${submission.room_id}` : 'Sessão de Avaliação Individual'}
              </div>
            </div>
          </div>

          {/* Destaque do Desempenho / Conceito Formativo */}
          <div
            style={{
              padding: '16px 20px',
              borderRadius: 12,
              border: `2px solid ${grade.borderColor}`,
              backgroundColor: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 28,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 12,
                  backgroundColor: grade.bgColor,
                  color: grade.color,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '1.5rem',
                  fontWeight: 900,
                }}
              >
                <Award size={28} />
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>
                  Conceito Formativo Alcançado
                </div>
                <div style={{ fontSize: '1.3rem', fontWeight: 900, color: grade.color }}>
                  {grade.icon} {grade.label}
                </div>
                <div style={{ fontSize: '0.8rem', color: '#475569', marginTop: 2 }}>
                  {grade.description}
                </div>
              </div>
            </div>

            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>
                Nota Final
              </div>
              <div style={{ fontSize: '2.2rem', fontWeight: 900, color: '#0f172a' }}>
                {submission.score.toFixed(1)}
                <span style={{ fontSize: '1rem', fontWeight: 600, color: '#94a3b8' }}> / 10.0</span>
              </div>
              <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#475569' }}>
                {submission.correct_answers || 0} acertos de {submission.total_questions || 5} questões
              </div>
            </div>
          </div>

          {/* Relação das 5 Questões e Gabarito */}
          <div>
            <h3
              style={{
                fontSize: '1.05rem',
                fontWeight: 800,
                color: '#0f172a',
                borderBottom: '1px solid #cbd5e1',
                paddingBottom: 8,
                marginBottom: 16,
              }}
            >
              Detalhamento Pedagógico das Questões
            </h3>

            {questions.length === 0 && (
              <p style={{ color: '#64748b', fontSize: '0.88rem' }}>
                As questões completas foram registradas com sucesso no histórico da instituição.
              </p>
            )}

            {questions.map((q, idx) => {
              const selectedIdx = answers[idx] ?? answers[String(idx)]
              const isCorrect = selectedIdx === q.correctIndex

              return (
                <div
                  key={q.id || idx}
                  style={{
                    padding: '12px 16px',
                    borderRadius: 8,
                    border: '1px solid #e2e8f0',
                    backgroundColor: idx % 2 === 0 ? '#f8fafc' : '#ffffff',
                    marginBottom: 12,
                    pageBreakInside: 'avoid',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#0f172a', lineHeight: 1.4 }}>
                      Questão {idx + 1}: {q.question}
                    </div>
                    <div
                      style={{
                        padding: '2px 8px',
                        borderRadius: 6,
                        fontSize: '0.78rem',
                        fontWeight: 700,
                        backgroundColor: isCorrect ? '#dcfce7' : '#fee2e2',
                        color: isCorrect ? '#15803d' : '#b91c1c',
                        border: `1px solid ${isCorrect ? '#86efac' : '#fca5a5'}`,
                        flexShrink: 0,
                      }}
                    >
                      {isCorrect ? 'Acertou (+2.0)' : 'Incorreta'}
                    </div>
                  </div>

                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {q.options.map((opt, optIdx) => {
                      const wasSelected = selectedIdx === optIdx
                      const isOptionCorrect = q.correctIndex === optIdx

                      let optColor = '#475569'
                      let optWeight = 400
                      let marker = '( )'

                      if (isOptionCorrect) {
                        optColor = '#15803d'
                        optWeight = 700
                        marker = '(✓ GABARITO)'
                      }
                      if (wasSelected && !isCorrect) {
                        optColor = '#b91c1c'
                        optWeight = 700
                        marker = '(✗ SUA RESPOSTA)'
                      } else if (wasSelected && isCorrect) {
                        marker = '(✓ SUA RESPOSTA)'
                      }

                      return (
                        <div
                          key={optIdx}
                          style={{
                            fontSize: '0.85rem',
                            color: optColor,
                            fontWeight: optWeight,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          <span style={{ fontSize: '0.78rem', fontFamily: 'monospace' }}>{marker}</span>
                          <span>{opt}</span>
                        </div>
                      )
                    })}
                  </div>

                  {q.explanation && (
                    <div
                      style={{
                        marginTop: 8,
                        padding: '6px 10px',
                        borderRadius: 6,
                        backgroundColor: '#f1f5f9',
                        fontSize: '0.78rem',
                        color: '#334155',
                        borderLeft: '3px solid #7c3aed',
                      }}
                    >
                      <strong>Fundamentação Pedagógica:</strong> {q.explanation}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Rodapé e Assinatura */}
          <div
            style={{
              marginTop: 32,
              paddingTop: 16,
              borderTop: '1px solid #cbd5e1',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '0.78rem',
              color: '#64748b',
              pageBreakInside: 'avoid',
            }}
          >
            <div>
              Documento emitido eletronicamente via <strong>Leitor Inteligente</strong>.
              <br />
              Válido para fins de frequência, verificação de aprendizagem e composição de média acadêmica.
            </div>

            <div style={{ textAlign: 'center', minWidth: 200 }}>
              <div style={{ borderBottom: '1px solid #0f172a', width: 180, marginBottom: 4 }} />
              <span>Coordenação Pedagógica / Tutor</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
