import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { ChevronLeft, ChevronRight, Mic, Pause, Play, Send, Sparkles, Target, Volume2, VolumeX, ZoomIn, ZoomOut, Code2 } from 'lucide-react'
import type { Book } from '../domain/types'
import type { ProgressState } from '../domain/library'
import { getProgress } from '../domain/progress'
import { PdfViewer } from '../components/PdfViewer'
import { ShareActions } from '../components/ShareActions'
import { QuizModal } from '../components/QuizModal'
import { QuizScoreBoard } from '../components/QuizScoreBoard'
import { ChecklistCapitulo } from '../components/ChecklistCapitulo'
import { SelectionToolbar, type SelectionInfo, type HighlightColor } from '../components/SelectionToolbar'
import { AnnotationModal, type Highlight } from '../components/AnnotationModal'
import type { RagSource } from '../domain/rag'
import { useAuth } from '../lib/AuthContext'
import { supabase } from '../lib/supabase'
import { useSpeechToggle } from '../lib/useSpeechToggle'
type ChatRole = 'user' | 'ai'

interface ChatMessage {
  id: string
  role: ChatRole
  text: string
  sources?: RagSource[]
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((event: unknown) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

function getSpeechRecognition(): SpeechRecognitionLike | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike; SpeechRecognition?: new () => SpeechRecognitionLike }
  return w.SpeechRecognition ? new w.SpeechRecognition() : w.webkitSpeechRecognition ? new w.webkitSpeechRecognition() : null
}

interface Props {
  book: Book
  progress: ProgressState
  onTrack: (book: Book, page: number) => void
  onOpenDev?: (bookId: string) => void
}

export function ReaderPage({ book, progress, onTrack, onOpenDev }: Props) {
  const { user } = useAuth()
  const userId = user.id
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const [pdfLoading, setPdfLoading] = useState(true)

  // Busca signed URL do Supabase Storage (TTL 60min) antes de renderizar
  useEffect(() => {
    let cancelled = false
    setPdfLoading(true)
    setPdfError(null)
    setPdfUrl(null)
    // Pega JWT do session atual pra autenticar no backend
    supabase.auth.getSession().then(({ data: sessionData }) => {
      if (cancelled) return
      const accessToken = sessionData.session?.access_token
      if (!accessToken) {
        setPdfError('Sessão inválida. Faça login.')
        setPdfLoading(false)
        return
      }
      return fetch(`${import.meta.env.BASE_URL}signed-url-api/sign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ slug: book.id }),
      })
    })
      .then((r) => (r ? r.json().then((j) => ({ status: r.status, body: j })) : null))
      .then((result) => {
        if (cancelled || !result) return
        const { status, body } = result
        if (status !== 200 || !body.url) {
          setPdfError(body?.error || `HTTP ${status}`)
        } else {
          setPdfUrl(body.url)
        }
        setPdfLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setPdfError(String(e))
        setPdfLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [book.id])

  const initial = useMemo(() => {
    const saved = getProgress(progress, userId, book.id)?.page ?? 1
    return Math.min(Math.max(1, saved), book.totalPages)
  }, [book, progress, userId])

  const [page, setPage] = useState(initial)
  // Sincroniza page com initial APENAS quando o livro muda (não a cada
  // mudança de progress, senão o onTrack sobrescreve a página atual
  // com a inicial salva).
  const lastBookIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (lastBookIdRef.current !== book.id) {
      lastBookIdRef.current = book.id
      setPage(initial)
    }
  }, [book.id, initial])

  const handlePageChange = (next: number) => {
    const clamped = Math.min(Math.max(1, next), book.totalPages)
    if (clamped !== page) {
      setPage(clamped)
      onTrack(book, clamped)
    }
  }

  // Wrapper para o input de página (linha 246-252): quando o user digita
  // um número e sai do campo, precisa chamar onTrack pra persistir.
  const handlePageInputBlur = useCallback(() => {
    onTrack(book, page)
  }, [book, page, onTrack])

  // Quando o PdfViewer terminar de renderizar a página inicial, NÃO
  // chama onPageChange (que salvaria p1 sobre p40 salva). Só sinaliza
  // que o render terminou. Se o user rolar para outra página dentro
  // do PDF, ele usa onInternalNav (futuro).
  const handleInternalNav = useCallback((next: number) => {
    // noop por enquanto — render programático do React já cuida do page
  }, [])

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'greet',
      role: 'ai',
      text: `Olá! Sou o Professor IA de "${book.title}". Pergunte qualquer coisa sobre a obra e eu respondo com base no conteúdo selecionado do livro.`,
    },
  ])
  // Zoom persistente — default 1.3 segue o valor antigo. Kindle-like.
  const [scale, setScale] = useState<number>(() => {
    if (typeof window === 'undefined') return 1.3
    const saved = parseFloat(localStorage.getItem('leitor-ia:pdf-scale') || '1.3')
    return Number.isFinite(saved) && saved >= 0.8 && saved <= 3 ? saved : 1.3
  })
  const saveScale = useCallback((next: number) => {
    setScale(next)
    try { localStorage.setItem('leitor-ia:pdf-scale', String(next)) } catch {}
  }, [])
  // Texto da página atual (extraído pelo PdfViewer via getTextContent).
  // Usado pelo TTS do PDF (Kindle-style).
  const [pageText, setPageText] = useState('')
  // TTS do PDF (independente do TTS das respostas do Professor).
  const [pdfTtsStatus, setPdfTtsStatus] = useState<'idle' | 'speaking'>('idle')
  // Para o TTS quando o user troca de página, pra não narrar a página errada
  useEffect(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try { window.speechSynthesis.cancel() } catch {}
    }
    setPdfTtsStatus('idle')
  }, [page])
  // Onboarding do Professor IA: mostra dicas só na 1ª vez que o user abre
  // um livro nesta máquina. Dismiss persiste em localStorage.
  const [showOnboarding, setShowOnboarding] = useState(() => {
    if (typeof window === 'undefined') return false
    try { return !localStorage.getItem('leitor-ia:onboarding-dismissed') } catch { return false }
  })
  const dismissOnboarding = () => {
    try { localStorage.setItem('leitor-ia:onboarding-dismissed', '1') } catch {}
    setShowOnboarding(false)
  }
  // Quando o user envia uma pergunta (chips ou input), onboarding some
  useEffect(() => {
    if (showOnboarding && messages.some((m) => m.id !== 'greet')) dismissOnboarding()
  }, [messages, showOnboarding])
  const [input, setInput] = useState('')
  const [listening, setListening] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [voiceSupported] = useState(() => getSpeechRecognition() !== null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  // modoMentor DEVE ser declarado ANTES de useSpeechToggle — senão cai em
  // TDZ (Temporal Dead Zone) do `const` e o React quebra com
  // "Cannot access 'modoMentor' before initialization". Bug pego via
  // F12 em 23/08/2026 03:18.
  const [modoMentor, setModoMentor] = useState(false)
  const [hasSkill, setHasSkill] = useState(false)
  // JWT do Supabase — passado pro ChecklistCapitulo fazer toggle UPSERT
  const [checklistJwt, setChecklistJwt] = useState('')
  // Highlights — Turno 2 (04/09/2026). Lista dos grifos da página atual,
  // hidratada via GET /highlights?book_slug=X&page=N quando page muda.
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  // Modo do AnnotationModal: null (fechado) | 'create' com draft | 'edit' com highlight existente
  const [annotationMode, setAnnotationMode] = useState<
    | { kind: 'edit'; highlight: Highlight }
    | { kind: 'create'; draft: { selected_text: string; color: HighlightColor; startIdx: number; endIdx: number; pageNumber: number } }
    | null
  >(null)
  const [highlightsJwt, setHighlightsJwt] = useState('')
  // Quiz de revisão por página — blindagem do chat + persistência de score.
  // pageText (extraído do PDF pelo PdfViewer) alimenta o LLM via /quiz/generate.
  const [quizOpen, setQuizOpen] = useState(false)
  // Incrementado após cada quiz salvo — faz o QuizScoreBoard refazer GET /score.
  const [scoreReloadKey, setScoreReloadKey] = useState(0)
  const speech = useSpeechToggle(modoMentor)

  // Checar se o livro atual tem skill de Mentor (Modo Autor) carregada.
  // Botão "💡 Modo Mentor" só aparece se hasSkill === true.
  useEffect(() => {
    let cancelled = false
    if (!book?.id) {
      setHasSkill(false)
      return
    }
    fetch(`/${book.id}/semantic-api/has-skill?bookSlug=${encodeURIComponent(book.id)}`)
      .then((r) => r.ok ? r.json() : { has_skill: false })
      .then((data) => { if (!cancelled) setHasSkill(Boolean(data.has_skill)) })
      .catch(() => { if (!cancelled) setHasSkill(false) })
    return () => { cancelled = true }
  }, [book?.id])

  // Pega JWT do Supabase pra passar pro ChecklistCapitulo.
  // Só busca quando o livro muda (mesma janela do fetch do signed-url).
  useEffect(() => {
    let cancelled = false
    setChecklistJwt('')
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      setChecklistJwt(data.session?.access_token || '')
    })
    return () => { cancelled = true }
  }, [book.id])

  // Reaproveita o mesmo JWT pros highlights (mesma sessão Supabase).
  useEffect(() => {
    setHighlightsJwt(checklistJwt)
  }, [checklistJwt])

  // Busca highlights da PÁGINA atual sempre que muda page/bookSlug.
  // Endpoint público nginx: /leitor-inteligente/highlights-api/highlights
  useEffect(() => {
    let cancelled = false
    // Limpa a lista pra não mostrar grifos da página antiga durante o fetch.
    setHighlights([])
    if (!highlightsJwt || !book.id) return
    const url = `/leitor-inteligente/highlights-api/highlights?book_slug=${encodeURIComponent(book.id)}&page=${page}`
    fetch(url, { headers: { Authorization: `Bearer ${highlightsJwt}` } })
      .then((r) => r.ok ? r.json() : { ok: false, items: [] })
      .then((data) => {
        if (cancelled) return
        const items = Array.isArray(data.items) ? data.items : []
        // Valida shape mínima — protege contra schema drift.
        setHighlights(items.filter((x: any) =>
          typeof x?.id === 'string' &&
          typeof x?.start_idx === 'number' &&
          typeof x?.end_idx === 'number' &&
          typeof x?.selected_text === 'string'
        ))
      })
      .catch(() => { if (!cancelled) setHighlights([]) })
    return () => { cancelled = true }
  }, [book.id, page, highlightsJwt])

  useEffect(() => () => {
    recognitionRef.current?.stop()
    recognitionRef.current = null
    // NÃO chama speech.stop() aqui — quando status vira 'speaking', o
    // objeto `speech` muda (useMemo no hook), o useEffect re-roda cleanup
    // e mata a fala que acabou de começar. O hook já tem cleanup próprio
    // no unmount via useEffect([], []).
  }, [speech])

  useEffect(() => {
    if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight
  }, [messages])

  const send = useCallback(async (raw: string) => {
    const text = raw.trim()
    if (!text || thinking) return
    const stamp = Date.now()
    setMessages((current) => [...current, { id: `u-${stamp}`, role: 'user', text }])
    setInput('')
    setThinking(true)
    try {
      // Roteia pra API semântica DEDICADA do livro (porta 9135 p/ Fabricante, 9131 p/ genérica)
      // URL montado: /<book.id>/semantic-api/semantic-ask (nginx roteia pra porta certa)
      const semanticUrl = `/${book.id}/semantic-api/semantic-ask`
      const response = await fetch(semanticUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text, currentPage: page, bookSlug: book.id, modo_mentor: modoMentor }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Falha ao consultar o livro')
      const aiMessage: ChatMessage = {
        id: `a-${stamp}`,
        role: 'ai',
        text: data.answer,
        sources: data.sources,
      }
      setMessages((current) => [...current, aiMessage])
      speech.speak(data.answer)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha na consulta'
      setMessages((current) => [...current, {
        id: `e-${stamp}`,
        role: 'ai',
        text: `Não consegui consultar o livro agora: ${message}`,
      }])
    } finally {
      setThinking(false)
    }
  }, [book.id, page, thinking, speech, modoMentor])

  const toggleListening = useCallback(() => {
    if (listening) {
      recognitionRef.current?.stop()
      recognitionRef.current = null
      setListening(false)
      return
    }
    const recognition = getSpeechRecognition()
    if (!recognition) return
    recognition.lang = 'pt-BR'
    recognition.continuous = false
    recognition.interimResults = false
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results[0] ?? []).map((item) => item.transcript).join(' ')
      if (transcript) send(transcript)
    }
    recognition.onerror = () => setListening(false)
    recognition.onend = () => setListening(false)
    recognition.start()
    recognitionRef.current = recognition
    setListening(true)
  }, [listening, send])

  // === Highlights + Notas — handlers ===
  // Backend: POST /leitor-inteligente/highlights-api/highlights
  //         PATCH /leitor-inteligente/highlights-api/highlights/{id}
  //         DELETE /leitor-inteligente/highlights-api/highlights/{id}
  const HIGHLIGHTS_API = '/leitor-inteligente/highlights-api/highlights'

  const createHighlight = useCallback(async (
    selectedText: string,
    startIdx: number,
    endIdx: number,
    color: HighlightColor,
    pageNumber: number,
  ): Promise<Highlight | null> => {
    if (!highlightsJwt) return null
    // 04/09/2026: sanitizar NUL/controles do PDF antes de enviar. Postgres
    // rejeita   e o backend sanitiza como defesa secundária.
    const safeText = selectedText.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    const res = await fetch(HIGHLIGHTS_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${highlightsJwt}`,
      },
      body: JSON.stringify({
        book_slug: book.id,
        page_number: pageNumber,
        start_idx: startIdx,
        end_idx: endIdx,
        selected_text: safeText,
        color,
      }),
    })
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}))
      throw new Error(errBody?.error || `HTTP ${res.status}`)
    }
    const data = await res.json()
    const newH: Highlight = {
      id: data.id,
      page_number: pageNumber,
      start_idx: startIdx,
      end_idx: endIdx,
      selected_text: selectedText,
      color,
      note_text: null,
    }
    // Atualização otimista — pinta imediatamente antes do refetch.
    setHighlights((prev) => [...prev, newH])
    return newH
  }, [highlightsJwt, book.id])

  const updateHighlight = useCallback(async (
    id: string,
    patch: { note_text?: string | null; color?: HighlightColor },
  ): Promise<Highlight | null> => {
    if (!highlightsJwt) return null
    const res = await fetch(`${HIGHLIGHTS_API}/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${highlightsJwt}`,
      },
      body: JSON.stringify(patch),
    })
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}))
      throw new Error(errBody?.error || `HTTP ${res.status}`)
    }
    const data = await res.json()
    const updated = data.updated as Highlight
    setHighlights((prev) => prev.map((h) => h.id === id ? { ...h, ...updated } : h))
    return updated
  }, [highlightsJwt])

  const deleteHighlight = useCallback(async (id: string): Promise<void> => {
    if (!highlightsJwt) return
    const res = await fetch(`${HIGHLIGHTS_API}/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${highlightsJwt}` },
    })
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}))
      throw new Error(errBody?.error || `HTTP ${res.status}`)
    }
    setHighlights((prev) => prev.filter((h) => h.id !== id))
  }, [highlightsJwt])

  // Handlers do SelectionToolbar — recebe a seleção que o PdfViewer detectou.
  const handlePickColor = useCallback(async (color: HighlightColor) => {
    if (!selection) return
    try {
      await createHighlight(selection.text, selection.startIdx, selection.endIdx, color, page)
      // Limpa seleção nativa pra não duplicar o feedback visual.
      window.getSelection()?.removeAllRanges()
      setSelection(null)
    } catch (e) {
      alert(`Falha ao grifar: ${e instanceof Error ? e.message : e}`)
    }
  }, [selection, createHighlight, page])

  const handleAnnotate = useCallback((color: HighlightColor) => {
    if (!selection) return
    setAnnotationMode({
      kind: 'create',
      draft: {
        selected_text: selection.text,
        color,
        startIdx: selection.startIdx,
        endIdx: selection.endIdx,
        pageNumber: page,
      },
    })
    window.getSelection()?.removeAllRanges()
    setSelection(null)
  }, [selection, page])

  // "🤖 Perguntar ao Professor IA" — pré-preenche o chat e manda direto.
  const handleAskProfessor = useCallback(() => {
    if (!selection) return
    const template = `Professor, me explique o que o autor quis dizer com este trecho: "${selection.text}"`
    // Limpa a seleção nativa antes de abrir o chat (evita o toolbar reaparecer).
    window.getSelection()?.removeAllRanges()
    setSelection(null)
    // setInput é local ao ProfessorChat — o send já chama com o texto.
    send(template)
  }, [selection, send])

  const handleHighlightClick = useCallback((h: Highlight) => {
    // Limpa seleção nativa pra não conflitar com o modal.
    window.getSelection()?.removeAllRanges()
    setSelection(null)
    setAnnotationMode({ kind: 'edit', highlight: h })
  }, [])

  // Save do modal — POST se for create, PATCH se for edit.
  const handleAnnotationSave = useCallback(async (
    note: string | null,
    color: HighlightColor,
  ) => {
    if (!annotationMode) return
    if (annotationMode.kind === 'edit') {
      await updateHighlight(annotationMode.highlight.id, { note_text: note, color })
      return
    }
    // create
    const { selected_text, startIdx, endIdx, pageNumber } = annotationMode.draft
    await createHighlight(selected_text, startIdx, endIdx, color, pageNumber)
  }, [annotationMode, createHighlight, updateHighlight])

  const handleAnnotationDelete = useCallback(async () => {
    if (!annotationMode || annotationMode.kind !== 'edit') return
    await deleteHighlight(annotationMode.highlight.id)
  }, [annotationMode, deleteHighlight])

  if (pdfLoading) {
    return (
      <section>
        <div className="section-title">
          <h2>{book.title}</h2>
          <small>{book.author}</small>
        </div>
        <div className="pdf-loading">
          <div className="spinner" />
          <p>Preparando o livro...</p>
        </div>
      </section>
    )
  }

  if (pdfError || !pdfUrl) {
    return (
      <section>
        <div className="section-title">
          <h2>{book.title}</h2>
          <small>{book.author}</small>
        </div>
        <div className="pdf-error">
          <p>Não consegui carregar o PDF: {pdfError ?? 'URL não gerada'}</p>
          <button className="btn-primary" onClick={() => window.location.reload()}>Tentar de novo</button>
        </div>
      </section>
    )
  }

  // % de progresso e estimativa de tempo restante (Kindle-style)
  // Assume 2 min por página (média Kindle) — ajustável por livro depois
  const percent = book.totalPages > 0
    ? Math.min(100, Math.round((page / book.totalPages) * 100))
    : 0
  const minutesPerPage = 2
  const remainingPages = Math.max(0, book.totalPages - page)
  const remainingMinutes = remainingPages * minutesPerPage
  const remainingLabel = remainingMinutes < 60
    ? `${remainingMinutes} min restantes`
    : `${Math.floor(remainingMinutes / 60)}h ${remainingMinutes % 60}min restantes`

  return (
    <section>
      <div className="section-title">
        <h2>{book.title}</h2>
        <small>{book.author}</small>
      </div>
      <div className="pdf-toolbar">
        {/* Fileira 1 — navegação de página (compacta em mobile) */}
        <div className="pdf-toolbar-row">
          <button className="icon-btn" onClick={() => handlePageChange(page - 1)} aria-label="Página anterior">
            <ChevronLeft size={18} />
          </button>
          <span className="page-label">Página</span>
          <input
            type="number"
            min={1}
            max={book.totalPages}
            value={page}
            onChange={(e) => setPage(Math.min(book.totalPages, Math.max(1, Number(e.target.value) || 1)))}
            onBlur={handlePageInputBlur}
          />
          <span className="page-label">de {book.totalPages}</span>
          <button className="icon-btn" onClick={() => handlePageChange(page + 1)} aria-label="Próxima página">
            <ChevronRight size={18} />
          </button>
          <span className="page-progress-meta" aria-label="Progresso de leitura">
            <strong>{percent}%</strong>
            <span className="page-progress-time">· {remainingLabel}</span>
          </span>
        </div>
        {/* Fileira 2 — ações: zoom, TTS, resumir (não conflita com navegação em mobile) */}
        <div className="pdf-toolbar-row pdf-toolbar-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={() => saveScale(Math.max(0.8, +(scale - 0.3).toFixed(1)))}
            disabled={scale <= 0.8}
            title="Diminuir zoom"
            aria-label="Diminuir zoom"
          >
            <ZoomOut size={16} />
          </button>
          <span className="zoom-label" aria-live="polite">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => saveScale(Math.min(3, +(scale + 0.3).toFixed(1)))}
            disabled={scale >= 3}
            title="Aumentar zoom"
            aria-label="Aumentar zoom"
          >
            <ZoomIn size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
                alert('Seu navegador não suporta leitura em voz alta.')
                return
              }
              if (pdfTtsStatus === 'speaking') {
                window.speechSynthesis.cancel()
                setPdfTtsStatus('idle')
                return
              }
              if (!pageText.trim()) {
                alert('Aguarde o PDF terminar de carregar (extraindo texto da página).')
                return
              }
              const utter = new SpeechSynthesisUtterance(pageText)
              utter.lang = 'pt-BR'
              utter.rate = 1.0
              utter.onend = () => setPdfTtsStatus('idle')
              utter.onerror = () => setPdfTtsStatus('idle')
              window.speechSynthesis.speak(utter)
              setPdfTtsStatus('speaking')
            }}
            disabled={!pageText.trim()}
            title={pdfTtsStatus === 'speaking' ? 'Parar leitura da página' : 'Ler esta página em voz alta'}
            aria-label={pdfTtsStatus === 'speaking' ? 'Parar leitura da página' : 'Ler esta página em voz alta'}
            style={pdfTtsStatus === 'speaking' ? { color: '#d4af37' } : undefined}
          >
            {pdfTtsStatus === 'speaking' ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button
            type="button"
            className="icon-btn pdf-toolbar-resumir"
            onClick={() => send(`Faça um resumo da página atual (página ${page}).`)}
            disabled={thinking}
            title="Manda a página atual pro Professor IA pedir um resumo"
            aria-label="Resumir página atual com o Professor IA"
          >
            <Sparkles size={16} />
            <span>Resumir página</span>
          </button>
          <button
            type="button"
            className="icon-btn pdf-toolbar-dev"
            onClick={() => onOpenDev?.(book.id)}
            title="Abrir a Sala Dev (playground de código + Mentor Dev)"
            aria-label="Abrir Sala Dev"
            // 23/08/2026: Sala Dev é exclusiva pra livros de programação.
            // Outros livros (gospel, autoajuda, etc) simplesmente não veem o botão.
            // A trava REAL fica no App.tsx (rota /dev/<slug>) — isso aqui é só
            // visual pra não confundir o usuário.
            hidden={book.categoria !== 'programacao'}
            style={book.categoria !== 'programacao' ? { display: 'none' } : undefined}
          >
            <Code2 size={16} />
            <span>Área Dev</span>
          </button>
        </div>
      </div>

      <div className="progress-bar-track" aria-hidden="true">
        <div
          className="progress-bar-fill"
          style={{ width: `${percent}%` }}
        />
      </div>

      <PdfViewer
        pdfPath={pdfUrl}
        page={page}
        onPageChange={handlePageChange}
        onInternalNav={handleInternalNav}
        scale={scale}
        onTextExtracted={setPageText}
        highlights={highlights}
        onSelectionChange={setSelection}
        onHighlightClick={handleHighlightClick}
      />

      {selection && (
        <SelectionToolbar
          selection={selection}
          onPickColor={handlePickColor}
          onAnnotate={handleAnnotate}
          onAskProfessor={handleAskProfessor}
          onDismiss={() => {
            window.getSelection()?.removeAllRanges()
            setSelection(null)
          }}
        />
      )}

      <AnnotationModal
        mode={annotationMode}
        onClose={() => setAnnotationMode(null)}
        onSave={handleAnnotationSave}
        onDelete={handleAnnotationDelete}
      />

      {showOnboarding && (
        <div
          className="professor-onboarding"
          style={{
            marginTop: 16,
            padding: '14px 16px',
            borderRadius: 12,
            background: 'linear-gradient(135deg, #2a2540, #3a3150)',
            border: '1px solid #d4af37',
            color: '#e8e0d0',
          }}
          role="region"
          aria-label="Dicas do Professor IA"
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
            <strong style={{ color: '#d4af37', fontFamily: 'Georgia, serif' }}>
              ✨ 3 coisas que você pode perguntar agora
            </strong>
            <button
              type="button"
              onClick={dismissOnboarding}
              style={{
                background: 'transparent',
                border: '1px solid #6b6280',
                color: '#e8e0d0',
                padding: '4px 10px',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              Depois
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary"
              style={{ fontSize: 14, padding: '8px 14px' }}
              onClick={() => send(`Resuma o capítulo que contém a página ${page}.`)}
            >
              📑 Resumir este capítulo
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ fontSize: 14, padding: '8px 14px' }}
              onClick={() => send(`Crie 3 perguntas de reflexão sobre o que a página ${page} ensina.`)}
            >
              🪞 3 perguntas pra refletir
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ fontSize: 14, padding: '8px 14px' }}
              onClick={() => send(`Quais são os termos difíceis desta página (${page}) e o que significam?`)}
            >
              🔤 Termos difíceis
            </button>
          </div>
        </div>
      )}

      <ProfessorChat
        book={book}
        messages={messages}
        input={input}
        setInput={setInput}
        send={send}
        thinking={thinking}
        listening={listening}
        voiceSupported={voiceSupported}
        toggleListening={toggleListening}
        speech={speech}
        chatScrollRef={chatScrollRef}
        page={page}
        modoMentor={modoMentor}
        setModoMentor={setModoMentor}
        hasSkill={hasSkill}
        pageText={pageText}
        onOpenQuiz={() => setQuizOpen(true)}
      />
      {/* Checklist desativado em 04/09 — Isaías pediu pra ocultar (poluia a leitura).
          Backend checklist_server (porta 9142) fica de pé pra reativação futura.
          Pra reativar: descomentar este bloco. */}
      {false && modoMentor && hasSkill && (
        <ChecklistCapitulo
          bookSlug={book.id}
          chapterId={`p${page}`}
          accessToken={checklistJwt}
        />
      )}
      <QuizScoreBoard
        bookId={book.id}
        bookTitle={book.title}
        reloadKey={scoreReloadKey}
      />
      <QuizModal
        open={quizOpen}
        onClose={() => setQuizOpen(false)}
        bookId={book.id}
        bookTitle={book.title}
        pageNumber={page}
        pageText={pageText}
        onScoreSaved={() => setScoreReloadKey((k) => k + 1)}
      />
    </section>
  )
}

interface ChatProps {
  book: Book
  messages: ChatMessage[]
  input: string
  setInput: (v: string) => void
  send: (v: string) => void | Promise<void>
  thinking: boolean
  listening: boolean
  voiceSupported: boolean
  toggleListening: () => void
  speech: {
    status: 'idle' | 'speaking'
    speak: (t: string) => void
    toggle: (t: string) => void
    stop: () => void
    isSupported: boolean
    debugInfo?: string
  }
  chatScrollRef: React.RefObject<HTMLDivElement | null>
  page: number  // passada pra os chips rápidos preencherem o número da página
  modoMentor: boolean
  setModoMentor: (v: boolean) => void
  hasSkill: boolean  // só mostra botão Modo Mentor se tiver skill gerada pro slug
  pageText: string  // texto extraído do PDF (alimenta o QuizModal)
  onOpenQuiz: () => void  // abre o QuizModal da página atual
}

function ProfessorChat({ book, messages, input, setInput, send, thinking, listening, voiceSupported, toggleListening, speech, chatScrollRef, page, modoMentor, setModoMentor, hasSkill, pageText, onOpenQuiz }: ChatProps) {
  return (
    <div className="professor-panel" style={{ marginTop: 20 }}>
      <div className="professor-header">
        <strong>Professor IA — {book.title}</strong>
        <span style={{ color: 'var(--muted)', fontSize: '0.85rem', marginLeft: 'auto' }}>
          Livro completo indexado · {book.totalPages} páginas · Pergunte por página, capítulo, assunto ou autor
        </span>
      </div>
      <div className="chat-window" ref={chatScrollRef}>
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            {m.text}
            {m.sources && m.sources.length > 0 && (
              <div className="source">
                {m.sources.map((s) => (
                  <span key={s.id} className="chip">{s.title} — p. {s.page}</span>
                ))}
              </div>
            )}
            {m.role === 'ai' && <ShareActions text={m.text} bookTitle={book.title} />}
          </div>
        ))}
        {thinking && <div className="bubble ai">Consultando o livro completo…</div>}
      </div>
      <div className="composer">
        {hasSkill && (
          <button
            type="button"
            data-testid="modo-mentor-toggle"
            className={`modo-mentor-toggle ${modoMentor ? 'is-on' : ''}`}
            onClick={() => setModoMentor(!modoMentor)}
            disabled={thinking}
            aria-pressed={modoMentor}
            aria-label={modoMentor ? 'Desligar Modo Mentor' : 'Ligar Modo Mentor'}
            title={modoMentor
              ? 'Modo Mentor ativo — o Professor IA responde em 1ª pessoa, raciocinando pelos frameworks do livro'
              : 'Ativar Modo Mentor — o Professor IA responde em 1ª pessoa como Mentor do livro'}
          >
            <span aria-hidden="true">💡</span>
            <span className="label">Modo Mentor</span>
          </button>
        )}
        <button
          type="button"
          className={`icon-btn ${listening ? 'is-on' : ''}`}
          onClick={toggleListening}
          disabled={!voiceSupported}
          aria-pressed={listening}
          aria-label="Usar microfone"
          title={voiceSupported ? 'Falar com o professor' : 'Reconhecimento de voz indisponível'}
        >
          <Mic size={18} />
        </button>
        <button
          type="button"
          className={`icon-btn ${speech.status === 'speaking' ? 'is-on is-speaking' : ''}`}
          onClick={() => {
            // Para qualquer fala em curso (cloud TTS ou nativo) antes de
            // decidir se vai tocar. O speech.stop() cuida dos dois caminhos.
            speech.stop()
            const lastAi = [...messages].reverse().find((m) => m.role === 'ai')
            if (!lastAi) return
            speech.toggle(lastAi.text)
          }}
          disabled={!speech.isSupported}
          aria-pressed={speech.status === 'speaking'}
          aria-label={speech.status === 'speaking' ? 'Parar narração' : 'Ouvir a última resposta'}
          title={speech.status === 'speaking' ? 'Parar narração' : 'Ouvir a última resposta'}
        >
          {speech.status === 'speaking' ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
      </div>
      {/* Chips rápidos SEMPRE visíveis — quick actions pro Professor IA. */}
      <div className="quick-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <button
          type="button"
          disabled={thinking}
          onClick={() => send(`Faça um resumo curto desta página (página ${page}).`)}
          title="Resumir a página que você está lendo"
          style={{
            padding: '8px 14px',
            fontSize: 13,
            fontWeight: 600,
            borderRadius: 999,
            background: 'linear-gradient(135deg, #2a2540, #3a3150)',
            color: '#e8e0d0',
            border: '1px solid #d4af37',
            cursor: thinking ? 'not-allowed' : 'pointer',
            opacity: thinking ? 0.5 : 1,
            transition: 'transform 0.15s, box-shadow 0.15s',
          }}
          onMouseEnter={(e) => { if (!thinking) e.currentTarget.style.transform = 'translateY(-1px)' }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)' }}
        >
          📄 Resumir esta página
        </button>
        <button
          type="button"
          disabled={thinking}
          onClick={() => send(`Quais são os 3 conceitos mais importantes da página ${page}?`)}
          title="Pega a essência da página atual"
          style={{
            padding: '8px 14px',
            fontSize: 13,
            fontWeight: 600,
            borderRadius: 999,
            background: 'linear-gradient(135deg, #2a2540, #3a3150)',
            color: '#e8e0d0',
            border: '1px solid #d4af37',
            cursor: thinking ? 'not-allowed' : 'pointer',
            opacity: thinking ? 0.5 : 1,
            transition: 'transform 0.15s, box-shadow 0.15s',
          }}
          onMouseEnter={(e) => { if (!thinking) e.currentTarget.style.transform = 'translateY(-1px)' }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)' }}
        >
          🧠 Conceitos-chave
        </button>
        <button
          type="button"
          disabled={thinking}
          onClick={() => send(`Me dê um exemplo prático do que a página ${page} ensina.`)}
          title="Traduz a teoria em caso real"
          style={{
            padding: '8px 14px',
            fontSize: 13,
            fontWeight: 600,
            borderRadius: 999,
            background: 'linear-gradient(135deg, #2a2540, #3a3150)',
            color: '#e8e0d0',
            border: '1px solid #d4af37',
            cursor: thinking ? 'not-allowed' : 'pointer',
            opacity: thinking ? 0.5 : 1,
            transition: 'transform 0.15s, box-shadow 0.15s',
          }}
          onMouseEnter={(e) => { if (!thinking) e.currentTarget.style.transform = 'translateY(-1px)' }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)' }}
        >
          💬 Exemplo prático
        </button>
        <button
          type="button"
          disabled={thinking}
          onClick={() => send(`Crie 3 exercícios práticos sobre o conteúdo da página ${page}, com enunciado claro e nível progressivo (do mais fácil ao mais difícil).`)}
          title="Gera 3 exercícios com nível progressivo pra você treinar"
          style={{
            padding: '8px 14px',
            fontSize: 13,
            fontWeight: 600,
            borderRadius: 999,
            background: 'linear-gradient(135deg, #2a2540, #3a3150)',
            color: '#e8e0d0',
            border: '1px solid #d4af37',
            cursor: thinking ? 'not-allowed' : 'pointer',
            opacity: thinking ? 0.5 : 1,
            transition: 'transform 0.15s, box-shadow 0.15s',
          }}
          onMouseEnter={(e) => { if (!thinking) e.currentTarget.style.transform = 'translateY(-1px)' }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)' }}
        >
          🎯 3 exercícios práticos
        </button>
        <button
          type="button"
          disabled={thinking || !pageText.trim()}
          onClick={onOpenQuiz}
          title="Gera 3 perguntas didáticas (+10 acerto / -5 erro) sobre a página atual"
          data-testid="quiz-page-btn"
          style={{
            padding: '8px 14px',
            fontSize: 13,
            fontWeight: 600,
            borderRadius: 999,
            background: 'linear-gradient(135deg, #2a2540, #3a3150)',
            color: '#e8e0d0',
            border: '1px solid #d4af37',
            cursor: thinking || !pageText.trim() ? 'not-allowed' : 'pointer',
            opacity: thinking || !pageText.trim() ? 0.5 : 1,
            transition: 'transform 0.15s, box-shadow 0.15s',
          }}
          onMouseEnter={(e) => { if (!thinking && pageText.trim()) e.currentTarget.style.transform = 'translateY(-1px)' }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)' }}
        >
          <Target size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Quiz da Página
        </button>
      </div>
      {speech.debugInfo && (
        <div className="tts-debug" data-tts-debug title="Debug TTS — usado pra diagnóstico via chrome://inspect">
          🔍 {speech.debugInfo}
        </div>
      )}
    </div>
  )
}
