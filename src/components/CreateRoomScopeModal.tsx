import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { BookOpen, Users, AlertCircle, ArrowRight, X } from 'lucide-react'

interface Props {
  isOpen: boolean
  onClose: () => void
  bookTitle: string
  totalPages: number
  currentPage: number
  onConfirm: (pageStart: number, pageEnd: number) => void
}

export function CreateRoomScopeModal({
  isOpen,
  onClose,
  bookTitle,
  totalPages,
  currentPage,
  onConfirm,
}: Props) {
  const safeTotal = Math.max(1, totalPages || 1)
  const initialStart = Math.min(Math.max(1, currentPage || 1), safeTotal)
  const initialEnd = Math.min(Math.max(initialStart, initialStart + 4), safeTotal)

  const [pageStart, setPageStart] = useState<number>(initialStart)
  const [pageEnd, setPageEnd] = useState<number>(initialEnd)
  const [touched, setTouched] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen) {
      const start = Math.min(Math.max(1, currentPage || 1), safeTotal)
      const end = Math.min(Math.max(start, start + 4), safeTotal)
      setPageStart(start)
      setPageEnd(end)
      setTouched(false)
      setErrorMsg(null)
    }
  }, [isOpen, currentPage, safeTotal])

  useEffect(() => {
    if (!touched) return
    if (!pageStart || pageStart < 1) {
      setErrorMsg('A página inicial deve ser maior ou igual a 1.')
      return
    }
    if (pageStart > safeTotal) {
      setErrorMsg(`A página inicial não pode exceder o total da obra (${safeTotal} páginas).`)
      return
    }
    if (!pageEnd || pageEnd < pageStart) {
      setErrorMsg('A página final deve ser maior ou igual à página inicial.')
      return
    }
    if (pageEnd > safeTotal) {
      setErrorMsg(`A página final não pode exceder o total da obra (${safeTotal} páginas).`)
      return
    }
    setErrorMsg(null)
  }, [pageStart, pageEnd, touched, safeTotal])

  if (!isOpen) return null

  const isValid =
    Number.isInteger(pageStart) &&
    Number.isInteger(pageEnd) &&
    pageStart >= 1 &&
    pageStart <= safeTotal &&
    pageEnd >= pageStart &&
    pageEnd <= safeTotal

  const handleStartSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (!isValid) return
    onConfirm(pageStart, pageEnd)
  }

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999999,
        backgroundColor: 'rgba(5, 5, 10, 0.85)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 480,
          backgroundColor: '#0f172a',
          borderRadius: 20,
          border: '1px solid rgba(168, 85, 247, 0.35)',
          boxShadow: '0 25px 60px -15px rgba(0, 0, 0, 0.7), 0 0 30px rgba(147, 51, 234, 0.15)',
          overflow: 'hidden',
          animation: 'fadeInScale 0.2s ease-out',
        }}
      >
        {/* Top Header */}
        <div
          style={{
            padding: '20px 24px',
            background: 'linear-gradient(135deg, rgba(88, 28, 135, 0.4) 0%, rgba(30, 27, 75, 0.6) 100%)',
            borderBottom: '1px solid rgba(168, 85, 247, 0.25)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 12,
                backgroundColor: 'rgba(168, 85, 247, 0.2)',
                border: '1px solid rgba(168, 85, 247, 0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#c084fc',
              }}
            >
              <Users size={20} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#ffffff' }}>
                Criar Sala de Estudo
              </h3>
              <p style={{ margin: '2px 0 0', fontSize: '0.8rem', color: '#cbd5e1' }}>
                Defina o escopo obrigatório de páginas
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              padding: 6,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleStartSubmit} style={{ padding: '24px' }}>
          {/* Obra e Total */}
          <div
            style={{
              padding: '12px 16px',
              borderRadius: 12,
              backgroundColor: 'rgba(30, 41, 59, 0.7)',
              border: '1px solid rgba(148, 163, 184, 0.15)',
              marginBottom: 20,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <BookOpen size={18} style={{ color: '#38bdf8', flexShrink: 0 }} />
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: '0.86rem',
                    fontWeight: 600,
                    color: '#f8fafc',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  title={bookTitle}
                >
                  {bookTitle}
                </div>
                <div style={{ fontSize: '0.76rem', color: '#94a3b8' }}>
                  Total de páginas: <strong style={{ color: '#38bdf8' }}>{safeTotal}</strong>
                </div>
              </div>
            </div>

            <div
              style={{
                fontSize: '0.76rem',
                padding: '4px 10px',
                borderRadius: 999,
                backgroundColor: 'rgba(56, 189, 248, 0.15)',
                color: '#38bdf8',
                fontWeight: 600,
                border: '1px solid rgba(56, 189, 248, 0.3)',
              }}
            >
              PDF Ativo
            </div>
          </div>

          {/* Inputs de Intervalo */}
          <div style={{ marginBottom: 18 }}>
            <label
              style={{
                display: 'block',
                fontSize: '0.85rem',
                fontWeight: 600,
                color: '#e2e8f0',
                marginBottom: 8,
              }}
            >
              Intervalo de Estudo da Sala:
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 30px 1fr', gap: 8, alignItems: 'center' }}>
              <div>
                <span style={{ fontSize: '0.75rem', color: '#94a3b8', display: 'block', marginBottom: 4 }}>
                  Página Inicial
                </span>
                <input
                  type="number"
                  min={1}
                  max={safeTotal}
                  value={pageStart}
                  onChange={(e) => {
                    setTouched(true)
                    setPageStart(parseInt(e.target.value, 10) || 0)
                  }}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    borderRadius: 10,
                    backgroundColor: '#1e293b',
                    border: `1px solid ${
                      touched && (pageStart < 1 || pageStart > safeTotal)
                        ? '#ef4444'
                        : 'rgba(148, 163, 184, 0.3)'
                    }`,
                    color: '#ffffff',
                    fontSize: '1rem',
                    fontWeight: 700,
                    textAlign: 'center',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: '0.9rem', fontWeight: 600, marginTop: 18 }}>
                até
              </div>

              <div>
                <span style={{ fontSize: '0.75rem', color: '#94a3b8', display: 'block', marginBottom: 4 }}>
                  Página Final
                </span>
                <input
                  type="number"
                  min={pageStart || 1}
                  max={safeTotal}
                  value={pageEnd}
                  onChange={(e) => {
                    setTouched(true)
                    setPageEnd(parseInt(e.target.value, 10) || 0)
                  }}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    borderRadius: 10,
                    backgroundColor: '#1e293b',
                    border: `1px solid ${
                      touched && (pageEnd < pageStart || pageEnd > safeTotal)
                        ? '#ef4444'
                        : 'rgba(148, 163, 184, 0.3)'
                    }`,
                    color: '#ffffff',
                    fontSize: '1rem',
                    fontWeight: 700,
                    textAlign: 'center',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            </div>
          </div>

          {/* Mensagem de Erro / Alerta Visual */}
          {errorMsg && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 14px',
                borderRadius: 10,
                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.35)',
                color: '#fca5a5',
                fontSize: '0.82rem',
                marginBottom: 16,
              }}
            >
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Resumo do Escopo */}
          {isValid && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 10,
                backgroundColor: 'rgba(168, 85, 247, 0.12)',
                border: '1px solid rgba(168, 85, 247, 0.3)',
                color: '#e9d5ff',
                fontSize: '0.84rem',
                marginBottom: 20,
                textAlign: 'center',
              }}
            >
              📖 Escopo Definido: <strong>Páginas {pageStart} a {pageEnd}</strong> ({pageEnd - pageStart + 1} {pageEnd - pageStart + 1 === 1 ? 'página' : 'páginas'})
            </div>
          )}

          {/* Botões de Ação */}
          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 10 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '11px 20px',
                borderRadius: 10,
                border: '1px solid rgba(148, 163, 184, 0.25)',
                backgroundColor: 'transparent',
                color: '#cbd5e1',
                fontSize: '0.88rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Cancelar
            </button>

            <button
              type="submit"
              disabled={!isValid}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '11px 24px',
                borderRadius: 10,
                border: 'none',
                background: isValid
                  ? 'linear-gradient(90deg, #9333ea 0%, #7c3aed 100%)'
                  : 'rgba(148, 163, 184, 0.2)',
                color: isValid ? '#ffffff' : '#64748b',
                fontSize: '0.9rem',
                fontWeight: 700,
                cursor: isValid ? 'pointer' : 'not-allowed',
                boxShadow: isValid ? '0 4px 14px rgba(147, 51, 234, 0.4)' : 'none',
                transition: 'all 0.2s ease',
              }}
            >
              <span>Criar Sala e Gerar Link</span>
              <ArrowRight size={16} />
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}
