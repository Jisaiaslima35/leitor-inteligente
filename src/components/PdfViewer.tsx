import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}assets/${workerUrl.split('/').pop()}`

interface Props {
  pdfPath: string
  page: number
  onPageChange: (page: number) => void
  scale?: number
}

export function PdfViewer({ pdfPath, page, onPageChange, scale = 1.2 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState<string>('')

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
      if (!cancelled) onPageChange(target)
    }
    if (status === 'ready') {
      render().catch((err) => console.error('Render error', err))
    }
    return () => {
      cancelled = true
    }
  }, [page, scale, status, onPageChange])

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
    <div className="pdf-canvas-wrap">
      <canvas ref={canvasRef} aria-label={`Página ${page}`} />
    </div>
  )
}
