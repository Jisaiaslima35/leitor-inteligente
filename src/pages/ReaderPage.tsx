import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { ChevronLeft, ChevronRight, Mic, Send, Volume2 } from 'lucide-react'
import type { Book } from '../domain/types'
import type { ProgressState } from '../domain/library'
import { getProgress } from '../domain/progress'
import { PdfViewer } from '../components/PdfViewer'
import { ShareActions } from '../components/ShareActions'
import type { RagSource } from '../domain/rag'
import { useAuth } from '../lib/AuthContext'
import { supabase } from '../lib/supabase'
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

function speak(text: string) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window) || !text) return
  window.speechSynthesis.cancel()
  const utter = new SpeechSynthesisUtterance(text)
  utter.lang = 'pt-BR'
  utter.rate = 1
  window.speechSynthesis.speak(utter)
}

interface Props {
  book: Book
  progress: ProgressState
  onTrack: (book: Book, page: number) => void
}

export function ReaderPage({ book, progress, onTrack }: Props) {
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
  const [input, setInput] = useState('')
  const [listening, setListening] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [voiceSupported] = useState(() => getSpeechRecognition() !== null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => () => {
    recognitionRef.current?.stop()
    recognitionRef.current = null
    if (typeof window !== 'undefined') window.speechSynthesis.cancel()
  }, [])

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
        body: JSON.stringify({ question: text, currentPage: page, bookSlug: book.id }),
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
      speak(data.answer)
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
  }, [book.id, page, thinking])

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
        scale={1.3}
      />

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
        speak={speak}
        chatScrollRef={chatScrollRef}
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
  speak: (t: string) => void
  chatScrollRef: React.RefObject<HTMLDivElement | null>
}

function ProfessorChat({ book, messages, input, setInput, send, thinking, listening, voiceSupported, toggleListening, speak, chatScrollRef }: ChatProps) {
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
        <input
          type="text"
          value={input}
          disabled={thinking}
          placeholder={voiceSupported ? 'Pergunte algo ou use o microfone…' : 'Digite sua pergunta — reconhecimento de voz indisponível neste navegador'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(input) }}
          aria-label="Pergunta para o professor"
        />
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
          className="icon-btn"
          onClick={() => speak(messages[messages.length - 1]?.text ?? '')}
          aria-label="Ouvir a última resposta"
        >
          <Volume2 size={18} />
        </button>
        <button type="button" className="btn btn-primary" disabled={thinking} onClick={() => send(input)}>
          <Send size={16} /> {thinking ? 'Pensando…' : 'Enviar'}
        </button>
      </div>
    </div>
  )
}
