import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Mic, Send, Volume2, VolumeX, ArrowLeft } from 'lucide-react'
import type { Book } from '../domain/types'
import { answerQuestion, type RagSource } from '../domain/rag'
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
  const Cls = w.SpeechRecognition || w.webkitSpeechRecognition
  if (!Cls) return null
  return new Cls()
}

interface Props {
  book: Book
  onBackToReader: () => void
}

export function ProfessorPage({ book, onBackToReader }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'greet',
      role: 'ai',
      text: `Olá! Sou o Professor IA de "${book.title}". Pergunte qualquer coisa sobre a obra e eu respondo com base nos trechos selecionados do livro.`,
    },
  ])
  const [input, setInput] = useState('')
  const [listening, setListening] = useState(false)
  const [voiceSupported] = useState(() => getSpeechRecognition() !== null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const speech = useSpeechToggle()

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop()
      recognitionRef.current = null
      speech.stop()
    }
  }, [speech])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  const send = useCallback((rawText: string) => {
    const text = rawText.trim()
    if (!text) return
    const userMessage: ChatMessage = { id: `u-${Date.now()}`, role: 'user', text }
    const answer = answerQuestion(text, [...book.chunks])
    const aiMessage: ChatMessage = {
      id: `a-${Date.now()}`,
      role: 'ai',
      text: answer.answer,
      sources: answer.sources,
    }
    setMessages((current) => [...current, userMessage, aiMessage])
    // Auto-narra a resposta via hook (respeitando toggle/pause se o user já tiver pausado antes)
    speech.speak(answer.answer)
    setInput('')
  }, [book, speech])

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

  const placeholder = useMemo(() => voiceSupported
    ? 'Pergunte algo ou use o microfone…'
    : 'Digite sua pergunta — reconhecimento de voz indisponível neste navegador', [voiceSupported])

  return (
    <section>
      <div className="section-title">
        <h2>Professor IA — {book.title}</h2>
        <button className="btn btn-ghost" onClick={onBackToReader}>
          <ArrowLeft size={14} /> Voltar ao leitor
        </button>
      </div>
      <div className="professor-panel" style={{ maxWidth: 760, margin: '0 auto' }}>
        <div className="professor-header">
          <strong>Conversa</strong>
          <span style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
            Respostas baseadas em {book.chunks.length} trechos selecionados do livro.
          </span>
        </div>
        <div className="chat-window" ref={scrollRef}>
          {messages.map((message) => (
            <div key={message.id} className={`bubble ${message.role}`}>
              {message.text}
              {message.sources && message.sources.length > 0 && (
                <div className="source">
                  {message.sources.map((source) => (
                    <span key={source.id} className="chip">
                      {source.title} — p. {source.page}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="composer">
          <input
            type="text"
            value={input}
            placeholder={placeholder}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') send(input)
            }}
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
            className={`icon-btn ${speech.status === 'speaking' ? 'is-on is-speaking' : ''}`}
            onClick={() => {
              const lastAi = [...messages].reverse().find((m) => m.role === 'ai')
              if (!lastAi) return
              speech.toggle(lastAi.text)
            }}
            disabled={!speech.isSupported || !messages.some((m) => m.role === 'ai')}
            aria-pressed={speech.status === 'speaking'}
            aria-label={speech.status === 'speaking' ? 'Parar narração' : 'Ouvir a última resposta'}
            title={speech.status === 'speaking' ? 'Parar narração' : 'Ouvir a última resposta'}
          >
            {speech.status === 'speaking' ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => send(input)}>
            <Send size={16} /> Enviar
          </button>
        </div>
      </div>
    </section>
  )
}