import { useState } from 'react'
import { Copy, Share2, MessageCircle, Check } from 'lucide-react'

interface Props {
  text: string
  bookTitle?: string
}

/**
 * Ações rápidas sobre uma resposta do Professor IA:
 * - Copiar texto
 * - Compartilhar (Web Share API se disponível, fallback wa.me)
 * - Mensageiro direto (Facebook Messenger via sharer)
 *
 * O texto é compartilhado com o título do livro como cabeçalho e as fontes como rodapé.
 */
export function ShareActions({ text, bookTitle }: Props) {
  const [copied, setCopied] = useState(false)

  const fullText = bookTitle
    ? `📚 ${bookTitle}\n\n${text}\n\n— Leitor Inteligente`
    : text

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Fallback: textarea
      const ta = document.createElement('textarea')
      ta.value = fullText
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* noop */ }
      document.body.removeChild(ta)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    }
  }

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: bookTitle ?? 'Leitor Inteligente', text: fullText })
      } catch {
        /* user cancelled */
      }
      return
    }
    // Fallback: wa.me
    const url = `https://wa.me/?text=${encodeURIComponent(fullText)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const handleMessenger = () => {
    // Facebook Messenger sharer (mesmo no mobile abre o app)
    const url = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent('https://preview.automacaojs.us/leitor-inteligente/')}&quote=${encodeURIComponent(fullText)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="share-actions" style={{ display: 'flex', gap: 6, marginTop: 8 }}>
      <button
        type="button"
        className="share-btn"
        onClick={handleCopy}
        title="Copiar descrição"
        aria-label="Copiar descrição"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        <span>{copied ? 'Copiado' : 'Copiar'}</span>
      </button>
      <button
        type="button"
        className="share-btn"
        onClick={handleShare}
        title="Compartilhar (WhatsApp / Web Share)"
        aria-label="Compartilhar"
      >
        <Share2 size={14} />
        <span>Compartilhar</span>
      </button>
      <button
        type="button"
        className="share-btn"
        onClick={handleMessenger}
        title="Enviar pelo Messenger"
        aria-label="Enviar pelo Messenger"
      >
        <MessageCircle size={14} />
        <span>Messenger</span>
      </button>
    </div>
  )
}
