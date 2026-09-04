import { useEffect, useState, useCallback } from 'react'
import { CheckCircle2, Circle, Sparkles } from 'lucide-react'

interface ChecklistCapituloProps {
  bookSlug: string
  chapterId: string
  accessToken: string
  /** Lista fixa de itens; default cobre o MVP do Modo Mentor */
  items?: string[]
}

const DEFAULT_ITEMS = [
  'Li a página com atenção plena',
  'Sublinhei o trecho que mais me tocou',
  'Vou aplicar 1 princípio da leitura hoje',
]

export function ChecklistCapitulo({
  bookSlug,
  chapterId,
  accessToken,
  items = DEFAULT_ITEMS,
}: ChecklistCapituloProps) {
  const [completed, setCompleted] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  // Carrega estado atual do capítulo
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setCompleted(new Set())
    if (!accessToken) {
      setLoading(false)
      return
    }
    fetch(
      `${import.meta.env.BASE_URL}checklist-api/checklist/progress?book_slug=${encodeURIComponent(bookSlug)}&chapter_id=${encodeURIComponent(chapterId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((data) => {
        if (cancelled) return
        const done = new Set<string>()
        for (const it of data.items || []) {
          if (it?.item_id) done.add(it.item_id)
        }
        setCompleted(done)
      })
      .catch(() => {
        if (!cancelled) setCompleted(new Set())
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [bookSlug, chapterId, accessToken])

  const toggle = useCallback(
    async (itemId: string) => {
      if (busy || !accessToken) return
      const wasCompleted = completed.has(itemId)
      // Optimistic update
      setCompleted((prev) => {
        const next = new Set(prev)
        if (wasCompleted) next.delete(itemId)
        else next.add(itemId)
        return next
      })
      setBusy(itemId)
      try {
        await fetch(`${import.meta.env.BASE_URL}checklist-api/checklist/toggle`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            book_slug: bookSlug,
            chapter_id: chapterId,
            item_id: itemId,
            completed: !wasCompleted,
          }),
        })
      } catch {
        // Reverte em caso de erro
        setCompleted((prev) => {
          const next = new Set(prev)
          if (wasCompleted) next.add(itemId)
          else next.delete(itemId)
          return next
        })
      } finally {
        setBusy(null)
      }
    },
    [accessToken, bookSlug, chapterId, busy, completed],
  )

  const done = completed.size
  const total = items.length
  const percent = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <div
      style={{
        marginTop: 18,
        padding: '16px 18px',
        borderRadius: 14,
        background: 'linear-gradient(135deg, rgba(212, 175, 55, 0.08), rgba(212, 175, 55, 0.02))',
        border: '1px solid rgba(212, 175, 55, 0.35)',
        color: '#e8e0d0',
      }}
      role="region"
      aria-label="Checklist do capítulo"
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <strong style={{ color: '#d4af37', fontFamily: 'Georgia, serif', fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Sparkles size={16} />
          Checklist do capítulo
        </strong>
        <span style={{ fontSize: 12, color: '#a89a78', fontVariantNumeric: 'tabular-nums' }}>
          {done}/{total} ({percent}%)
        </span>
      </div>

      <div
        style={{
          height: 6,
          background: 'rgba(212, 175, 55, 0.15)',
          borderRadius: 999,
          overflow: 'hidden',
          marginBottom: 12,
        }}
        aria-hidden="true"
      >
        <div
          style={{
            height: '100%',
            width: `${percent}%`,
            background: 'linear-gradient(90deg, #d4af37, #f0d878)',
            transition: 'width 240ms ease',
          }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((label, idx) => {
          const itemId = `cap-${idx + 1}`
          const isDone = completed.has(itemId)
          return (
            <button
              key={itemId}
              type="button"
              onClick={() => toggle(itemId)}
              disabled={loading || !accessToken}
              aria-pressed={isDone}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                background: 'transparent',
                border: 'none',
                padding: '6px 0',
                textAlign: 'left',
                cursor: loading ? 'wait' : 'pointer',
                color: isDone ? '#d4af37' : '#e8e0d0',
                fontSize: 14,
                lineHeight: 1.4,
                opacity: busy === itemId ? 0.6 : 1,
                transition: 'color 160ms ease',
              }}
            >
              {isDone ? (
                <CheckCircle2 size={18} color="#d4af37" />
              ) : (
                <Circle size={18} color="#6b6280" />
              )}
              <span style={{ textDecoration: isDone ? 'line-through' : 'none', textDecorationColor: 'rgba(212,175,55,0.5)' }}>
                {label}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
