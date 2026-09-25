import { useEffect, useState } from 'react'
import { ShieldAlert, CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'
import type { ToastMessage } from '../lib/toast'

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  useEffect(() => {
    const handleToast = (e: Event) => {
      const customEvent = e as CustomEvent<ToastMessage>
      if (!customEvent.detail) return
      const newToast = customEvent.detail
      setToasts((prev) => [...prev, newToast])

      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== newToast.id))
      }, 4500)
    }

    window.addEventListener('app-toast', handleToast)
    return () => window.removeEventListener('app-toast', handleToast)
  }, [])

  if (toasts.length === 0) return null

  return (
    <div
      style={{
        position: 'fixed',
        top: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999999,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        maxWidth: '92vw',
        width: 440,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => {
        let bg = 'rgba(15, 23, 42, 0.95)'
        let border = '1px solid #38bdf8'
        let icon = <Info size={20} style={{ color: '#38bdf8', flexShrink: 0 }} />

        if (t.type === 'warning') {
          bg = 'rgba(30, 20, 10, 0.96)'
          border = '1px solid #f59e0b'
          icon = <AlertTriangle size={20} style={{ color: '#f59e0b', flexShrink: 0 }} />
        } else if (t.type === 'error') {
          bg = 'rgba(35, 15, 15, 0.96)'
          border = '1px solid #ef4444'
          icon = <ShieldAlert size={20} style={{ color: '#ef4444', flexShrink: 0 }} />
        } else if (t.type === 'success') {
          bg = 'rgba(10, 30, 20, 0.96)'
          border = '1px solid #22c55e'
          icon = <CheckCircle2 size={20} style={{ color: '#22c55e', flexShrink: 0 }} />
        }

        return (
          <div
            key={t.id}
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: '12px 18px',
              borderRadius: 14,
              backgroundColor: bg,
              border,
              boxShadow: '0 12px 36px rgba(0, 0, 0, 0.6)',
              backdropFilter: 'blur(12px)',
              color: '#ffffff',
              fontSize: '0.9rem',
              fontWeight: 600,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {icon}
              <span>{t.message}</span>
            </div>
            <button
              onClick={() => setToasts((prev) => prev.filter((item) => item.id !== t.id))}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--muted)',
                cursor: 'pointer',
                padding: 4,
                display: 'flex',
              }}
              title="Fechar"
            >
              <X size={15} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
