import { useEffect, useRef, useState, useCallback } from 'react'
import ePub from 'epubjs'
import type { Book as EpubBookInstance, Rendition } from 'epubjs'
import { ChevronLeft, ChevronRight, Sun, Moon, BookOpen, Type } from 'lucide-react'
import type { Highlight } from './AnnotationModal'
import type { SelectionInfo } from './SelectionToolbar'

interface Props {
  url: string
  page: number
  totalPages?: number
  onPageChange: (page: number) => void
  onInternalNav?: (page: number) => void
  scale?: number
  onTextExtracted?: (text: string) => void
  highlights?: Highlight[]
  onSelectionChange?: (info: SelectionInfo | null) => void
  onHighlightClick?: (h: Highlight) => void
}

type ThemeMode = 'dark' | 'sepia' | 'light'

const THEME_STYLES = {
  dark: {
    name: 'Escuro',
    bg: '#18181b',
    text: '#e4e4e7',
    border: '#27272a',
    muted: '#a1a1aa',
  },
  sepia: {
    name: 'Sépia',
    bg: '#fbf0d9',
    text: '#3b2f1e',
    border: '#e8dcbe',
    muted: '#7a6a52',
  },
  light: {
    name: 'Claro',
    bg: '#ffffff',
    text: '#18181b',
    border: '#e4e4e7',
    muted: '#71717a',
  },
}

export function EpubViewer({
  url,
  page,
  totalPages = 100,
  onPageChange,
  scale = 1.0,
  onTextExtracted,
  onSelectionChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<EpubBookInstance | null>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const currentPageRef = useRef<number>(page)
  const isNavigatingLocallyRef = useRef<boolean>(false)

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [currentChapter, setCurrentChapter] = useState<string>('')
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('leitor-ia:epub-theme') as ThemeMode
      if (saved && (saved === 'dark' || saved === 'sepia' || saved === 'light')) return saved
    }
    return 'dark'
  })

  // Refs para callbacks para evitar listeners obsoletos
  const onPageChangeRef = useRef(onPageChange)
  useEffect(() => { onPageChangeRef.current = onPageChange }, [onPageChange])

  const onTextExtractedRef = useRef(onTextExtracted)
  useEffect(() => { onTextExtractedRef.current = onTextExtracted }, [onTextExtracted])

  const onSelectionChangeRef = useRef(onSelectionChange)
  useEffect(() => { onSelectionChangeRef.current = onSelectionChange }, [onSelectionChange])

  const applyThemeAndScale = useCallback((rendition: Rendition, currentTheme: ThemeMode, currentScale: number) => {
    const t = THEME_STYLES[currentTheme]
    rendition.themes.default({
      body: {
        background: `${t.bg} !important`,
        color: `${t.text} !important`,
        'font-family': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important',
        'line-height': '1.65 !important',
        padding: '24px 32px !important',
        margin: '0 auto !important',
      },
      'p, div, span, li, blockquote': {
        color: `${t.text} !important`,
        'font-size': 'inherit !important',
      },
      'h1, h2, h3, h4, h5, h6': {
        color: `${t.text} !important`,
        'margin-top': '1.4em !important',
        'margin-bottom': '0.6em !important',
      },
      a: {
        color: '#38bdf8 !important',
        'text-decoration': 'underline !important',
      },
      img: {
        'max-width': '100% !important',
        height: 'auto !important',
        margin: '12px auto !important',
        display: 'block !important',
      },
    })
    rendition.themes.fontSize(`${Math.round(currentScale * 105)}%`)
  }, [])

  // Inicializa o leitor EPUB
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setErrorMsg('')

    if (!url) {
      setStatus('error')
      setErrorMsg('URL do livro não disponível.')
      return
    }

    if (!containerRef.current) return

    // Limpa instância anterior
    if (renditionRef.current) {
      try { renditionRef.current.destroy() } catch {}
      renditionRef.current = null
    }
    if (bookRef.current) {
      try { bookRef.current.destroy() } catch {}
      bookRef.current = null
    }

    // Cria livro e rendition
    const book = ePub(url)
    bookRef.current = book

    const rendition = book.renderTo(containerRef.current, {
      width: '100%',
      height: '100%',
      spread: 'none',
      flow: 'paginated',
    })
    renditionRef.current = rendition

    applyThemeAndScale(rendition, theme, scale)

    // Renderiza
    rendition.display().then(() => {
      if (cancelled) return
      setStatus('ready')
    }).catch((err) => {
      if (cancelled) return
      console.error('[EpubViewer] Falha ao renderizar:', err)
      setStatus('error')
      setErrorMsg(err?.message || 'Erro ao carregar o livro .epub')
    })

    // Gera locais para cálculo preciso de progresso
    book.ready.then(() => {
      if (cancelled) return
      return book.locations.generate(1000)
    }).catch((err) => {
      console.warn('[EpubViewer] Locations warning:', err)
    })

    // Listener de mudança de posição / página
    rendition.on('relocated', (location: any) => {
      if (cancelled) return
      isNavigatingLocallyRef.current = true

      // Extrai texto da seção atual
      try {
        const contents = rendition.getContents() as any
        const doc = Array.isArray(contents) ? contents[0]?.document : contents?.document
        const text = doc?.body?.innerText || doc?.body?.textContent || ''
        if (text.trim()) {
          onTextExtractedRef.current?.(text.trim())
        }
      } catch (e) {
        console.warn('[EpubViewer] Falha na extração de texto:', e)
      }

      // Descobre título do capítulo atual se disponível
      try {
        const item = book.spine.get(location.start.href)
        if (item && item.idref) {
          const navItem = book.navigation?.get(location.start.href)
          if (navItem?.label) {
            setCurrentChapter(navItem.label.trim())
          }
        }
      } catch {}

      // Calcula número de página equivalente
      let targetPage = currentPageRef.current
      const spineLen = (book.spine as any)?.spineItems?.length || (book.spine as any)?.length || 0
      if (location.start?.percentage !== undefined && location.start.percentage !== null) {
        const pct = location.start.percentage
        targetPage = Math.max(1, Math.min(totalPages, Math.round(pct * totalPages) || 1))
      } else if (location.start?.index !== undefined && spineLen > 0) {
        targetPage = Math.max(1, Math.min(totalPages, Math.round(((location.start.index + 1) / spineLen) * totalPages)))
      }

      currentPageRef.current = targetPage
      onPageChangeRef.current(targetPage)

      setTimeout(() => {
        isNavigatingLocallyRef.current = false
      }, 100)
    })

    // Seleção de texto para grifos e Professor IA
    rendition.on('selected', (_cfiRange: string, contents: any) => {
      const win = contents?.window || window
      const sel = win.getSelection()
      const text = sel?.toString()?.trim()
      if (text && onSelectionChangeRef.current) {
        try {
          const range = sel.getRangeAt(0)
          const iframeEl = contents.document?.defaultView?.frameElement as HTMLIFrameElement | null
          const iframeRect = iframeEl?.getBoundingClientRect() || { top: 0, left: 0 }
          const rangeRect = range.getBoundingClientRect()

          onSelectionChangeRef.current({
            text,
            startIdx: 0,
            endIdx: text.length,
            rect: {
              top: rangeRect.top + iframeRect.top,
              left: rangeRect.left + iframeRect.left,
              right: rangeRect.right + iframeRect.left,
              bottom: rangeRect.bottom + iframeRect.top,
            },
          })
        } catch (e) {
          console.warn('[EpubViewer] selection rect error:', e)
        }
      }
    })

    rendition.on('click', () => {
      onSelectionChangeRef.current?.(null)
    })

    return () => {
      cancelled = true
      try { rendition.destroy() } catch {}
      try { book.destroy() } catch {}
      renditionRef.current = null
      bookRef.current = null
    }
  }, [url, totalPages])

  // Atualiza tema e escala quando alterados
  useEffect(() => {
    if (renditionRef.current && status === 'ready') {
      applyThemeAndScale(renditionRef.current, theme, scale)
    }
  }, [theme, scale, status, applyThemeAndScale])

  // Reage a mudanças externas de página (ex: slider, input, sumário)
  useEffect(() => {
    if (isNavigatingLocallyRef.current) return
    if (page === currentPageRef.current) return
    if (!bookRef.current || !renditionRef.current || status !== 'ready') return

    currentPageRef.current = page
    const book = bookRef.current
    const rendition = renditionRef.current

    try {
      if (book.locations && book.locations.length() > 0) {
        const pct = Math.max(0, Math.min(1, (page - 1) / Math.max(1, totalPages - 1)))
        const cfi = book.locations.cfiFromPercentage(pct)
        if (cfi) {
          rendition.display(cfi)
          return
        }
      }

      // Fallback para espinha de capítulos
      const spineLen = (book.spine as any)?.spineItems?.length || (book.spine as any)?.length || 0
      if (spineLen > 0) {
        const spineIdx = Math.min(spineLen - 1, Math.floor(((page - 1) / Math.max(1, totalPages)) * spineLen))
        const item = book.spine.get(spineIdx)
        if (item) rendition.display(item.href)
      }
    } catch (e) {
      console.warn('[EpubViewer] page jump error:', e)
    }
  }, [page, totalPages, status])

  // Navegação por teclado
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowLeft') {
        renditionRef.current?.prev()
      } else if (e.key === 'ArrowRight') {
        renditionRef.current?.next()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handlePrev = () => renditionRef.current?.prev()
  const handleNext = () => renditionRef.current?.next()

  const handleThemeChange = (newTheme: ThemeMode) => {
    setTheme(newTheme)
    try { localStorage.setItem('leitor-ia:epub-theme', newTheme) } catch {}
  }

  const currentThemeStyle = THEME_STYLES[theme]

  return (
    <div
      className="epub-viewer-wrapper"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: '100%',
        maxWidth: 880,
        margin: '0 auto',
        boxSizing: 'border-box',
      }}
    >
      {/* Barra de Controles Específicos do EPUB (Tema + Capítulo) */}
      <div
        className="epub-sub-bar"
        style={{
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 14px',
          marginBottom: 8,
          background: 'rgba(24, 24, 27, 0.65)',
          backdropFilter: 'blur(8px)',
          borderRadius: 12,
          border: '1px solid rgba(255, 255, 255, 0.08)',
          fontSize: 13,
          color: '#e4e4e7',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <BookOpen size={15} style={{ color: '#d4af37', flexShrink: 0 }} />
          <span style={{ fontWeight: 500, opacity: 0.9 }}>
            {currentChapter || `Modo Livro Digital (EPUB)`}
          </span>
        </div>

        {/* Seletor de Tema (Dark, Sépia, Claro) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            onClick={() => handleThemeChange('dark')}
            title="Tema Escuro"
            style={{
              padding: '4px 8px',
              borderRadius: 6,
              border: theme === 'dark' ? '1px solid #d4af37' : '1px solid transparent',
              background: '#18181b',
              color: '#f4f4f5',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            <Moon size={12} /> Escuro
          </button>
          <button
            type="button"
            onClick={() => handleThemeChange('sepia')}
            title="Tema Sépia Confortável"
            style={{
              padding: '4px 8px',
              borderRadius: 6,
              border: theme === 'sepia' ? '1px solid #d4af37' : '1px solid transparent',
              background: '#fbf0d9',
              color: '#3b2f1e',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            <Type size={12} /> Sépia
          </button>
          <button
            type="button"
            onClick={() => handleThemeChange('light')}
            title="Tema Claro"
            style={{
              padding: '4px 8px',
              borderRadius: 6,
              border: theme === 'light' ? '1px solid #d4af37' : '1px solid transparent',
              background: '#ffffff',
              color: '#18181b',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            <Sun size={12} /> Claro
          </button>
        </div>
      </div>

      {/* Área Central de Leitura do EPUB */}
      <div
        className="epub-viewport-card"
        style={{
          position: 'relative',
          width: '100%',
          height: '75vh',
          minHeight: 580,
          maxHeight: 900,
          background: currentThemeStyle.bg,
          border: `1px solid ${currentThemeStyle.border}`,
          borderRadius: 16,
          boxShadow: '0 12px 36px rgba(0,0,0,0.35)',
          overflow: 'hidden',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        {status === 'loading' && (
          <div style={{ color: currentThemeStyle.muted, textAlign: 'center', padding: 24 }}>
            <div style={{ marginBottom: 12, fontSize: 18, fontWeight: 600, color: currentThemeStyle.text }}>
              Formatando EPUB para leitura fluida…
            </div>
            <div style={{ fontSize: 13, opacity: 0.8 }}>Otimizando fontes, paginação e IA integrada</div>
          </div>
        )}

        {status === 'error' && (
          <div style={{ color: '#ef4444', textAlign: 'center', padding: 24 }}>
            <strong>Não foi possível renderizar o arquivo .epub.</strong>
            <div style={{ opacity: 0.8, marginTop: 8, fontSize: 13 }}>{errorMsg}</div>
          </div>
        )}

        {/* Container onde o epub.js renderiza o iframe */}
        <div
          ref={containerRef}
          style={{
            width: '100%',
            height: '100%',
            display: status === 'ready' ? 'block' : 'none',
          }}
        />

        {/* Botões laterais flutuantes de paginação */}
        {status === 'ready' && (
          <>
            <button
              type="button"
              onClick={handlePrev}
              aria-label="Página anterior"
              title="Página anterior (←)"
              style={{
                position: 'absolute',
                left: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: 'rgba(0, 0, 0, 0.45)',
                color: '#fff',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                backdropFilter: 'blur(4px)',
                transition: 'opacity 0.2s, transform 0.2s',
                opacity: 0.7,
                zIndex: 10,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = '1'
                e.currentTarget.style.transform = 'translateY(-50%) scale(1.08)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = '0.7'
                e.currentTarget.style.transform = 'translateY(-50%) scale(1)'
              }}
            >
              <ChevronLeft size={22} />
            </button>

            <button
              type="button"
              onClick={handleNext}
              aria-label="Próxima página"
              title="Próxima página (→)"
              style={{
                position: 'absolute',
                right: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: 'rgba(0, 0, 0, 0.45)',
                color: '#fff',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                backdropFilter: 'blur(4px)',
                transition: 'opacity 0.2s, transform 0.2s',
                opacity: 0.7,
                zIndex: 10,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = '1'
                e.currentTarget.style.transform = 'translateY(-50%) scale(1.08)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = '0.7'
                e.currentTarget.style.transform = 'translateY(-50%) scale(1)'
              }}
            >
              <ChevronRight size={22} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
