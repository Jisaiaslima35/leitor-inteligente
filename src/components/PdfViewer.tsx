import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import { TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { COLOR_BG, type HighlightColor, type SelectionInfo } from './SelectionToolbar'
import type { Highlight } from './AnnotationModal'

pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}assets/${workerUrl.split('/').pop()}`

interface Props {
  pdfPath: string
  page: number
  onPageChange: (page: number) => void
  onInternalNav?: (page: number) => void
  scale?: number
  onTextExtracted?: (text: string) => void
  // 04/09/2026 Turno 2: highlights da página atual + callbacks de seleção/grifo.
  highlights?: Highlight[]
  onSelectionChange?: (info: SelectionInfo | null) => void
  onHighlightClick?: (h: Highlight) => void
}

// PdfViewer agora também:
// - Pinta spans do textLayer com cor dos grifos salvos
// - Faz click em grifo existente → emite onHighlightClick (abre modal de nota)
// - Captura mouseup/touchend no textLayer → calcula selection rect + start/end idx
//   a partir dos spans data-idx → emite onSelectionChange
export function PdfViewer({ pdfPath, page, onPageChange, onInternalNav, scale = 1.2, onTextExtracted, highlights = [], onSelectionChange, onHighlightClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState<string>('')

  // Refs pra callbacks — evita re-bind do listener a cada render do parent.
  const onSelectionChangeRef = useRef(onSelectionChange)
  const onHighlightClickRef = useRef(onHighlightClick)
  useEffect(() => { onSelectionChangeRef.current = onSelectionChange }, [onSelectionChange])
  useEffect(() => { onHighlightClickRef.current = onHighlightClick }, [onHighlightClick])

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    pdfjs
      .getDocument({ url: pdfPath, disableStream: true, disableAutoFetch: true })
      .promise.then((doc) => {
        if (cancelled) return
        docRef.current = doc
        setStatus('ready')
      })
      .catch((err: Error) => {
        if (cancelled) return
        setStatus('error')
        setErrorMsg(err.message || 'Falha ao carregar PDF')
      })
    return () => {
      cancelled = true
      docRef.current = null
    }
  }, [pdfPath])

  // Guardamos o callback onInternalNav num ref pra que ele não seja
  // dependência do useEffect de render.
  const onInternalNavRef = useRef(onInternalNav)
  useEffect(() => {
    onInternalNavRef.current = onInternalNav
  }, [onInternalNav])

  useEffect(() => {
    let cancelled = false
    async function render() {
      if (!canvasRef.current || !docRef.current) return
      const target = Math.min(Math.max(1, page), docRef.current.numPages)
      const pageObj = await docRef.current.getPage(target)
      const viewport = pageObj.getViewport({ scale })
      const canvas = canvasRef.current
      const context = canvas.getContext('2d')
      if (!context) return
      canvas.width = viewport.width
      canvas.height = viewport.height
      renderTaskRef.current?.cancel()
      const task = pageObj.render({ canvas, canvasContext: context, viewport })
      renderTaskRef.current = task
      await task.promise
      if (cancelled) return
      // Sinaliza navegação interna (page-by-page via scroll do PDF, futuro)
      const navCb = onInternalNavRef.current
      if (navCb) navCb(target)
      // Renderiza textLayer por cima do canvas — cada span recebe data-idx.
      let textContent: any = null
      try {
        textContent = await pageObj.getTextContent()
        if (textLayerRef.current) {
          textLayerRef.current.innerHTML = ''
          textLayerRef.current.style.width = `${viewport.width}px`
          textLayerRef.current.style.height = `${viewport.height}px`
          const tl = new TextLayer({
            textContentSource: textContent,
            container: textLayerRef.current,
            viewport,
          })
          await tl.render()
          // ⚠️ pdfjs v6+: TextLayer NÃO adiciona data-idx nos spans automaticamente
          // (regressão do que existia até v4). Adicionamos manualmente usando
          // o getter público tl.textDivs — preserva a ordem do textContent.
          tl.textDivs.forEach((span, idx) => {
            if (span && !span.hasAttribute('data-idx')) {
              span.setAttribute('data-idx', String(idx))
            }
          })
          // Pinta os grifos da página após o textLayer estar montado.
          applyHighlightsToTextLayer(textLayerRef.current, highlights, onHighlightClickRef)
          // Ativa listener de seleção só DEPOIS do textLayer existir.
          attachSelectionListener(textLayerRef.current, onSelectionChangeRef)
        }
      } catch (e) {
        console.warn('Falha ao renderizar textLayer (página pode ser só imagem)', e)
      }
      // Extrai texto da página renderizada pra TTS.
      if (onTextExtracted && textContent) {
        try {
          const text = textContent.items
            .map((item: any) => ('str' in item ? item.str : ''))
            .filter(Boolean)
            .join(' ')
          if (!cancelled) onTextExtracted(text)
        } catch (e) {
          console.warn('Falha ao extrair texto da página', e)
        }
      }
    }
    if (status === 'ready') {
      render().catch((err) => console.error('Render error', err))
    }
    return () => {
      cancelled = true
    }
  }, [page, scale, status, onTextExtracted, highlights])

  if (status === 'loading') {
    return <div className="pdf-canvas-wrap" style={{ color: 'white', textAlign: 'center', padding: 24 }}>Carregando PDF…</div>
  }
  if (status === 'error') {
    return (
      <div className="pdf-canvas-wrap" style={{ color: 'white', textAlign: 'center', padding: 24 }}>
        <strong>Não consegui abrir o PDF.</strong>
        <div style={{ opacity: 0.7, marginTop: 8 }}>{errorMsg}</div>
      </div>
    )
  }
  return (
    <div
      className="pdf-canvas-wrap"
      style={{ position: 'relative', display: 'inline-block' }}
    >
      <canvas ref={canvasRef} aria-label={`Página ${page}`} />
      <div
        ref={textLayerRef}
        className="textLayer"
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          opacity: 0.999,
          lineHeight: 1,
          userSelect: 'text',
          WebkitUserSelect: 'text',
        }}
      />
    </div>
  )
}

// Pinta spans do textLayer cuja posição cai em [start_idx, end_idx).
// Adiciona click handler pra abrir o grifo (nota existente).
function applyHighlightsToTextLayer(
  container: HTMLElement,
  highlights: Highlight[],
  onHighlightClickRef: React.MutableRefObject<((h: Highlight) => void) | undefined>,
) {
  const spans = container.querySelectorAll<HTMLElement>('span[data-idx]')
  if (!highlights.length) return
  // Mapa idx → primeiro Highlight que cobre aquele span (em caso de overlap,
  // fica o primeiro criado — bom o suficiente pro MVP).
  const lookup = new Map<number, Highlight>()
  for (const h of highlights) {
    for (let i = h.start_idx; i < h.end_idx; i++) lookup.set(i, h)
  }
  spans.forEach((span) => {
    const idxStr = span.getAttribute('data-idx')
    if (!idxStr) return
    const idx = Number(idxStr)
    const h = lookup.get(idx)
    if (h) {
      span.style.backgroundColor = COLOR_BG[h.color]
      span.style.borderRadius = '2px'
      span.style.cursor = 'pointer'
      span.style.boxShadow = `inset 0 -2px 0 rgba(0,0,0,0.18)`
      span.onclick = (e: MouseEvent) => {
        e.stopPropagation()
        onHighlightClickRef.current?.(h)
      }
    }
  })
}

// Listener de seleção (mouseup + touchend em document, com setTimeout pra mobile).
// Calcula selection rect + range de data-idx, normaliza via closest('[data-idx]').
//
// Por que document e não só o container:
// - Alguns browsers disparam mouseup no scroll container pai, não no span.
// - Mobile (touchend) tem comportamento ainda mais inconsistente.
// - setTimeout 0 garante que window.getSelection() já atualizou.
function attachSelectionListener(
  container: HTMLElement,
  onSelectionChangeRef: React.MutableRefObject<((info: SelectionInfo | null) => void) | undefined>,
) {
  const handler = (_ev: Event) => {
    // setTimeout 0: garante que o browser já consolidou a seleção nativa
    // antes de a gente ler window.getSelection().
    setTimeout(() => {
      const cb = onSelectionChangeRef.current
      if (!cb) return
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) {
        cb(null)
        return
      }
      const range = sel.getRangeAt(0)
      if (range.collapsed) {
        cb(null)
        return
      }
      // Seleção precisa estar dentro do textLayer (não no header, sidebar etc).
      if (!container.contains(range.commonAncestorContainer)) {
        cb(null)
        return
      }
      const text = sel.toString().trim()
      if (!text) {
        cb(null)
        return
      }
      const startSpan = findSpan(range.startContainer, range.startOffset)
      const endSpan = findSpan(range.endContainer, range.endOffset)
      if (!startSpan || !endSpan) {
        if (typeof window !== 'undefined' && (window as any).__PDFVIEWER_DEBUG) {
          console.warn('[PdfViewer] selection sem data-idx span', { startContainer: range.startContainer, endContainer: range.endContainer })
        }
        cb(null)
        return
      }
      const startIdx = Number(startSpan.getAttribute('data-idx'))
      // +1 porque o backend espera end EXCLUSIVO (CHECK: end_idx >= start_idx
      // e a iteração cobre i in [start_idx, end_idx)).
      const endIdx = Number(endSpan.getAttribute('data-idx')) + 1
      if (!Number.isFinite(startIdx) || !Number.isFinite(endIdx) || endIdx <= startIdx) {
        cb(null)
        return
      }
      const rect = range.getBoundingClientRect()
      if (typeof window !== 'undefined' && (window as any).__PDFVIEWER_DEBUG) {
        console.log('[PdfViewer] selection', { text, startIdx, endIdx, rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom } })
      }
      cb({
        text,
        startIdx,
        endIdx,
        rect: {
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
        },
      })
    }, 0)
  }
  // document-level — captura mouseup/touchend mesmo se o browser redirecionou
  // o evento pra outro elemento (scrollbar, parent div etc).
  document.addEventListener('mouseup', handler)
  document.addEventListener('touchend', handler)
}

// Encontra o span[data-idx] mais próximo que contém o ponto de início/fim do range.
function findSpan(node: Node, _offset: number): HTMLElement | null {
  if (!node) return null
  // Text node (nodeType 3): o pai direto deve ser o span data-idx
  if (node.nodeType === Node.TEXT_NODE) {
    return node.parentElement?.closest<HTMLElement>('span[data-idx]') ?? null
  }
  // Element node: pode ser o próprio span ou estar aninhado dentro de um
  const el = node as HTMLElement
  if (el.hasAttribute && el.hasAttribute('data-idx')) return el
  return el.closest<HTMLElement>('span[data-idx]') ?? null
}
