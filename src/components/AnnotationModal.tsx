import { useEffect, useState } from 'react'
import { COLOR_BG, type HighlightColor } from './SelectionToolbar'

export interface Highlight {
  id: string
  page_number: number
  start_idx: number
  end_idx: number
  selected_text: string
  color: HighlightColor
  note_text: string | null
}

type Mode =
  | { kind: 'edit'; highlight: Highlight }
  | { kind: 'create'; draft: { selected_text: string; color: HighlightColor; startIdx: number; endIdx: number; pageNumber: number } }

interface Props {
  mode: Mode | null
  onClose: () => void
  // Pra criar: recebe (note, color) e devolve Promise<Highlight>.
  // Pra editar: recebe (note, color) e devolve Promise<void>.
  onSave: (note: string | null, color: HighlightColor) => Promise<void>
  // Só faz sentido em modo 'edit'.
  onDelete?: () => Promise<void>
}

// Modal pra criar/editar anotação de um grifo. Renderiza:
// - citação do trecho selecionado
// - textarea pra nota pessoal
// - 4 swatches de cor
// - ações: salvar / excluir (se editando) / cancelar
//
// 04/09/2026 — Turno 2 dos Highlights.
export function AnnotationModal({ mode, onClose, onSave, onDelete }: Props) {
  const [note, setNote] = useState('')
  const [color, setColor] = useState<HighlightColor>('yellow')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-popula state quando mode muda (criar novo vs editar outro)
  useEffect(() => {
    if (!mode) return
    setError(null)
    if (mode.kind === 'edit') {
      setNote(mode.highlight.note_text || '')
      setColor(mode.highlight.color)
    } else {
      setNote('')
      setColor(mode.draft.color)
    }
  }, [mode])

  useEffect(() => {
    if (!mode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mode, onClose])

  if (!mode) return null

  const selectedText = mode.kind === 'edit'
    ? mode.highlight.selected_text
    : mode.draft.selected_text

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await onSave(note.trim() || null, color)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!onDelete) return
    if (!confirm('Excluir este grifo e a anotação?')) return
    setSaving(true)
    setError(null)
    try {
      await onDelete()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao excluir')
    } finally {
      setSaving(false)
    }
  }

  const isEdit = mode.kind === 'edit'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? 'Editar anotação' : 'Nova anotação'}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10, 8, 20, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1100,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'linear-gradient(135deg, #1f1a32, #2a2540)',
          color: '#e8e0d0',
          border: '1px solid #d4af37',
          borderRadius: 14,
          padding: 20,
          maxWidth: 520,
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.7)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontFamily: 'Georgia, serif', color: '#d4af37' }}>
            {isEdit ? 'Editar anotação' : 'Nova anotação'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            style={{ background: 'transparent', border: 'none', color: '#bdb4a0', fontSize: 22, cursor: 'pointer' }}
          >×</button>
        </div>
        <blockquote
          style={{
            margin: '0 0 14px',
            padding: '10px 14px',
            background: COLOR_BG[color],
            color: '#1a1530',
            borderLeft: '3px solid #d4af37',
            borderRadius: 6,
            fontStyle: 'italic',
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          “{selectedText}”
        </blockquote>
        <label style={{ display: 'block', fontSize: 13, color: '#bdb4a0', marginBottom: 6 }}>
          Sua reflexão
        </label>
        <textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="O que este trecho te fez pensar?"
          rows={5}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            background: '#15101e',
            color: '#e8e0d0',
            border: '1px solid #3a3150',
            borderRadius: 8,
            padding: 10,
            fontSize: 14,
            resize: 'vertical',
            fontFamily: 'inherit',
          }}
        />
        <div style={{ marginTop: 14 }}>
          <span style={{ fontSize: 13, color: '#bdb4a0', display: 'block', marginBottom: 8 }}>Cor do grifo</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {(Object.keys(COLOR_BG) as HighlightColor[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={`Cor ${c}`}
                aria-pressed={color === c}
                title={c}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 15,
                  background: COLOR_BG[c],
                  border: color === c ? '3px solid #d4af37' : '2px solid rgba(255,255,255,0.4)',
                  cursor: 'pointer',
                  padding: 0,
                }}
              />
            ))}
          </div>
        </div>
        {error && (
          <div style={{ marginTop: 12, color: '#ff8a80', fontSize: 13 }}>⚠ {error}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 18, gap: 8 }}>
          <div>
            {isEdit && onDelete && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving}
                style={{
                  background: 'transparent',
                  border: '1px solid #b94a48',
                  color: '#ff8a80',
                  padding: '8px 14px',
                  borderRadius: 8,
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontSize: 13,
                }}
              >🗑 Excluir</button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              style={{
                background: 'transparent',
                border: '1px solid #6b6280',
                color: '#e8e0d0',
                padding: '8px 14px',
                borderRadius: 8,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >Cancelar</button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              style={{
                background: 'linear-gradient(135deg, #d4af37, #b8941f)',
                border: 'none',
                color: '#1a1530',
                padding: '8px 18px',
                borderRadius: 8,
                cursor: saving ? 'not-allowed' : 'pointer',
                fontWeight: 600,
                fontSize: 13,
              }}
            >{saving ? 'Salvando…' : 'Salvar'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
