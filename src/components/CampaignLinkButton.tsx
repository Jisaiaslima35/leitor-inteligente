/**
 * CampaignLinkButton — Gera e copia links de campanha.
 *
 * Cada livro do catálogo recebe um link único:
 *   {window.location.origin}{BASE_URL}#/comprar/{slug}?src={canal}
 *
 * 06/09/2026 v11: BASE_URL dinâmico — raiz no subdomínio novo
 * (leitorinteligente.automacaojs.us), path prefix no preview antigo.
 *
 * O admin escolhe o canal (Instagram/YouTube/WhatsApp/Outro) antes de copiar
 * pra que a `traffic_source` chegue no webhook do Mercado Pago e seja salva em
 * purchases.traffic_source.
 */
import { useState } from 'react'
import { Link2, Copy, Check, ChevronDown } from 'lucide-react'
import { BASE_URL, absoluteUrl } from '../lib/baseUrl'

interface Props {
  ebookSlug: string
}

const CHANNELS = [
  { value: 'instagram', label: 'Instagram' },
  { value: 'youtube',   label: 'YouTube' },
  { value: 'whatsapp',  label: 'WhatsApp' },
  { value: 'telegram',  label: 'Telegram' },
  { value: 'email',     label: 'E-mail' },
  { value: 'outro',     label: 'Outro' },
]

export function CampaignLinkButton({ ebookSlug }: Props) {
  const [channel, setChannel] = useState<string>('instagram')
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)  // mensagem de feedback

  const link = `${absoluteUrl(BASE_URL)}#/comprar/${encodeURIComponent(ebookSlug)}?src=${channel}`

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(`Copiado (${channel})`)
      setTimeout(() => setCopied(null), 2500)
    } catch {
      // fallback pra browsers sem clipboard API
      const ta = document.createElement('textarea')
      ta.value = link
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopied(`Copiado (${channel})`)
      setTimeout(() => setCopied(null), 2500)
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={() => setOpen(!open)}
          style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px' }}
        >
          <Link2 size={13} />
          Campanha
          <ChevronDown size={11} />
        </button>
        {open && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: 4,
              background: 'var(--bg-card, #fff)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
              zIndex: 10,
              minWidth: 140,
              padding: 4,
            }}
          >
            {CHANNELS.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => { setChannel(c.value); setOpen(false) }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 10px',
                  border: 'none',
                  background: channel === c.value ? 'var(--bg-active, #f0f0f0)' : 'transparent',
                  cursor: 'pointer',
                  borderRadius: 4,
                  fontSize: 13,
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={handleCopy}
        title={link}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 10px',
          fontSize: 12,
          background: copied ? 'var(--green, #2e7d32)' : 'var(--primary, #1f7a3a)',
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          cursor: 'pointer',
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied || 'Copiar link'}
      </button>
    </div>
  )
}
