import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import {
  Mic,
  MicOff,
  Sparkles,
  Crown,
  GraduationCap,
  Volume2,
  PhoneCall,
  PhoneOff,
  AlertCircle,
  BookOpen,
  Radio,
  Send,
  ChevronLeft,
  ChevronRight,
  Lock,
  Lightbulb,
  FileText,
  ArrowRight,
} from 'lucide-react'
import type { Book } from '../domain/types'
import { BASE_URL } from '../lib/baseUrl'

type VoiceState = 'IDLE' | 'CONNECTING' | 'LISTENING' | 'THINKING' | 'SPEAKING' | 'ERROR_MIC'

interface SpeechRecognitionResultLike {
  readonly length: number
  readonly isFinal?: boolean
  [index: number]: { readonly transcript: string }
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number
  readonly results: {
    readonly length: number
    [index: number]: SpeechRecognitionResultLike
  }
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

function getSpeechRecognition(): SpeechRecognitionLike | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
    SpeechRecognition?: new () => SpeechRecognitionLike
  }
  const Cls = w.SpeechRecognition || w.webkitSpeechRecognition
  if (!Cls) return null
  try {
    return new Cls()
  } catch {
    return null
  }
}

// 18/09/2026 v20: fallback mobile — MediaRecorder + VAD (RMS no AnalyserNode).
// Chrome desktop usa SpeechRecognition nativo (linha de cima); Firefox Mobile,
// Safari iOS, Android WebViews caem aqui.
function pickRecorderMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) {
      return m
    }
  }
  return ''
}

const VAD_THRESHOLD = 0.012 // RMS mínimo pra considerar voz ativa
const VAD_SILENCE_MS = 1500 // ms contínuos de silêncio → encerra gravação
const VAD_MAX_RECORDING_MS = 25000 // hard cap defensivo (Whisper aceita 30s)

interface Props {
  books: Book[]
  defaultBookId?: string
  onNavigate?: (route: any, bookId?: string) => void
  onBuy?: (book: Book) => void
}

interface TocItem {
  title: string
  page: number
}

function getStructuredToc(book: Book | null): TocItem[] {
  if (!book) return []

  if (Array.isArray(book.toc) && book.toc.length > 0) {
    const noise = [
      'rosto',
      'folha de rosto',
      'créditos',
      'dedicatória',
      'sumário',
      'abreviaturas',
      'notas',
      'agradecimentos',
      'fontes',
      'sobre o autor',
      'sobre a autora',
    ]

    const valid = book.toc
      .filter(([_, rawTitle]) => {
        if (!rawTitle) return false
        const clean = rawTitle.trim().toLowerCase()
        if (clean.length < 2) return false
        return !noise.some((n) => clean === n || clean.startsWith(n + ' ') || clean.endsWith(' ' + n))
      })
      .map(([_, rawTitle, page]) => ({
        title: rawTitle.trim(),
        page: typeof page === 'number' && page > 0 ? page : 1,
      }))

    if (valid.length >= 3) {
      return valid.slice(0, 5)
    }
  }

  // Fallback baseado no número total de páginas do livro
  const total = book.totalPages && book.totalPages > 10 ? book.totalPages : 50
  return [
    { title: '1. Introdução & Contextualização', page: 1 },
    { title: '2. Fundamentos e Regras Centrais', page: Math.max(2, Math.round(total * 0.18)) },
    { title: '3. Aplicações Práticas & Casos', page: Math.max(3, Math.round(total * 0.42)) },
    { title: '4. Superando Bloqueios & Desafios', page: Math.max(4, Math.round(total * 0.68)) },
    { title: '5. Conclusão & Roteiro de Ação', page: Math.max(5, Math.round(total * 0.88)) },
  ]
}

function getBookGoldenInsight(book: Book | null): { insight: string; question: string } {
  if (!book) {
    return {
      insight: 'A leitura focada transforma conhecimento teórico em poder prático de decisão.',
      question: 'Qual o principal conceito deste livro?',
    }
  }

  const slugOrTitle = `${book.id} ${book.title}`.toLowerCase()

  if (slugOrTitle.includes('habito') || slugOrTitle.includes('hábito')) {
    return {
      insight:
        'A regra de ouro da transformação: você não elimina um hábito ruim, você substitui a rotina mantendo a mesma deixa e recompensa.',
      question: 'Como aplicar a regra de ouro para mudar um hábito na prática?',
    }
  }

  if (slugOrTitle.includes('sonhos-lucidos') || slugOrTitle.includes('sonho') || slugOrTitle.includes('lúcido')) {
    return {
      insight:
        'O teste de realidade é o segredo: ao condicionar a mente a questionar o estado de vigília durante o dia, a lucidez desperta automaticamente no meio do sonho.',
      question: 'Como funciona o teste de realidade para despertar a consciência no sonho?',
    }
  }

  if (slugOrTitle.includes('autoconfianca') || slugOrTitle.includes('auto-estima')) {
    return {
      insight:
        'A autoconfiança é um músculo comportamental: pequenas vitórias diárias e postura decidida reprogramam a certeza interior antes de qualquer desafio.',
      question: 'Quais as melhores técnicas diárias para fortalecer a autoconfiança?',
    }
  }

  if (slugOrTitle.includes('batalha-espiritual') || slugOrTitle.includes('medo') || slugOrTitle.includes('ansiedade')) {
    return {
      insight:
        'A verdadeira vitória começa na renovação da mente: discernimento e vigilância constante desarmam a ansiedade e firmam o propósito.',
      question: 'Como vencer o medo e a ansiedade através do discernimento prático?',
    }
  }

  if (slugOrTitle.includes('lagrimas') || slugOrTitle.includes('lágrimas')) {
    return {
      insight:
        'A coragem de sentir a verdade e confrontar as próprias cicatrizes é o primeiro passo para resgatar laços genuínos e recomeçar.',
      question: 'Qual é a principal lição emocional transmitida pela narrativa deste livro?',
    }
  }

  if (book.description && book.description.length > 25 && !book.description.includes('Cadastrado pelo admin')) {
    return {
      insight: book.description.slice(0, 150) + (book.description.length > 150 ? '...' : ''),
      question: `Qual é a ideia central apresentada em "${book.title}"?`,
    }
  }

  return {
    insight: `Os princípios de "${book.title}" fornecem ferramentas essenciais para aprofundar seu conhecimento, acelerar o aprendizado e transformar seus resultados.`,
    question: `Poderia resumir em poucas palavras o conceito mais impactante de "${book.title}"?`,
  }
}

export function VoiceMentorSection({ books, defaultBookId, onNavigate }: Props) {
  // 1. Livro Selecionado
  const [selectedBookId, setSelectedBookId] = useState<string>(() => {
    if (defaultBookId && books.some((b) => b.id === defaultBookId)) return defaultBookId
    const pilot = books.find((b) => b.id.includes('habito') || b.title.toLowerCase().includes('hábito'))
    return pilot ? pilot.id : books[0]?.id || ''
  })

  useEffect(() => {
    if (!selectedBookId && books.length > 0) {
      const pilot = books.find((b) => b.id.includes('habito') || b.title.toLowerCase().includes('hábito'))
      setSelectedBookId(pilot ? pilot.id : books[0].id)
    }
  }, [books, selectedBookId])

  const selectedBook = useMemo(() => {
    return books.find((b) => b.id === selectedBookId) || books[0] || null
  }, [books, selectedBookId])

  // Lâmina ativa do Mini-Degustador (0: Capa, 1: TOC, 2: Insight, 3: Paywall)
  const [currentSlide, setCurrentSlide] = useState<number>(0)

  // 18/09/2026 v20: viewport mobile para layout responsivo (≤768px = coluna única)
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(max-width: 768px)').matches
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(max-width: 768px)')
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Ao trocar o livro, reseta para a Lâmina 1 (Capa)
  useEffect(() => {
    setCurrentSlide(0)
  }, [selectedBookId])

  const tocItems = useMemo(() => getStructuredToc(selectedBook), [selectedBook])
  const goldenData = useMemo(() => getBookGoldenInsight(selectedBook), [selectedBook])

  // 2. Estados de UI
  const [voiceState, setVoiceState] = useState<VoiceState>('IDLE')
  const [transcript, setTranscript] = useState<string>('')
  const [lastAgentMessage, setLastAgentMessage] = useState<string>('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [textInput, setTextInput] = useState<string>('')

  // 3. Refs de Controle Rigoroso de Concorrência & Half-Duplex
  const voiceStateRef = useRef<VoiceState>('IDLE')
  voiceStateRef.current = voiceState

  // Singleton Audio Player
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null)
  const activeBlobUrlRef = useRef<string | null>(null)
  const playbackSeqRef = useRef<number>(0)

  // Singleton MediaStream & Recognition
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const currentVoiceIdRef = useRef<string>('Portuguese_Deep-VoicedGentleman')

  // 18/09/2026 v20: refs do fallback MediaRecorder + VAD (mobile-friendly).
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaChunksRef = useRef<Blob[]>([])
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const vadRafRef = useRef<number | null>(null)
  const isRecordingFallbackRef = useRef<boolean>(false)
  const silenceStartedAtRef = useRef<number | null>(null)
  const recordingStartedAtRef = useRef<number | null>(null)

  // Refs estáveis para quebrar circular dep entre useCallbacks (start↔transcribe).
  // Sincronizadas após cada render no useEffect mais abaixo.
  const stopFallbackRef = useRef<() => void>(() => {})
  const startFallbackRef = useRef<() => void>(() => {})
  const sendTranscribeRef = useRef<(blob: Blob, mimeType: string) => Promise<void>>(async () => {})

  const isMentor = Boolean(selectedBook?.modoMentorHabilitado)

  // Inicializa o elemento de áudio singleton uma única vez
  useEffect(() => {
    if (!audioPlayerRef.current && typeof Audio !== 'undefined') {
      const player = new Audio()
      player.preload = 'auto'
      audioPlayerRef.current = player
    }
  }, [])

  // Função para parar qualquer áudio ativo no singleton de forma garantida
  const stopAudioSingleton = useCallback(() => {
    playbackSeqRef.current += 1 // Invalida qualquer resposta in-flight
    const player = audioPlayerRef.current
    if (player) {
      player.onended = null
      player.onerror = null
      try {
        player.pause()
        player.currentTime = 0
        player.removeAttribute('src')
        player.load()
      } catch {
        // ignore
      }
    }
    if (activeBlobUrlRef.current) {
      try {
        URL.revokeObjectURL(activeBlobUrlRef.current)
      } catch {
        // ignore
      }
      activeBlobUrlRef.current = null
    }
  }, [])

  // Controle de Hardware do Microfone (Half-Duplex: Desativa tracks quando a IA fala)
  const setMicrophoneTracksEnabled = useCallback((enabled: boolean) => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = enabled
      })
    }
  }, [])

  // Para todo o pipeline e limpa microfone
  const terminateSession = useCallback(() => {
    stopAudioSingleton()

    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort()
      } catch {
        // ignore
      }
      recognitionRef.current = null
    }

    // 18/09/2026 v20: limpa fallback MediaRecorder + AudioContext
    if (isRecordingFallbackRef.current) {
      stopFallbackRef.current?.()
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop()
      } catch {
        // ignore
      }
    }
    mediaRecorderRef.current = null
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      try {
        audioCtxRef.current.close()
      } catch {
        // ignore
      }
    }
    audioCtxRef.current = null
    analyserRef.current = null
    mediaChunksRef.current = []

    if (mediaStreamRef.current) {
      try {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop())
      } catch {
        // ignore
      }
      mediaStreamRef.current = null
    }

    setVoiceState('IDLE')
    setTranscript('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopAudioSingleton])

  useEffect(() => {
    return () => {
      terminateSession()
    }
  }, [terminateSession])

  // Inicia ou retoma a escuta do microfone (Half-Duplex: só roda quando NÃO estiver falando)
  const resumeListening = useCallback(() => {
    if (voiceStateRef.current === 'IDLE') return

    // Reativa hardware do microfone
    setMicrophoneTracksEnabled(true)
    setVoiceState('LISTENING')

    const recognition = recognitionRef.current
    if (recognition) {
      try {
        recognition.start()
      } catch {
        // Pode já estar ativo ou reiniciando
      }
    } else {
      // 18/09/2026 v20: sem SpeechRecognition nativo → fallback MediaRecorder+VAD
      startFallbackRef.current?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setMicrophoneTracksEnabled])

  // Pausa a escuta do microfone enquanto a IA fala para evitar eco/feedback
  const pauseListeningForAgentSpeech = useCallback(() => {
    setMicrophoneTracksEnabled(false)

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch {
        // ignore
      }
    }

    // 18/09/2026 v20: para fallback MediaRecorder (half-duplex também aqui)
    if (isRecordingFallbackRef.current) {
      stopFallbackRef.current?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setMicrophoneTracksEnabled])

  // Reprodução de áudio via Singleton Player com trava de concorrência
  const playAgentAudio = useCallback(
    async (text: string, voiceId: string) => {
      if (!text || !text.trim()) {
        resumeListening()
        return
      }

      // 1. Para qualquer áudio anterior e gera novo token de sequência
      stopAudioSingleton()
      const mySeq = ++playbackSeqRef.current

      // 2. Trava o microfone para garantir Half-Duplex (evita a IA ouvir a si mesma)
      pauseListeningForAgentSpeech()
      setLastAgentMessage(text)
      setVoiceState('SPEAKING')

      try {
        const resp = await fetch(`${BASE_URL}tts-api/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice_id: voiceId }),
        })

        // Se uma nova ação/interrupção ocorreu enquanto o fetch rodava, descarta!
        if (mySeq !== playbackSeqRef.current) {
          return
        }

        if (!resp.ok) {
          throw new Error(`Erro TTS HTTP ${resp.status}`)
        }

        const blob = await resp.blob()
        if (mySeq !== playbackSeqRef.current) {
          return
        }

        const audioUrl = URL.createObjectURL(blob)
        activeBlobUrlRef.current = audioUrl

        const player = audioPlayerRef.current
        if (!player) {
          resumeListening()
          return
        }

        player.src = audioUrl

        player.onended = () => {
          if (mySeq === playbackSeqRef.current) {
            stopAudioSingleton()
            // Volta a escutar o usuário
            resumeListening()
          }
        }

        player.onerror = () => {
          if (mySeq === playbackSeqRef.current) {
            stopAudioSingleton()
            resumeListening()
          }
        }

        await player.play()
      } catch (err) {
        console.warn('[VoiceMentor] Erro ao reproduzir áudio:', err)
        if (mySeq === playbackSeqRef.current) {
          stopAudioSingleton()
          resumeListening()
        }
      }
    },
    [pauseListeningForAgentSpeech, resumeListening, stopAudioSingleton]
  )

  // Interrupção manual pelo usuário (Barge-in)
  const handleBargeIn = useCallback(() => {
    stopAudioSingleton()
    resumeListening()
  }, [resumeListening, stopAudioSingleton])

  // Envio de pergunta ao backend com controle de concorrência
  const sendUserQuery = useCallback(
    async (queryText: string) => {
      const clean = queryText.trim()
      if (!clean) return

      // Trava microfone imediatamente ao processar
      pauseListeningForAgentSpeech()
      setTranscript('')
      setVoiceState('THINKING')

      try {
        const resp = await fetch(`${BASE_URL}api/voice/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question: clean,
            ebook_id: selectedBook?.id,
            book_id: selectedBook?.id,
            slug: selectedBook?.id,
            modoMentor: isMentor,
          }),
        })

        if (!resp.ok) {
          throw new Error(`Erro API ${resp.status}`)
        }

        const data = await resp.json()
        const answer = data.answer || 'Qual aspecto prático deste livro você quer aplicar agora?'
        await playAgentAudio(answer, currentVoiceIdRef.current)
      } catch (err) {
        console.error('[VoiceMentor] Erro ao buscar resposta:', err)
        const fallbackMsg = isMentor
          ? 'Qual hábito você gostaria de mudar hoje a partir do livro?'
          : 'Fez sentido essa explicação sobre o capítulo?'
        await playAgentAudio(fallbackMsg, currentVoiceIdRef.current)
      }
    },
    [isMentor, pauseListeningForAgentSpeech, playAgentAudio, selectedBook?.id]
  )

  // Configuração e Inicialização do Microfone com AEC (Acoustic Echo Cancellation)
  // 18/09/2026 v20: fallback VAD (mobile). Cancela loop + zera timers.
  const cancelVADLoop = useCallback(() => {
    if (vadRafRef.current !== null) {
      cancelAnimationFrame(vadRafRef.current)
      vadRafRef.current = null
    }
    silenceStartedAtRef.current = null
    recordingStartedAtRef.current = null
  }, [])

  // 18/09/2026 v20: para gravação fallback (chamado quando IA fala ou encerra).
  const stopFallbackRecording = useCallback(() => {
    cancelVADLoop()
    const rec = mediaRecorderRef.current
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop()
      } catch {
        // ignore
      }
    }
    isRecordingFallbackRef.current = false
  }, [cancelVADLoop])

  // 18/09/2026 v20: envia Blob gravado para /api/voice/transcribe.
  const sendAudioForTranscription = useCallback(
    async (blob: Blob, mimeType: string) => {
      try {
        const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm'
        const form = new FormData()
        form.append('audio', blob, `recording.${ext}`)

        const resp = await fetch(`${BASE_URL}api/voice/transcribe`, {
          method: 'POST',
          body: form,
        })

        // Garantia half-duplex: se já saímos de LISTENING, descarta
        if (voiceStateRef.current !== 'LISTENING') return

        if (!resp.ok) {
          console.warn('[VoiceMentor fallback] transcribe HTTP', resp.status)
          const fallback = isMentor
            ? 'Não consegui te ouvir agora. Pode repetir sua pergunta?'
            : 'Não entendi o que você disse. Pode repetir, por favor?'
          await playAgentAudio(fallback, currentVoiceIdRef.current)
          return
        }

        const data: { text?: string; empty?: boolean } = await resp.json().catch(() => ({}))
        const text = (data?.text || '').trim()

        if (!text) {
          // Whisper não detectou fala utilizável — volta a escutar
          if (voiceStateRef.current === 'LISTENING') {
            startFallbackRef.current?.()
          }
          return
        }

        setTranscript(text)
        sendUserQuery(text)
      } catch (err) {
        console.error('[VoiceMentor fallback] transcribe falhou:', err)
        if (voiceStateRef.current !== 'LISTENING') return
        const fallback = isMentor
          ? 'Tive um problema técnico. Pode repetir?'
          : 'Houve um erro técnico. Pode perguntar de novo?'
        await playAgentAudio(fallback, currentVoiceIdRef.current)
      }
    },
    [isMentor, playAgentAudio, sendUserQuery]
  )

  // 18/09/2026 v20: inicia captura MediaRecorder + loop VAD (AnalyserNode RMS).
  const startFallbackRecording = useCallback(() => {
    if (isRecordingFallbackRef.current) return
    const stream = mediaStreamRef.current
    if (!stream) return

    const mimeType = pickRecorderMime()
    if (!mimeType) {
      setErrorMessage('Reconhecimento de fala não suportado neste navegador. Use o teclado.')
      return
    }

    // (Re)cria AudioContext + AnalyserNode na primeira vez (split do stream p/ VAD)
    let ctx = audioCtxRef.current
    if (!ctx) {
      try {
        type AudioContextCtor = new () => AudioContext
        const win = window as unknown as {
          AudioContext?: AudioContextCtor
          webkitAudioContext?: AudioContextCtor
        }
        const Ctor = win.AudioContext || win.webkitAudioContext
        if (Ctor) ctx = new Ctor()
        audioCtxRef.current = ctx ?? null
      } catch {
        // continua sem analyser (cai no hard cap)
      }
    }
    if (ctx && !analyserRef.current) {
      try {
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        source.connect(analyser)
        analyserRef.current = analyser
      } catch {
        // continua sem analyser
      }
    }

    // Configura MediaRecorder
    mediaChunksRef.current = []
    let rec: MediaRecorder
    try {
      rec = new MediaRecorder(stream, { mimeType })
    } catch (err) {
      console.warn('[VoiceMentor fallback] new MediaRecorder falhou:', err)
      setErrorMessage('Não foi possível iniciar a captura de áudio no dispositivo.')
      return
    }
    mediaRecorderRef.current = rec
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        mediaChunksRef.current.push(ev.data)
      }
    }
    rec.onstop = () => {
      cancelVADLoop()
      isRecordingFallbackRef.current = false
      if (mediaChunksRef.current.length === 0) return
      const blob = new Blob(mediaChunksRef.current, { type: mimeType })
      mediaChunksRef.current = []
      if (voiceStateRef.current === 'LISTENING') {
        sendTranscribeRef.current?.(blob, mimeType)
      }
    }
    rec.onerror = () => {
      cancelVADLoop()
      isRecordingFallbackRef.current = false
    }

    try {
      rec.start(250) // timeslice 250ms — chunks parciais, robustos
    } catch (err) {
      console.warn('[VoiceMentor fallback] recorder.start falhou:', err)
      return
    }
    isRecordingFallbackRef.current = true
    silenceStartedAtRef.current = null
    recordingStartedAtRef.current = Date.now()

    // Loop VAD via RAF (só se analyser existir)
    const analyser = analyserRef.current
    if (analyser) {
      const buf = new Float32Array(analyser.fftSize)
      const tick = () => {
        if (!isRecordingFallbackRef.current) return
        if (voiceStateRef.current !== 'LISTENING') {
          stopFallbackRecording()
          return
        }
        analyser.getFloatTimeDomainData(buf)
        let sumSquares = 0
        for (let i = 0; i < buf.length; i++) {
          sumSquares += buf[i] * buf[i]
        }
        const rms = Math.sqrt(sumSquares / buf.length)
        const now = Date.now()
        const startedAt = recordingStartedAtRef.current || now

        if (rms > VAD_THRESHOLD) {
          silenceStartedAtRef.current = null
        } else if (silenceStartedAtRef.current === null) {
          silenceStartedAtRef.current = now
        }

        const hardCap = now - startedAt > VAD_MAX_RECORDING_MS
        const silenceTimeout =
          silenceStartedAtRef.current !== null &&
          now - silenceStartedAtRef.current > VAD_SILENCE_MS &&
          now - startedAt > 500 // mínimo 500ms de captura p/ não cair em silêncio inicial

        if (hardCap || silenceTimeout) {
          stopFallbackRecording()
          return
        }
        vadRafRef.current = requestAnimationFrame(tick)
      }
      vadRafRef.current = requestAnimationFrame(tick)
    } else {
      // Sem analyser — usa apenas hard cap como saída
      const hardTimeout = window.setTimeout(() => {
        if (isRecordingFallbackRef.current) stopFallbackRecording()
      }, VAD_MAX_RECORDING_MS)
      const origOnStop = rec.onstop
      rec.onstop = (ev) => {
        window.clearTimeout(hardTimeout)
        if (origOnStop) (origOnStop as (e: Event) => void).call(rec, ev)
      }
    }
  }, [cancelVADLoop, sendAudioForTranscription, stopFallbackRecording])

  // 18/09/2026 v20: sincroniza refs estáveis após cada render — quebra ciclo
  // startFallbackRecording ↔ sendAudioForTranscription. Sem deps (roda sempre).
  useEffect(() => {
    stopFallbackRef.current = stopFallbackRecording
    startFallbackRef.current = startFallbackRecording
    sendTranscribeRef.current = sendAudioForTranscription
  })

  const setupMicrophoneAndRecognition = useCallback(async () => {
    try {
      // 1. Solicita permissão com cancelamento acústico de eco obrigatório
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
        mediaStreamRef.current = stream
      }
    } catch (err) {
      console.warn('[VoiceMentor] getUserMedia falhou ou bloqueado:', err)
      setVoiceState('ERROR_MIC')
      setErrorMessage('Microfone bloqueado. Libere a permissão no navegador.')
      return false
    }

    // 2. Inicializa STT (SpeechRecognition)
    const recognition = getSpeechRecognition()
    if (!recognition) {
      // 18/09/2026 v20: NÃO bloqueia — fallback MediaRecorder+VAD assume em LISTENING.
      // Apenas avisa se nem MediaRecorder existir (mobile muito antigo).
      if (typeof MediaRecorder === 'undefined' || !pickRecorderMime()) {
        setErrorMessage('Reconhecimento de fala não suportado neste navegador. Use o teclado.')
      }
      return true
    }

    try {
      recognition.lang = 'pt-BR'
      recognition.continuous = true
      recognition.interimResults = true

      recognition.onresult = (event) => {
        // TRAVA HALF-DUPLEX CRÍTICA: Se a IA estiver falando ou pensando, IGNORE qualquer captura!
        if (voiceStateRef.current !== 'LISTENING') {
          return
        }

        let interim = ''
        let final = ''

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const item = event.results[i]
          if (item && item[0]) {
            if (item.isFinal) {
              final += item[0].transcript + ' '
            } else {
              interim += item[0].transcript + ' '
            }
          }
        }

        const currentSpeech = (final || interim).trim()
        if (currentSpeech && voiceStateRef.current === 'LISTENING') {
          setTranscript(currentSpeech)
        }

        if (final.trim() && voiceStateRef.current === 'LISTENING') {
          sendUserQuery(final.trim())
        }
      }

      recognition.onerror = (e) => {
        if (e.error === 'not-allowed') {
          setVoiceState('ERROR_MIC')
          setErrorMessage('Permissão do microfone recusada.')
        }
      }

      recognition.onend = () => {
        // Só reinicia se a sessão ainda estiver em andamento e no estado LISTENING
        if (voiceStateRef.current === 'LISTENING' && recognitionRef.current) {
          try {
            recognition.start()
          } catch {
            // ignore
          }
        }
      }

      recognitionRef.current = recognition
      return true
    } catch (err) {
      console.warn('[VoiceMentor] Falha ao configurar STT:', err)
      return true
    }
  }, [sendUserQuery])

  // Início da Sessão Conversacional de Voz
  const startVoiceSession = useCallback(async () => {
    if (!selectedBook) return

    terminateSession()
    setErrorMessage(null)
    setVoiceState('CONNECTING')

    // Ativa microfone com AEC
    const micReady = await setupMicrophoneAndRecognition()
    if (!micReady) return

    try {
      const resp = await fetch(`${BASE_URL}api/voice/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ebook_id: selectedBook.id }),
      })

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ao inicializar sessão`)
      }

      const sessionData = await resp.json()
      currentVoiceIdRef.current = sessionData.voz_id || (isMentor ? 'Portuguese_Deep-VoicedGentleman' : 'female-shaonv')

      const hook =
        sessionData.hook_abertura ||
        (isMentor
          ? `Olá! Sou o Mentor de ${selectedBook.title}. Qual rotina você quer transformar hoje?`
          : `Olá! Sou o Professor IA de ${selectedBook.title}. Sobre qual capítulo você quer falar?`)

      // A IA fala primeiro enquanto o microfone permanece mutado
      await playAgentAudio(hook, currentVoiceIdRef.current)
    } catch (err) {
      console.warn('[VoiceMentor] Fallback de conexão:', err)
      const fallbackHook = isMentor
        ? `Olá! Sou o Mentor de ${selectedBook.title}. Qual hábito você quer debater hoje?`
        : `Olá! Sou o Professor IA de ${selectedBook.title}. Qual ponto quer explorar?`

      await playAgentAudio(fallbackHook, isMentor ? 'Portuguese_Deep-VoicedGentleman' : 'female-shaonv')
    }
  }, [isMentor, playAgentAudio, selectedBook, setupMicrophoneAndRecognition, terminateSession])

  const handleAskInsight = useCallback(
    (question: string) => {
      setTextInput(question)
      sendUserQuery(question)
    },
    [sendUserQuery]
  )

  const handleUnlockClick = useCallback(() => {
    if (onNavigate) {
      onNavigate('library')
    } else {
      window.location.hash = '#/library'
    }
  }, [onNavigate])

  if (!selectedBook) {
    return null
  }

  return (
    <div
      style={{
        marginTop: isMobile ? 24 : 50,
        marginBottom: isMobile ? 20 : 40,
        padding: isMobile ? '18px 14px' : '32px 28px',
        borderRadius: isMobile ? 18 : 24,
        background: 'linear-gradient(145deg, rgba(26, 38, 35, 0.96) 0%, rgba(15, 23, 21, 0.98) 100%)',
        boxShadow: '0 24px 48px -12px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
        border: isMentor ? '1px solid rgba(217, 119, 6, 0.35)' : '1px solid rgba(79, 70, 229, 0.35)',
        color: '#f7f4ed',
        position: 'relative',
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      {/* Luz ambiente de fundo */}
      <div
        style={{
          position: 'absolute',
          top: -80,
          right: -80,
          width: 240,
          height: 240,
          borderRadius: '50%',
          background: isMentor
            ? 'radial-gradient(circle, rgba(217, 119, 6, 0.15) 0%, transparent 70%)'
            : 'radial-gradient(circle, rgba(79, 70, 229, 0.15) 0%, transparent 70%)',
          filter: 'blur(30px)',
          pointerEvents: 'none',
        }}
      />

      {/* Topo: Header e Seletor de Livro */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: 16,
          marginBottom: 28,
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 20,
                fontSize: '0.75rem',
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                background: isMentor ? 'rgba(217, 119, 6, 0.2)' : 'rgba(79, 70, 229, 0.2)',
                color: isMentor ? '#fbbf24' : '#a5b4fc',
                border: isMentor ? '1px solid rgba(217, 119, 6, 0.35)' : '1px solid rgba(79, 70, 229, 0.35)',
              }}
            >
              {isMentor ? <Crown size={13} /> : <GraduationCap size={14} />}
              {isMentor ? 'Modo Mentor Ativo' : 'Modo Professor IA'}
            </span>
            <span style={{ fontSize: '0.8rem', color: '#9ca3af' }}>• Conversa por Voz em Tempo Real</span>
          </div>

          <h2 style={{ margin: 0, fontSize: '1.45rem', fontWeight: 800, color: '#ffffff' }}>
            {isMentor ? 'Debata e Evolua com o Mentor da Obra' : 'Tire Dúvidas com o Professor IA'}
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: '0.9rem', color: '#9ca3af', maxWidth: 580 }}>
            Selecione qualquer e-book do catálogo para conversar por áudio com baixa latência, respostas ágeis e sem eco.
          </p>
        </div>

        {/* Dropdown com Capas */}
        <div style={{ minWidth: 0, width: '100%', maxWidth: isMobile ? '100%' : 320 }}>
          <label
            htmlFor="voice-book-selector"
            style={{ display: 'block', fontSize: '0.78rem', color: '#9ca3af', marginBottom: 6, fontWeight: 600 }}
          >
            Escolher E-book para Conversar:
          </label>
          <div style={{ position: 'relative' }}>
            <select
              id="voice-book-selector"
              value={selectedBook.id}
              onChange={(e) => {
                const nextId = e.target.value
                terminateSession()
                setSelectedBookId(nextId)
                setCurrentSlide(0)
                setLastAgentMessage('')
                setTranscript('')
                setTextInput('')
                setErrorMessage(null)
              }}
              style={{
                width: '100%',
                padding: '10px 14px',
                paddingLeft: 38,
                borderRadius: 12,
                background: 'rgba(255, 255, 255, 0.08)',
                color: '#ffffff',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                fontSize: '0.9rem',
                fontWeight: 600,
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              {books.map((b) => (
                <option key={b.id} value={b.id} style={{ background: '#182421', color: '#fff' }}>
                  {b.modoMentorHabilitado ? '⭐ ' : '📖 '}
                  {b.title} {b.author ? `— ${b.author}` : ''}
                </option>
              ))}
            </select>
            <BookOpen
              size={16}
              style={{ position: 'absolute', left: 12, top: 12, color: '#9ca3af', pointerEvents: 'none' }}
            />
          </div>
        </div>
      </div>

      {/* Grid Principal: Mini-Degustador Interativo (Folheador) + Orbe de Voz */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : 'minmax(270px, 320px) 1fr',
          gap: isMobile ? 16 : 28,
          alignItems: 'stretch',
        }}
      >
        {/* Lado Esquerdo: Mini-Degustador de Amostra Interativo (4 Lâminas) */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            padding: isMobile ? '14px 12px' : '18px 16px',
            borderRadius: isMobile ? 16 : 20,
            background: 'rgba(0, 0, 0, 0.32)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            backdropFilter: 'blur(12px)',
            boxShadow: '0 16px 36px rgba(0, 0, 0, 0.28)',
            minHeight: isMobile ? 0 : 410,
            position: 'relative',
            overflow: 'hidden',
            width: '100%',
            maxWidth: isMobile ? 360 : 'none',
            margin: isMobile ? '0 auto' : 0,
            boxSizing: 'border-box',
          }}
        >
          {/* Topo do Card: Badge da Lâmina + Indicador */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 10,
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '3px 8px',
                borderRadius: 12,
                fontSize: '0.68rem',
                fontWeight: 700,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                background:
                  currentSlide === 3
                    ? 'rgba(245, 158, 11, 0.18)'
                    : currentSlide === 2
                    ? 'rgba(217, 119, 6, 0.18)'
                    : currentSlide === 1
                    ? 'rgba(99, 102, 241, 0.18)'
                    : 'rgba(16, 185, 129, 0.18)',
                color:
                  currentSlide === 3
                    ? '#fbbf24'
                    : currentSlide === 2
                    ? '#fde68a'
                    : currentSlide === 1
                    ? '#a5b4fc'
                    : '#6ee7b7',
                border:
                  currentSlide === 3
                    ? '1px solid rgba(245, 158, 11, 0.35)'
                    : currentSlide === 2
                    ? '1px solid rgba(217, 119, 6, 0.35)'
                    : currentSlide === 1
                    ? '1px solid rgba(99, 102, 241, 0.35)'
                    : '1px solid rgba(16, 185, 129, 0.35)',
              }}
            >
              {currentSlide === 0 && <Sparkles size={11} />}
              {currentSlide === 1 && <FileText size={11} />}
              {currentSlide === 2 && <Lightbulb size={11} />}
              {currentSlide === 3 && <Lock size={11} />}
              {currentSlide === 0 && 'Amostra Gratuita'}
              {currentSlide === 1 && 'Sumário da Obra'}
              {currentSlide === 2 && 'Insight de Ouro'}
              {currentSlide === 3 && 'Desbloqueio'}
            </span>

            <span style={{ fontSize: '0.70rem', color: '#9ca3af', fontWeight: 600 }}>
              Lâmina {currentSlide + 1} de 4
            </span>
          </div>

          {/* Área Principal de Renderização da Lâmina */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            {/* Lâmina 1: Capa & Ficha da Amostra */}
            {currentSlide === 0 && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  textAlign: 'center',
                }}
              >
                <div
                  style={{
                    position: 'relative',
                    width: 125,
                    aspectRatio: '3/4',
                    marginBottom: 10,
                    borderRadius: 8,
                    overflow: 'hidden',
                    boxShadow: '0 14px 28px rgba(0, 0, 0, 0.6)',
                    border: '1px solid rgba(255, 255, 255, 0.12)',
                  }}
                >
                  {selectedBook.cover ? (
                    <img
                      src={selectedBook.cover}
                      alt={selectedBook.title}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <div
                      style={{
                        width: '100%',
                        height: '100%',
                        background: '#233832',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#9ca3af',
                      }}
                    >
                      <BookOpen size={34} />
                    </div>
                  )}
                </div>

                <h3
                  style={{
                    margin: '0 0 3px',
                    fontSize: '0.98rem',
                    fontWeight: 700,
                    color: '#ffffff',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    maxWidth: 240,
                  }}
                >
                  {selectedBook.title}
                </h3>
                <p
                  style={{
                    margin: 0,
                    fontSize: '0.80rem',
                    color: '#9ca3af',
                    maxWidth: 220,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {selectedBook.author || 'Autor não informado'}
                </p>

                <div
                  style={{
                    marginTop: 8,
                    padding: '4px 10px',
                    borderRadius: 10,
                    fontSize: '0.72rem',
                    color: '#d1d5db',
                    background: 'rgba(255, 255, 255, 0.05)',
                    display: 'inline-flex',
                    gap: 6,
                    alignItems: 'center',
                  }}
                >
                  <span>{selectedBook.totalPages} páginas</span>
                  <span>•</span>
                  <span>{selectedBook.toc?.length || tocItems.length} seções</span>
                </div>
              </div>
            )}

            {/* Lâmina 2: Sumário Estruturado (TOC) */}
            {currentSlide === 1 && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  height: '100%',
                  padding: '12px 10px',
                  borderRadius: 12,
                  background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.04) 0%, rgba(255, 255, 255, 0.01) 100%)',
                  border: '1px solid rgba(255, 255, 255, 0.07)',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                    <FileText size={13} color="#a5b4fc" />
                    <span
                      style={{
                        fontSize: '0.74rem',
                        fontWeight: 700,
                        letterSpacing: '0.05em',
                        color: '#a5b4fc',
                        textTransform: 'uppercase',
                      }}
                    >
                      Estrutura da Obra
                    </span>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {tocItems.map((item, idx) => (
                      <div
                        key={idx}
                        style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          gap: 6,
                          fontSize: '0.76rem',
                        }}
                      >
                        <span
                          style={{
                            color: '#e5e7eb',
                            fontWeight: 500,
                            maxWidth: 175,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={item.title}
                        >
                          {item.title}
                        </span>
                        <span
                          style={{
                            flex: 1,
                            borderBottom: '1px dotted rgba(255, 255, 255, 0.22)',
                            minWidth: 8,
                          }}
                        />
                        <span
                          style={{
                            color: '#9ca3af',
                            fontFamily: 'monospace',
                            fontSize: '0.72rem',
                            fontWeight: 600,
                          }}
                        >
                          p. {item.page}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <p
                  style={{
                    margin: '10px 0 0',
                    fontSize: '0.70rem',
                    color: '#6b7280',
                    fontStyle: 'italic',
                    textAlign: 'center',
                  }}
                >
                  ✦ Amostra interativa: debata os tópicos com a IA.
                </p>
              </div>
            )}

            {/* Lâmina 3: Insight de Ouro / Resumo de Introdução */}
            {currentSlide === 2 && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  height: '100%',
                  padding: '12px 10px',
                  borderRadius: 12,
                  background: 'rgba(217, 119, 6, 0.07)',
                  border: '1px solid rgba(217, 119, 6, 0.22)',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <Sparkles size={13} color="#fbbf24" />
                    <span
                      style={{
                        fontSize: '0.74rem',
                        fontWeight: 700,
                        letterSpacing: '0.05em',
                        color: '#fbbf24',
                        textTransform: 'uppercase',
                      }}
                    >
                      Princípio Central
                    </span>
                  </div>

                  <p
                    style={{
                      margin: '6px 0',
                      fontSize: '0.79rem',
                      lineHeight: '1.45',
                      color: '#fef3c7',
                      fontStyle: 'italic',
                    }}
                  >
                    &ldquo;{goldenData.insight}&rdquo;
                  </p>
                </div>

                <button
                  onClick={() => handleAskInsight(goldenData.question)}
                  style={{
                    width: '100%',
                    marginTop: 8,
                    padding: '7px 10px',
                    borderRadius: 10,
                    background: 'rgba(255, 255, 255, 0.08)',
                    border: '1px solid rgba(251, 191, 36, 0.35)',
                    color: '#fbbf24',
                    fontSize: '0.74rem',
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                  title="Pergunta diretamente ao Agente de Voz sobre este conceito"
                >
                  <Lightbulb size={13} color="#fbbf24" />
                  <span>Perguntar à IA sobre este conceito</span>
                </button>
              </div>
            )}

            {/* Lâmina 4: Gatilho de Bloqueio (Paywall Suave / Isca de Conversão) */}
            {currentSlide === 3 && (
              <div
                style={{
                  position: 'relative',
                  width: '100%',
                  height: '100%',
                  minHeight: 250,
                  borderRadius: 12,
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  textAlign: 'center',
                  padding: '14px 10px',
                  background: 'rgba(0, 0, 0, 0.45)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                }}
              >
                {/* Efeito visual de fundo simulado com blur */}
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    filter: 'blur(6px)',
                    opacity: 0.15,
                    pointerEvents: 'none',
                    padding: 10,
                    fontSize: '0.65rem',
                    lineHeight: '1.25',
                    color: '#ffffff',
                    overflow: 'hidden',
                    userSelect: 'none',
                  }}
                >
                  Capítulo Completo. Métodos e exercícios práticos de fixação da leitura. Questionários de
                  compreensão, anotações em tempo real e mentoria socrática exclusiva para leitores do clube.
                  Acesso liberado para membros autenticados.
                </div>

                {/* Conteúdo de Conversão */}
                <div
                  style={{
                    position: 'relative',
                    zIndex: 2,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                  }}
                >
                  <div
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: '50%',
                      background: 'rgba(217, 119, 6, 0.2)',
                      border: '1px solid rgba(251, 191, 36, 0.45)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      boxShadow: '0 0 16px rgba(245, 158, 11, 0.3)',
                      marginBottom: 8,
                    }}
                  >
                    <Lock size={19} color="#fbbf24" />
                  </div>

                  <h4 style={{ margin: '0 0 4px', fontSize: '0.90rem', fontWeight: 700, color: '#ffffff' }}>
                    Amostra Concluída
                  </h4>

                  <p
                    style={{
                      margin: '0 0 12px',
                      fontSize: '0.75rem',
                      lineHeight: '1.38',
                      color: '#d1d5db',
                      maxWidth: 220,
                    }}
                  >
                    Gostou da introdução? Desbloqueie a leitura completa de todas as páginas, quizzes e modo mentor na Biblioteca.
                  </p>

                  <button
                    onClick={handleUnlockClick}
                    style={{
                      width: '100%',
                      padding: '9px 12px',
                      borderRadius: 10,
                      background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                      color: '#ffffff',
                      fontWeight: 700,
                      fontSize: '0.78rem',
                      border: 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                      boxShadow: '0 6px 16px rgba(16, 185, 129, 0.3)',
                    }}
                  >
                    <span>Acessar Biblioteca Completa</span>
                    <ArrowRight size={13} />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Controles e Navegação Inferior */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <button
                onClick={() => setCurrentSlide((s) => Math.max(0, s - 1))}
                disabled={currentSlide === 0}
                style={{
                  padding: '5px 8px',
                  borderRadius: 8,
                  background: currentSlide === 0 ? 'rgba(255, 255, 255, 0.03)' : 'rgba(255, 255, 255, 0.08)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  color: currentSlide === 0 ? '#4b5563' : '#e5e7eb',
                  cursor: currentSlide === 0 ? 'not-allowed' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                title="Voltar lâmina anterior"
                aria-label="Voltar lâmina anterior"
              >
                <ChevronLeft size={16} />
              </button>

              {/* Indicador de Bolinhas (● ○ ○ ○) */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {[0, 1, 2, 3].map((idx) => (
                  <button
                    key={idx}
                    onClick={() => setCurrentSlide(idx)}
                    style={{
                      width: currentSlide === idx ? 18 : 6,
                      height: 6,
                      borderRadius: 3,
                      background:
                        currentSlide === idx
                          ? isMentor
                            ? '#fbbf24'
                            : '#a5b4fc'
                          : 'rgba(255, 255, 255, 0.25)',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      transition: 'all 0.25s ease',
                    }}
                    title={`Ir para lâmina ${idx + 1}`}
                    aria-label={`Ir para lâmina ${idx + 1}`}
                  />
                ))}
              </div>

              <button
                onClick={() => setCurrentSlide((s) => Math.min(3, s + 1))}
                disabled={currentSlide === 3}
                style={{
                  padding: '5px 8px',
                  borderRadius: 8,
                  background: currentSlide === 3 ? 'rgba(255, 255, 255, 0.03)' : 'rgba(255, 255, 255, 0.08)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  color: currentSlide === 3 ? '#4b5563' : '#e5e7eb',
                  cursor: currentSlide === 3 ? 'not-allowed' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                title="Avançar próxima lâmina"
                aria-label="Avançar próxima lâmina"
              >
                <ChevronRight size={16} />
              </button>
            </div>

            <div
              style={{
                textAlign: 'center',
                marginTop: 6,
                fontSize: '0.70rem',
                color: '#9ca3af',
              }}
            >
              Página {currentSlide + 1} de 4 (Degustação)
            </div>
          </div>
        </div>

        {/* Lado Direito: Orbe de Voz e Controles */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: isMobile ? 220 : 280,
            position: 'relative',
            width: '100%',
            minWidth: 0, // permite encolher abaixo do conteúdo intrínseco
          }}
        >
          {/* Status Badge */}
          <div
            style={{
              marginBottom: 20,
              padding: '6px 14px',
              borderRadius: 20,
              fontSize: '0.8rem',
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              background:
                voiceState === 'SPEAKING'
                  ? 'rgba(217, 119, 6, 0.25)'
                  : voiceState === 'LISTENING'
                  ? 'rgba(16, 185, 129, 0.25)'
                  : voiceState === 'THINKING'
                  ? 'rgba(147, 51, 234, 0.25)'
                  : 'rgba(255, 255, 255, 0.07)',
              color:
                voiceState === 'SPEAKING'
                  ? '#fde047'
                  : voiceState === 'LISTENING'
                  ? '#6ee7b7'
                  : voiceState === 'THINKING'
                  ? '#d8b4fe'
                  : '#9ca3af',
              border: '1px solid rgba(255, 255, 255, 0.1)',
            }}
          >
            <Radio size={14} className={voiceState !== 'IDLE' ? 'pulse-icon' : ''} />
            <span>
              {voiceState === 'IDLE' && 'Pronto — Clique para iniciar'}
              {voiceState === 'CONNECTING' && 'Conectando canal seguro...'}
              {voiceState === 'LISTENING' && 'Sua vez de falar... (Microfone ativo)'}
              {voiceState === 'THINKING' && 'Pensando na resposta...'}
              {voiceState === 'SPEAKING' && 'Agente falando (Microfone em pausa para evitar eco)'}
              {voiceState === 'ERROR_MIC' && 'Microfone bloqueado'}
            </span>
          </div>

          {/* O Orbe Visual Pulsante */}
          <div
            onClick={() => {
              if (voiceState === 'SPEAKING') {
                handleBargeIn()
              } else if (voiceState === 'IDLE') {
                startVoiceSession()
              }
            }}
            style={{
              width: isMobile ? 104 : 120,
              height: isMobile ? 104 : 120,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: voiceState === 'CONNECTING' ? 'wait' : 'pointer',
              position: 'relative',
              transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
              background:
                voiceState === 'SPEAKING'
                  ? isMentor
                    ? 'radial-gradient(circle, #f59e0b 0%, #b45309 70%)'
                    : 'radial-gradient(circle, #6366f1 0%, #4338ca 70%)'
                  : voiceState === 'LISTENING'
                  ? 'radial-gradient(circle, #10b981 0%, #047857 70%)'
                  : voiceState === 'THINKING'
                  ? 'radial-gradient(circle, #8b5cf6 0%, #6d28d9 70%)'
                  : 'radial-gradient(circle, #374151 0%, #1f2937 70%)',
              boxShadow:
                voiceState !== 'IDLE'
                  ? `0 0 40px ${isMentor ? 'rgba(245, 158, 11, 0.5)' : 'rgba(99, 102, 241, 0.5)'}`
                  : '0 8px 24px rgba(0, 0, 0, 0.4)',
              transform: voiceState === 'SPEAKING' || voiceState === 'LISTENING' ? 'scale(1.08)' : 'scale(1)',
            }}
            title={voiceState === 'SPEAKING' ? 'Clique para interromper o agente (Barge-in)' : 'Iniciar voz'}
          >
            {/* Ondas externas reativas */}
            {(voiceState === 'SPEAKING' || voiceState === 'LISTENING') && (
              <div
                style={{
                  position: 'absolute',
                  inset: -14,
                  borderRadius: '50%',
                  border: `2px solid ${isMentor ? 'rgba(245, 158, 11, 0.4)' : 'rgba(99, 102, 241, 0.4)'}`,
                  animation: 'ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite',
                }}
              />
            )}

            {voiceState === 'IDLE' && <Mic size={44} color="#ffffff" />}
            {voiceState === 'CONNECTING' && <Sparkles size={40} color="#fef08a" />}
            {voiceState === 'LISTENING' && <Mic size={44} color="#ffffff" />}
            {voiceState === 'THINKING' && <Sparkles size={42} color="#e9d5ff" />}
            {voiceState === 'SPEAKING' && <Volume2 size={46} color="#ffffff" />}
            {voiceState === 'ERROR_MIC' && <MicOff size={44} color="#f87171" />}
          </div>

          {/* Caixa de Legenda / Transcrição em Tempo Real */}
          <div
            style={{
              marginTop: 24,
              width: '100%',
              maxWidth: isMobile ? '100%' : 540,
              minHeight: 52,
              padding: '12px 18px',
              borderRadius: 14,
              background: 'rgba(0, 0, 0, 0.35)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              fontSize: isMobile ? '0.82rem' : '0.88rem',
              lineHeight: '1.45',
              color: '#e5e7eb',
              boxSizing: 'border-box',
              textAlign: 'center',
            }}
          >
            {transcript ? (
              <span style={{ color: '#6ee7b7' }}>
                <strong>Você:</strong> &ldquo;{transcript}&rdquo;
              </span>
            ) : lastAgentMessage ? (
              <span>
                <strong style={{ color: isMentor ? '#fbbf24' : '#a5b4fc' }}>
                  {isMentor ? 'Mentor:' : 'Professor:'}
                </strong>{' '}
                &ldquo;{lastAgentMessage}&rdquo;
              </span>
            ) : (
              <span style={{ color: '#6b7280' }}>
                {selectedBook.hookAbertura ||
                  (isMentor
                    ? 'Clique no botão abaixo para debater os hábitos e lições deste livro.'
                    : 'Clique no botão abaixo para conversar com o Professor IA deste livro.')}
              </span>
            )}
          </div>

          {/* Mensagem de Erro se houver */}
          {errorMessage && (
            <div
              style={{
                marginTop: 12,
                color: '#f87171',
                fontSize: '0.8rem',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <AlertCircle size={14} />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Barra de Ações: Botão Principal de Conexão e Barge-in */}
          <div style={{ display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap', justifyContent: 'center' }}>
            {voiceState === 'IDLE' ? (
              <button
                className="btn btn-primary"
                onClick={startVoiceSession}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '12px 24px',
                  borderRadius: 14,
                  fontSize: '0.95rem',
                  fontWeight: 700,
                  background: isMentor
                    ? 'linear-gradient(135deg, #d97706 0%, #b45309 100%)'
                    : 'linear-gradient(135deg, #4f46e5 0%, #4338ca 100%)',
                  border: 'none',
                  color: '#fff',
                  boxShadow: '0 8px 20px rgba(0,0,0,0.3)',
                }}
              >
                <PhoneCall size={18} />
                Iniciar Sessão de Voz
              </button>
            ) : (
              <>
                {voiceState === 'SPEAKING' && (
                  <button
                    className="btn btn-secondary"
                    onClick={handleBargeIn}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '10px 18px',
                      borderRadius: 12,
                      fontSize: '0.85rem',
                      fontWeight: 600,
                      background: 'rgba(255, 255, 255, 0.12)',
                      color: '#fbbf24',
                      border: '1px solid rgba(251, 191, 36, 0.4)',
                    }}
                  >
                    <Mic size={15} /> Interromper & Falar (Barge-in)
                  </button>
                )}

                <button
                  className="btn btn-secondary"
                  onClick={terminateSession}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '10px 18px',
                    borderRadius: 12,
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    background: 'rgba(220, 38, 38, 0.2)',
                    color: '#f87171',
                    border: '1px solid rgba(220, 38, 38, 0.3)',
                  }}
                >
                  <PhoneOff size={15} /> Encerrar Conversa
                </button>
              </>
            )}
          </div>

          {/* Campo de Entrada Textual de Fallback (Acessibilidade) */}
          {voiceState !== 'IDLE' && (
            <div
              style={{
                marginTop: 16,
                display: 'flex',
                gap: 8,
                width: '100%',
                maxWidth: isMobile ? '100%' : 440,
                minWidth: 0,
              }}
            >
              <input
                type="text"
                placeholder="Ou digite sua pergunta aqui..."
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && textInput.trim()) {
                    sendUserQuery(textInput)
                    setTextInput('')
                  }
                }}
                style={{
                  flex: 1,
                  padding: '8px 14px',
                  borderRadius: 10,
                  background: 'rgba(255, 255, 255, 0.06)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#fff',
                  fontSize: '0.85rem',
                  outline: 'none',
                }}
              />
              <button
                onClick={() => {
                  if (textInput.trim()) {
                    sendUserQuery(textInput)
                    setTextInput('')
                  }
                }}
                style={{
                  padding: '8px 14px',
                  borderRadius: 10,
                  background: isMentor ? '#d97706' : '#4f46e5',
                  border: 'none',
                  color: '#fff',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                }}
              >
                <Send size={15} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
