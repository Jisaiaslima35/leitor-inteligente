import { useEffect, useRef } from 'react'

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink'

export const COLOR_BG: Record<HighlightColor, string> = {
  yellow: 'rgba(255, 235, 59, 0.55)',
  green: 'rgba(129, 199, 132, 0.55)',
  blue: 'rgba(100, 181, 246, 0.55)',
  pink: 'rgba(244, 143, 177, 0.55)',
}

export interface SelectionInfo {
  text: string
  startIdx: number
  endIdx: number
  rect: { top: number; left: number; right: number; bottom: number }
}

interface Props {
  selection: SelectionInfo
  onPickColor: (color: HighlightColor) => Promise<void> | void
  onAnnotate: (color: HighlightColor) => void
  onAskProfessor: () => void
  onDismiss: () => void
}

// Floating toolbar que aparece ao terminar a seleção de texto no PDF.
// Posiciona-se logo acima do selection rect (com fallback pra viewport
// em mobile com teclado aberto). Cores + nota + atalho pro Professor IA.
//
// 04/09/2026 — Turno 2 dos Highlights.
export function SelectionToolbar({ selection, onPickColor, onAnnotate, onAskProfessor, onDismiss }: Props) {
  const cardRef = useRef<HTMLDivElement>(null)
  // onMouseDown no card: impede perder a seleção ao clicar em botão.
  // (mouseup fora do textLayer remove a selection do browser.)
  const cancelMouseDown = (e: React.MouseEvent) => e.preventDefault()

  // Auto-posiciona acima do rect, com fallback pra abaixo se não couber.
  const CARD_W = 360
  const PAD = 8
  const desiredTop = selection.rect.top - 52
  const top = desiredTop < PAD
    ? Math.min(window.innerHeight - 64, selection.rect.bottom + 12)
    : desiredTop
  const center = (selection.rect.left + selection.rect.right) / 2
  const left = Math.min(window.innerWidth - CARD_W - PAD, Math.max(PAD, center - CARD_W / 2))

  // Dismiss quando user clica fora do card E não há nova seleção ativa.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!cardRef.current) return
      if (cardRef.current.contains(e.target as Node)) return
      // Se clicou no textLayer, ignora — pode ser nova seleção.
      const tgt = e.target as HTMLElement | null
      if (tgt?.closest('.textLayer')) return
      onDismiss()
    }
    // Use mouseup pra coincidir com o ciclo do selection.
    document.addEventListener('mouseup', onDocClick)
    return () => document.removeEventListener('mouseup', onDocClick)
  }, [onDismiss])

  return (
    <div
      ref={cardRef}
      className="selection-toolbar"
      role="toolbar"
      aria-label="Ações do texto selecionado"
      onMouseDown={cancelMouseDown}
      style={{
        position: 'fixed',
        top,
        left,
        width: CARD_W,
        zIndex: 1000,
        background: 'linear-gradient(135deg, #2a2540, #3a3150)',
        border: '1px solid #d4af37',
        borderRadius: 12,
        padding: '8px 10px',
        boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
        color: '#e8e0d0',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', gap: 4 }} aria-label="Cor do grifo">
        {(Object.keys(COLOR_BG) as HighlightColor[]).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onPickColor(c)}
            aria-label={`Grifar com ${c}`}
            title={`Grifar com ${c}`}
            style={{
              width: 26,
              height: 26,
              borderRadius: 13,
              background: COLOR_BG[c],
              border: '2px solid rgba(255,255,255,0.6)',
              cursor: 'pointer',
              padding: 0,
            }}
          />
        ))}
      </div>
      <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.18)' }} />
      <button
        type="button"
        onClick={() => onAnnotate('yellow')}
        title="Adicionar nota ao grifo"
        style={{
          background: 'transparent',
          border: '1px solid #d4af37',
          color: '#e8e0d0',
          padding: '5px 10px',
          borderRadius: 6,
          cursor: 'pointer',
          fontSize: 13,
        }}
      >
        📝 Anotar
      </button>
      <button
        type="button"
        onClick={onAskProfessor}
        title="Manda o trecho pro Professor IA"
        style={{
          background: 'linear-gradient(135deg, #d4af37, #b8941f)',
          border: 'none',
          color: '#1a1530',
          padding: '5px 10px',
          borderRadius: 6,
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        🤖 Professor IA
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Fechar barra de seleção"
        title="Fechar"
        style={{
          background: 'transparent',
          border: 'none',
          color: '#bdb4a0',
          padding: '4px 8px',
          cursor: 'pointer',
          fontSize: 18,
          lineHeight: 1,
        }}
      >×</button>
    </div>
  )
}
