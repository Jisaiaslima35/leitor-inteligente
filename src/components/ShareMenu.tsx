/**
 * ShareMenu — Compartilha o link de campanha do livro.
 *
 * Mostra botão "Compartilhar" com 2 opções:
 * - "Copiar link" — copia URL com ?src=canal
 * - "Compartilhar no WhatsApp" — abre wa.me com mensagem pré-preenchida
 *
 * Aparece no BookCard da StorePage (vitrine pública) e no Admin.
 */
import { useState } from 'react'
import { Share2, Copy, Check, MessageCircle, ChevronDown } from 'lucide-react'

interface Props {
  ebookSlug: string
  bookTitle: string
}

const CHANNELS = [
  { value: 'instagram', label: 'Instagram (copiar link)' },
  { value: 'whatsapp',  label: 'WhatsApp' },
  { value: 'telegram',  label: 'Telegram' },
  { value: 'outro',     label: 'Outro (só copiar)' },
]

const BASE = 'https://preview.automacaojs.us/leitor-inteligente'

export function ShareMenu({ ebookSlug, bookTitle }: Props) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const linkInstagram = `${BASE}/#/comprar/${encodeURIComponent(ebookSlug)}?src=instagram`
  const message = `Olha esse livro que achei: ${bookTitle} — ${linkInstagram}`

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(linkInstagram)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = linkInstagram
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
    setOpen(false)
  }

  const handleWhatsApp = () => {
    const url = `https://wa.me/?text=${encodeURIComponent(message)}`
    window.open(url, '_blank', 'noopener,noreferrer')
    setOpen(false)
  }

  return (
    <div style={{ position: 'relative', display: 'inline-block' }} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title="Compartilhar"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '6px 10px',
          fontSize: 12,
          background: 'transparent',
          color: 'var(--primary, #1f7a3a)',
          border: '1px solid var(--primary, #1f7a3a)',
          borderRadius: 6,
          cursor: 'pointer',
        }}
      >
        <Share2 size={13} />
        Compartilhar
        <ChevronDown size={11} />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            background: 'var(--bg-card, #fff)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
            zIndex: 10,
            minWidth: 200,
            padding: 4,
          }}
        >
          <button
            type="button"
            onClick={handleCopy}
            style={menuBtnStyle}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? 'Copiado!' : 'Copiar link do Instagram'}
          </button>
          <button
            type="button"
            onClick={handleWhatsApp}
            style={menuBtnStyle}
          >
            <MessageCircle size={14} />
            Compartilhar no WhatsApp
          </button>
        </div>
      )}
    </div>
  )
}

const menuBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  textAlign: 'left',
  padding: '8px 10px',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  borderRadius: 4,
  fontSize: 13,
}
