import React, { useState } from 'react'
import { GraduationCap, ArrowRight, UserCheck, ShieldCheck } from 'lucide-react'

interface Props {
  isOpen: boolean
  onIdentified: (fullName: string, identifier: string) => void
  tenantName?: string
  roomId?: string
}

export function StudentIdentificationModal({ isOpen, onIdentified, tenantName, roomId }: Props) {
  const [fullName, setFullName] = useState(() => {
    if (typeof window === 'undefined') return ''
    const saved = (localStorage.getItem('leitor-ia:student-name') || '').trim()
    const s = saved.toLowerCase()
    if (s.includes('convidado') || s.includes('demo') || s === 'leitor') return ''
    return saved
  })

  const [identifier, setIdentifier] = useState(() => {
    if (typeof window === 'undefined') return ''
    const saved = (localStorage.getItem('leitor-ia:student-id') || '').trim()
    const s = saved.toLowerCase()
    if (s.startsWith('guest_') || s.includes('demo') || s.startsWith('mat-')) return ''
    return saved
  })

  const [error, setError] = useState<string | null>(null)

  if (!isOpen) return null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const cleanName = fullName.trim()
    const cleanId = identifier.trim()

    if (!cleanName || cleanName.length < 3) {
      setError('Por favor, informe seu Nome Completo (mínimo de 3 caracteres).')
      return
    }

    const lowerName = cleanName.toLowerCase()
    if (lowerName.includes('convidado') || lowerName.includes('demo') || lowerName === 'leitor') {
      setError('Por favor, informe seu Nome Completo real (apelidos genéricos ou demo não são permitidos).')
      return
    }

    if (!cleanId || cleanId.length < 3) {
      setError('Por favor, informe sua Matrícula Institucional ou CPF para validação acadêmica.')
      return
    }

    const lowerId = cleanId.toLowerCase()
    if (lowerId.startsWith('guest_') || lowerId.includes('demo')) {
      setError('Por favor, informe sua Matrícula ou CPF válido.')
      return
    }

    try {
      localStorage.setItem('leitor-ia:student-name', cleanName)
      localStorage.setItem('leitor-ia:student-id', cleanId)
      // Sobrescreve expressamente qualquer apelido legado
      localStorage.setItem('leitor-ia:guest-name', cleanName)
      localStorage.setItem('leitor-ia:guest-id', cleanId)
      sessionStorage.setItem('leitor-ia:guest-name', cleanName)
      sessionStorage.setItem('leitor-ia:student-name', cleanName)
      if (roomId) {
        sessionStorage.setItem(`leitor-ia:room-identified-${roomId}`, 'true')
      }
    } catch {
      // Ignora erro de storage restrito
    }

    onIdentified(cleanName, cleanId)
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999999,
        backgroundColor: 'rgba(5, 10, 20, 0.88)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 480,
          backgroundColor: '#0f172a',
          borderRadius: 20,
          border: '1px solid rgba(168, 85, 247, 0.4)',
          boxShadow: '0 20px 50px -10px rgba(147, 51, 234, 0.35)',
          overflow: 'hidden',
          animation: 'fadeInScale 0.25s ease-out forwards',
        }}
      >
        {/* Topo / Banner decorativo */}
        <div
          style={{
            padding: '24px 28px',
            background: 'linear-gradient(135deg, rgba(147, 51, 234, 0.25) 0%, rgba(37, 99, 235, 0.2) 100%)',
            borderBottom: '1px solid rgba(168, 85, 247, 0.25)',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <div
            style={{
              width: 50,
              height: 50,
              borderRadius: 14,
              backgroundColor: 'rgba(168, 85, 247, 0.2)',
              border: '1px solid #c084fc',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#c084fc',
              flexShrink: 0,
            }}
          >
            <GraduationCap size={28} />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 800, color: '#ffffff' }}>
              Identificação do Estudante
            </h3>
            <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: '#94a3b8' }}>
              {tenantName || 'Sala de Aula Colaborativa'} • Registro de Presença e Avaliação
            </p>
          </div>
        </div>

        {/* Formulário */}
        <form onSubmit={handleSubmit} style={{ padding: '24px 28px' }}>
          <div
            style={{
              padding: '12px 14px',
              borderRadius: 10,
              backgroundColor: 'rgba(56, 189, 248, 0.1)',
              border: '1px solid rgba(56, 189, 248, 0.25)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              marginBottom: 20,
            }}
          >
            <ShieldCheck size={18} style={{ color: '#38bdf8', flexShrink: 0, marginTop: 2 }} />
            <span style={{ fontSize: '0.82rem', color: '#bae6fd', lineHeight: 1.4 }}>
              Para ingressar na sala com seu nome real e registrar suas notas oficiais no boletim institucional, informe seus dados:
            </span>
          </div>

          {error && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 8,
                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.35)',
                color: '#fca5a5',
                fontSize: '0.82rem',
                marginBottom: 16,
              }}
            >
              {error}
            </div>
          )}

          {/* Campo 1: Nome Completo */}
          <div style={{ marginBottom: 18 }}>
            <label
              style={{
                display: 'block',
                fontSize: '0.84rem',
                fontWeight: 600,
                color: '#e2e8f0',
                marginBottom: 6,
              }}
            >
              Nome Completo do Aluno <span style={{ color: '#f87171' }}>*</span>
            </label>
            <input
              type="text"
              autoFocus
              placeholder="Ex: João Victor Silva"
              value={fullName}
              onChange={(e) => {
                setFullName(e.target.value)
                if (error) setError(null)
              }}
              style={{
                width: '100%',
                padding: '12px 14px',
                borderRadius: 10,
                border: '1px solid #334155',
                backgroundColor: '#1e293b',
                color: '#ffffff',
                fontSize: '0.92rem',
                outline: 'none',
                boxSizing: 'border-box',
                transition: 'border-color 0.2s',
              }}
              onFocus={(e) => (e.target.style.borderColor = '#c084fc')}
              onBlur={(e) => (e.target.style.borderColor = '#334155')}
            />
          </div>

          {/* Campo 2: Matrícula ou CPF */}
          <div style={{ marginBottom: 24 }}>
            <label
              style={{
                display: 'block',
                fontSize: '0.84rem',
                fontWeight: 600,
                color: '#e2e8f0',
                marginBottom: 6,
              }}
            >
              Matrícula Institucional ou CPF <span style={{ color: '#f87171' }}>*</span>
            </label>
            <input
              type="text"
              placeholder="Ex: 20261084 ou CPF do aluno"
              value={identifier}
              onChange={(e) => {
                setIdentifier(e.target.value)
                if (error) setError(null)
              }}
              style={{
                width: '100%',
                padding: '12px 14px',
                borderRadius: 10,
                border: '1px solid #334155',
                backgroundColor: '#1e293b',
                color: '#ffffff',
                fontSize: '0.92rem',
                outline: 'none',
                boxSizing: 'border-box',
                transition: 'border-color 0.2s',
              }}
              onFocus={(e) => (e.target.style.borderColor = '#c084fc')}
              onBlur={(e) => (e.target.style.borderColor = '#334155')}
            />
            <small style={{ color: '#64748b', fontSize: '0.75rem', marginTop: 4, display: 'block' }}>
              Identificador único usado para validar a entrega de avaliações e boletins.
            </small>
          </div>

          <button
            type="submit"
            style={{
              width: '100%',
              padding: '14px',
              borderRadius: 10,
              background: 'linear-gradient(135deg, #7c3aed 0%, #2563eb 100%)',
              color: '#ffffff',
              fontWeight: 700,
              fontSize: '0.95rem',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              boxShadow: '0 4px 16px rgba(37, 99, 235, 0.4)',
              transition: 'transform 0.15s ease',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.transform = 'translateY(-1px) scale(1.01)')}
            onMouseLeave={(e) => (e.currentTarget.style.transform = 'translateY(0) scale(1)')}
          >
            <UserCheck size={18} />
            <span>Confirmar e Entrar na Sala de Aula</span>
            <ArrowRight size={16} />
          </button>
        </form>
      </div>
    </div>
  )
}
