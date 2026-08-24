// DevPage.tsx — Sala Dev do Leitor Inteligente (playground de código + Mentor Dev + chat sobre livro + PDF)
//
// ISAÍAS: instalado 23/08/2026 como motor do Leitor DEVs.
//
// Layout (P2.4b, 23/08 — PDF embutido direto na Sala Dev):
//   1. Header (título do livro + ações globais)
//   2. PDF embutido (toolbar com nav/zoom/TTS + PdfViewer real) — MESMO componente do Reader
//   3. Chat sobre o livro (Professor IA /semantic-ask) — input livre + chips Resumir/3 exercícios/Conceitos-chave
//      Quando muda página do PDF acima, o chat já contextualiza naquela página automaticamente
//   4. Toolbar (linguagem + contador + Rodar)
//   5. Editor Monaco
//   6. Output da última execução em destaque + botão grande "Pergunte ao Mentor" (P2.6)
//   7. Histórico de execuções anterior (compacto, sem botão inline)
//
// Limites respeitados:
//   - código máx 5000 chars (validado backend, mas avisamos no front)
//   - rate limit 1 execução a cada 2s por usuário (botão fica desabilitado)
//   - timeout Piston 12s, timeout mentor 30s (indicador "rodando..." mostra)
//
// Sem persistência de execuções: histórico fica em sessionStorage, some ao recarregar.
// Posição de leitura do PDF: NÃO persiste (não confundir com o progresso do Reader).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, ChevronLeft, ChevronRight, MessageCircle, Pause, Play, RefreshCw, Send, Sparkles, Terminal, Trash2, Code2, ZoomIn, ZoomOut } from 'lucide-react'
import Editor from '@monaco-editor/react'
import { PdfViewer } from '../components/PdfViewer'
import { XtermTerminal } from '../components/XtermTerminal'
import { openTerminal, type TerminalSession } from '../lib/devSocket'
import { useAuth } from '../lib/AuthContext'
import { supabase, SUPABASE_READY } from '../lib/supabase'
import type { Book } from '../domain/types'

// Helper: fetch com timeout via AbortController. Devolve {ok, status, json, raw, contentType}.
// Se Content-Type não for JSON (ex.: nginx 504 HTML), `json` é null e `raw` tem o HTML.
// Isso evita erro "Unexpected token '<'" no frontend quando o upstream devolve HTML.
async function fetchJson(url: string, init: RequestInit, timeoutMs: number) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    const ct = res.headers.get('content-type') || ''
    const raw = await res.text()
    if (!ct.includes('application/json')) {
      return { ok: res.ok, status: res.status, json: null as any, raw, contentType: ct, timedOut: false }
    }
    try {
      return { ok: res.ok, status: res.status, json: JSON.parse(raw), raw, contentType: ct, timedOut: false }
    } catch (e: any) {
      return { ok: false, status: res.status, json: null, raw, contentType: ct, parseError: e?.message, timedOut: false }
    }
  } catch (e: any) {
    const aborted = e?.name === 'AbortError'
    return { ok: false, status: 0, json: null, raw: '', contentType: '', timedOut: aborted, error: e?.message }
  } finally {
    clearTimeout(t)
  }
}

type Lang = 'python' | 'javascript' | 'php'

interface ExecResult {
  stdout: string
  stderr: string
  code: number
  signal: string | null
  cpu_time: number
  wall_time: number
  memory: number
  language: string
  version: string
  session_id: string
  history_len: number
}

interface FeedbackTurn {
  id: string
  ts: number
  code: string
  language: Lang
  result?: ExecResult
  feedback?: string
  feedbackLoading?: boolean
  feedbackError?: string
}

interface ChatMsg {
  id: string
  role: 'user' | 'ai'
  text: string
}

interface DevPageProps {
  book?: Book | null
  onBack: () => void
}

const STARTERS: Record<Lang, string> = {
  python: '# Bem-vindo à Sala Dev do Leitor!\nprint("oi dev")\nprint(2 + 2)\n',
  javascript: '// Bem-vindo à Sala Dev do Leitor!\nconsole.log("oi dev");\nconsole.log([1, 2, 3].reduce((a, b) => a + b));\n',
  php: '<?php\n// Bem-vindo à Sala Dev do Leitor!\necho "oi dev\\n";\necho 10 * 5;\n',
}

const LANG_LABEL: Record<Lang, string> = {
  python: 'Python 3.11',
  javascript: 'JavaScript (Node 20)',
  php: 'PHP 8.2',
}

const MAX_CODE_CHARS = 5000
const RATE_LIMIT_MS = 2000
const DEFAULT_LANG: Lang = 'python'
const EXEC_TIMEOUT_MS = 12000
const FEEDBACK_TIMEOUT_MS = 30000
const PROFESSOR_TIMEOUT_MS = 60000

function sessionKey(bookId: string | undefined): string {
  return `leitor-dev:${bookId || 'anon'}:turns`
}

export function DevPage({ book, onBack }: DevPageProps) {
  const { user } = useAuth()
  const userId = user.id
  const [language, setLanguage] = useState<Lang>('python')
  const [code, setCode] = useState<string>(STARTERS[DEFAULT_LANG])
  const [turns, setTurns] = useState<FeedbackTurn[]>([])
  const [execLoading, setExecLoading] = useState(false)
  const [feedbackLoading, setFeedbackLoading] = useState(false)
  const [rateUntil, setRateUntil] = useState<number>(0)
  const [globalError, setGlobalError] = useState<string | null>(null)
  // 24/08/2026 (P3): terminal vivo WebSocket — input() interativo.
  // Default false = comportamento antigo (HTTP /exec) preservado.
  const [useTerminal, setUseTerminal] = useState(false)
  const [terminalSession, setTerminalSession] = useState<TerminalSession | null>(null)
  const [terminalConnecting, setTerminalConnecting] = useState(false)
  // 24/08/2026 (P3.8 mobile): input bar nativa abaixo do xterm. No celular o
  // teclado virtual do Android/iOS não consegue injetar chars no textarea
  // helper do xterm.js; o aluno digita num <input> HTML comum (corretor
  // funcionando) e a gente manda o texto + \n via WS pro Piston.
  const [terminalStdin, setTerminalStdin] = useState('')
  const terminalStdinRef = useRef<HTMLInputElement | null>(null)

  // 23/08/2026 (P2.4b): PDF embutido — mesma lógica do ReaderPage.
  // signed URL vem do backend /signed-url-api/sign (TTL 60min).
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const [pdfLoading, setPdfLoading] = useState(false)
  // Posição de leitura dentro da Sala Dev — não conflita com progress do Reader
  // (começa em 1, não puxa do Supabase). Isaías pediu pra poder folhear o livro
  // direto aqui sem perder o playground embaixo.
  const [pdfPage, setPdfPage] = useState<number>(1)
  const [pdfScale, setPdfScale] = useState<number>(1.3)
  const [pageText, setPageText] = useState<string>('')
  const [pdfTtsStatus, setPdfTtsStatus] = useState<'idle' | 'speaking'>('idle')

  // 23/08/2026 (P2.4): Chat sobre livro no DevPage — mesmo padrão do Reader.
  // chatContextPage começa igual ao pdfPage e é sobrescrito quando o user
  // muda página no PDF acima. Mantém sincronia sem precisar state global.
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatContextPage, setChatContextPage] = useState<number>(1)
  const chatScrollRef = useRef<HTMLDivElement>(null)

  const editorRef = useRef<any>(null)
  const turnsBottomRef = useRef<HTMLDivElement>(null)
  const pdfWrapRef = useRef<HTMLDivElement>(null)

  // P2.4b: busca signed URL pro PDF (mesma rota do Reader)
  useEffect(() => {
    let cancelled = false
    setPdfUrl(null)
    setPdfError(null)
    if (!book?.id) {
      setPdfLoading(false)
      return
    }
    if (!SUPABASE_READY || !userId) {
      setPdfLoading(false)
      return
    }
    setPdfLoading(true)
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
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
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
    return () => { cancelled = true }
  }, [book?.id, userId])

  // Carrega histórico de execuções da sessão
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(sessionKey(book?.id))
      if (raw) {
        const parsed: FeedbackTurn[] = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.length) setTurns(parsed)
      }
    } catch { /* ignore */ }
  }, [book?.id])

  useEffect(() => {
    try {
      if (turns.length === 0) {
        sessionStorage.removeItem(sessionKey(book?.id))
      } else {
        sessionStorage.setItem(sessionKey(book?.id), JSON.stringify(turns))
      }
    } catch { /* sem sessionStorage */ }
  }, [turns, book?.id])

  // Auto-scroll do histórico de execuções
  useEffect(() => {
    turnsBottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns.length, feedbackLoading])

  // Auto-scroll do chat sobre livro
  useEffect(() => {
    if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight
  }, [chatMessages, chatLoading])

  // Rate limit timer
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (rateUntil <= now) return
    const t = setTimeout(() => setNow(Date.now()), rateUntil - now + 50)
    return () => clearTimeout(t)
  }, [rateUntil, now])
  const rateLockedMs = Math.max(0, rateUntil - now)

  const charsCount = code.length
  const overLimit = charsCount > MAX_CODE_CHARS
  const execDisabled = execLoading || feedbackLoading || overLimit || rateLockedMs > 0

  const handleLanguageChange = useCallback((next: Lang) => {
    setLanguage(next)
    if (code.trim() === STARTERS[language].trim()) {
      setCode(STARTERS[next])
    }
  }, [code, language])

  const handleClearAll = useCallback(() => {
    if (!confirm('Limpar histórico de execuções desta sessão?')) return
    setTurns([])
    setCode(STARTERS[language])
  }, [language])

  const handleClearCode = useCallback(() => {
    setCode('')
    editorRef.current?.focus()
  }, [])

  // 24/08/2026 (P3): abre WS pro terminal_server.py:2005 com JWT Supabase +
  // categoria programacao gate. Sessão fica viva até exit ou disconnect.
  const handleRunTerminal = useCallback(async () => {
    if (!book) {
      setGlobalError('Abra um livro de programação pela biblioteca pra usar o terminal.')
      setUseTerminal(false)
      return
    }
    if (terminalConnecting || terminalSession) return
    setGlobalError(null)
    setTerminalConnecting(true)
    try {
      const session = await openTerminal({
        slug: book.id,
        language,
        code,
        getToken: async () => {
          const { data } = await supabase.auth.getSession()
          return data.session?.access_token ?? null
        },
      })
      // Quando o backend fechar, libera o estado
      session.on('close', () => setTerminalSession(prev => prev))
      setTerminalSession(session)
    } catch (e: any) {
      setGlobalError(`Terminal não conectou: ${e?.message || e}`)
      setUseTerminal(false)
    } finally {
      setTerminalConnecting(false)
    }
  }, [book, language, code, terminalConnecting, terminalSession])

  const handleCloseTerminal = useCallback(() => {
    if (terminalSession) terminalSession.close()
    setTerminalSession(null)
  }, [terminalSession])

  // 24/08/2026 (P3.8 mobile): envia texto digitado na input bar pro stdin do Piston.
  // Concatena \n porque input() do Python só desbloqueia com newline.
  // Mantém o foco na input pra próximo input() — UX mobile natural.
  const handleSendStdin = useCallback(() => {
    const value = terminalStdin
    if (!terminalSession || !value) return
    terminalSession.sendStdin(value + '\n')
    setTerminalStdin('')
    // mantém foco pra próximo input() — fundamental no mobile
    requestAnimationFrame(() => terminalStdinRef.current?.focus())
  }, [terminalStdin, terminalSession])

  // Submit com Enter na input bar (Enter puro envia; Shift+Enter permite multiline)
  const handleStdinKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendStdin()
    }
  }, [handleSendStdin])

  // Limpa session ao desmontar a página
  useEffect(() => {
    return () => { terminalSession?.close() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleRun = useCallback(async () => {
    if (execDisabled) return
    setGlobalError(null)
    const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const turn: FeedbackTurn = {
      id: turnId,
      ts: Date.now(),
      code,
      language,
      result: undefined,
      feedbackLoading: false,
    }
    setTurns(prev => [...prev, turn])
    setExecLoading(true)
    setRateUntil(Date.now() + RATE_LIMIT_MS)

    try {
      const r = await fetchJson('/leitor-inteligente/dev-api/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language,
          code,
          session_id: book?.id || 'anon',
        }),
      }, EXEC_TIMEOUT_MS)

      const errMsg = r.timedOut
        ? 'Execução demorou demais (timeout). Tente código menor.'
        : r.contentType && !r.contentType.includes('application/json')
          ? `Backend retornou ${r.contentType} (não-JSON). Tente de novo.`
          : r.parseError
            ? `Backend retornou resposta inválida: ${r.parseError}`
            : (r.json?.error || r.json?.message || `HTTP ${r.status}`)

      if (!r.ok || !r.json) {
        setGlobalError(errMsg)
        setTurns(prev => prev.map(t => t.id === turnId ? {
          ...t,
          result: {
            stdout: '', stderr: errMsg,
            code: -1, signal: null, cpu_time: 0, wall_time: 0, memory: 0,
            language, version: '-', session_id: book?.id || 'anon', history_len: 0,
          },
        } : t))
        return
      }
      const data = r.json
      const execResult: ExecResult = { ...data, language, version: data.version || '-' }
      setTurns(prev => prev.map(t => t.id === turnId ? { ...t, result: execResult } : t))
    } catch (e: any) {
      setGlobalError(`Erro de rede: ${e?.message || e}`)
      setTurns(prev => prev.map(t => t.id === turnId ? {
        ...t,
        result: {
          stdout: '', stderr: `Erro de rede: ${e?.message || e}`,
          code: -1, signal: null, cpu_time: 0, wall_time: 0, memory: 0,
          language, version: '-', session_id: book?.id || 'anon', history_len: 0,
        },
      } : t))
    } finally {
      setExecLoading(false)
    }
  }, [code, language, execDisabled, book?.id])

  // P2.6: botão "Pergunte ao Mentor" sempre age na ÚLTIMA execução.
  const lastTurn = turns[turns.length - 1]
  const handleAskMentor = useCallback(async () => {
    if (!lastTurn || !lastTurn.result) return
    if (feedbackLoading) return
    setFeedbackLoading(true)
    setGlobalError(null)
    setTurns(prev => prev.map(t => t.id === lastTurn.id ? { ...t, feedbackLoading: true, feedbackError: undefined } : t))
    try {
      const r = await fetchJson('/leitor-inteligente/dev-api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: book?.id || 'anon',
          language: lastTurn.language,
          code: lastTurn.code,
          stdout: lastTurn.result.stdout,
          stderr: lastTurn.result.stderr,
          exit_code: lastTurn.result.code,
          enunciado: 'Exercício do livro ' + (book?.title || 'atual'),
        }),
      }, FEEDBACK_TIMEOUT_MS)

      const errMsg = r.timedOut
        ? 'Mentor Dev demorou demais (>30s). Tente de novo — o 9Router pode estar trocando de provedor.'
        : r.contentType && !r.contentType.includes('application/json')
          ? `Backend retornou HTML em vez de JSON (${r.status}). Pode ser timeout do nginx. Tente de novo.`
          : r.parseError
            ? `Resposta inválida do backend: ${r.parseError}`
            : (r.json?.error || `HTTP ${r.status}`)

      if (!r.ok || !r.json) {
        setTurns(prev => prev.map(t => t.id === lastTurn.id ? {
          ...t, feedbackLoading: false, feedbackError: errMsg,
        } : t))
        return
      }
      setTurns(prev => prev.map(t => t.id === lastTurn.id ? {
        ...t, feedbackLoading: false, feedback: r.json.feedback,
      } : t))
    } catch (e: any) {
      setTurns(prev => prev.map(t => t.id === lastTurn.id ? {
        ...t, feedbackLoading: false, feedbackError: `Erro de rede: ${e?.message || e}`,
      } : t))
    } finally {
      setFeedbackLoading(false)
    }
  }, [lastTurn, feedbackLoading, book?.id, book?.title])

  // P2.4: chat sobre livro — mesma chamada /<book.id>/semantic-api/semantic-ask do Reader
  const askProfessor = useCallback(async (raw: string) => {
    const text = raw.trim()
    if (!text || chatLoading) return
    if (!book?.id) {
      // sem livro (dev anônimo): avisa e não chama
      setChatMessages(prev => [...prev, {
        id: `e-${Date.now()}`,
        role: 'ai',
        text: 'O chat sobre livro só funciona quando você abre a Sala Dev a partir de um livro (clica em "Área Dev" na toolbar do PDF). No modo anônimo, escreve código e testa à vontade.',
      }])
      return
    }
    const stamp = Date.now()
    setChatMessages(prev => [...prev, { id: `u-${stamp}`, role: 'user', text }])
    setChatInput('')
    setChatLoading(true)
    try {
      const url = `/${book.id}/semantic-api/semantic-ask`
      const r = await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: text,
          currentPage: chatContextPage,
          bookSlug: book.id,
          modo_mentor: false,
        }),
      }, PROFESSOR_TIMEOUT_MS)
      if (!r.ok || !r.json) {
        const msg = r.timedOut
          ? 'Professor IA demorou demais (>60s). Tente de novo.'
          : (r.json?.error || `HTTP ${r.status}`)
        setChatMessages(prev => [...prev, { id: `e-${stamp}`, role: 'ai', text: `Erro: ${msg}` }])
        return
      }
      setChatMessages(prev => [...prev, { id: `a-${stamp}`, role: 'ai', text: r.json.answer || '(sem resposta)' }])
    } catch (e: any) {
      setChatMessages(prev => [...prev, { id: `e-${stamp}`, role: 'ai', text: `Erro de rede: ${e?.message || e}` }])
    } finally {
      setChatLoading(false)
    }
  }, [book?.id, chatContextPage, chatLoading])

  const effectiveRateLockedMs = useMemo(() => rateLockedMs, [rateLockedMs])

  return (
    <div className="dev-page">
      <header className="dev-header">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Voltar">
          <ChevronLeft size={18} />
        </button>
        <div className="dev-header-text">
          <h1 className="dev-title">
            <Code2 size={20} /> Sala Dev
            {book && <span className="dev-book-label">— {book.title}</span>}
          </h1>
          <p className="dev-subtitle">
            Playground com PHP, Python e JavaScript. Roda código real no servidor
            e o Mentor Dev te dá feedback pedagógico.
          </p>
        </div>
        <div className="dev-header-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={handleClearCode} title="Limpar código">
            <Trash2 size={14} /> Limpar código
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={handleClearAll} title="Nova sessão de execuções">
            <RefreshCw size={14} /> Nova sessão
          </button>
        </div>
      </header>

      {globalError && (
        <div className="dev-global-error" role="alert">{globalError}</div>
      )}

      {/* P2.4b — PDF embutido direto na Sala Dev (mesmo componente do Reader) */}
      <DevPdfPanel
        book={book}
        pdfUrl={pdfUrl}
        pdfError={pdfError}
        pdfLoading={pdfLoading}
        pdfPage={pdfPage}
        setPdfPage={(p) => { setPdfPage(p); setChatContextPage(p) }}
        pdfScale={pdfScale}
        setPdfScale={setPdfScale}
        pageText={pageText}
        setPageText={setPageText}
        pdfTtsStatus={pdfTtsStatus}
        setPdfTtsStatus={setPdfTtsStatus}
        wrapRef={pdfWrapRef}
        onBack={onBack}
      />

      {/* P2.4 — chat sobre livro (mesmo padrão do Reader, mas simplificado: sem TTS/voz) */}
      <section className="dev-book-chat" aria-label="Chat sobre o livro">
        <header className="dev-section-title">
          <MessageCircle size={16} /> Professor IA — chat sobre o livro
          {book && (
            <span className="dev-chat-page-control">
              Página:
              <input
                type="number"
                min={1}
                max={book.totalPages}
                value={chatContextPage}
                onChange={e => setChatContextPage(Math.min(book.totalPages, Math.max(1, Number(e.target.value) || 1)))}
                aria-label="Página de contexto"
              />
            </span>
          )}
        </header>
        <div className="dev-chat-window" ref={chatScrollRef}>
          {chatMessages.length === 0 && (
            <div className="dev-chat-empty">
              Pergunte algo sobre o conteúdo do livro ou use um dos botões abaixo.
              {!book && ' (mas você tá no modo anônimo — só funciona com livro aberto)'}
            </div>
          )}
          {chatMessages.map(m => (
            <div key={m.id} className={`dev-chat-bubble ${m.role}`}>
              {m.text}
            </div>
          ))}
          {chatLoading && <div className="dev-chat-bubble ai">Consultando o livro…</div>}
        </div>
        <div className="dev-chat-composer">
          <input
            type="text"
            value={chatInput}
            disabled={chatLoading || !book}
            placeholder={book ? 'Pergunte algo sobre o livro…' : 'Abra um livro de programação pra usar o chat'}
            onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') askProfessor(chatInput) }}
            aria-label="Pergunta pro Professor IA"
          />
          <button type="button" className="btn btn-primary" disabled={chatLoading || !chatInput.trim() || !book} onClick={() => askProfessor(chatInput)}>
            <Send size={16} /> <span className="label">{chatLoading ? '…' : 'Enviar'}</span>
          </button>
        </div>
        <div className="dev-chat-chips">
          <button type="button" disabled={chatLoading || !book}
            onClick={() => askProfessor(`Faça um resumo curto da página ${chatContextPage}.`)}>
            📄 Resumir esta página
          </button>
          <button type="button" disabled={chatLoading || !book}
            onClick={() => askProfessor(`Quais são os 3 conceitos mais importantes da página ${chatContextPage}?`)}>
            🧠 Conceitos-chave
          </button>
          <button type="button" disabled={chatLoading || !book}
            onClick={() => askProfessor(`Crie 3 exercícios práticos sobre o conteúdo da página ${chatContextPage}, com enunciado claro e nível progressivo.`)}>
            🎯 3 exercícios práticos
          </button>
        </div>
      </section>

      <div className="dev-toolbar">
        <label className="dev-lang-picker">
          Linguagem:
          <select value={language} onChange={e => handleLanguageChange(e.target.value as Lang)} disabled={execLoading}>
            <option value="python">{LANG_LABEL.python}</option>
            <option value="javascript">{LANG_LABEL.javascript}</option>
            <option value="php">{LANG_LABEL.php}</option>
          </select>
        </label>
        <label className="dev-mode-toggle" title="Modo terminal: input() roda em tempo real (WebSocket). Modo clássico: roda e devolve output">
          <input
            type="checkbox"
            checked={useTerminal}
            onChange={e => {
              const next = e.target.checked
              setUseTerminal(next)
              if (!next && terminalSession) {
                handleCloseTerminal()
              }
            }}
          />
          <Terminal size={14} /> terminal vivo (input())
        </label>
        <span className={`dev-char-count ${overLimit ? 'is-over' : ''}`}>
          {charsCount} / {MAX_CODE_CHARS} chars
          {overLimit && ' — acima do limite'}
        </span>
        <button
          type="button"
          className="btn btn-primary dev-run-btn"
          onClick={useTerminal ? handleRunTerminal : handleRun}
          disabled={useTerminal ? (terminalConnecting || !!terminalSession || overLimit) : execDisabled}
          title={
            overLimit ? 'Código acima de 5000 chars' :
            useTerminal ? (terminalConnecting ? 'Conectando...' : terminalSession ? 'Sessão já aberta' : 'Abrir terminal interativo') :
            rateLockedMs > 0 ? `Aguarde ${(rateLockedMs/1000).toFixed(1)}s` :
            execLoading ? 'Rodando...' : 'Executar código (Ctrl+Enter)'
          }
        >
          {useTerminal ? (
            terminalConnecting ? <><RefreshCw size={16} className="spin" /> Conectando…</>
            : terminalSession ? <><Pause size={16} /> Rodando (terminal)</>
            : <><Play size={16} /> Conectar terminal</>
          ) : execLoading ? (
            <><RefreshCw size={16} className="spin" /> Rodando...</>
          ) : rateLockedMs > 0 ? (
            <><RefreshCw size={16} /> Calma {Math.ceil(rateLockedMs/1000)}s</>
          ) : (
            <><Play size={16} /> Rodar</>
          )}
        </button>
        {useTerminal && terminalSession && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleCloseTerminal}
            title="Encerra a sessão WS com o Piston"
          >
            <Pause size={14} /> Encerrar terminal
          </button>
        )}
      </div>

      <section className="dev-editor-wrap">
        <Editor
          height="320px"
          language={language === 'javascript' ? 'javascript' : language}
          theme="vs-dark"
          value={code}
          onChange={(value) => setCode(value ?? '')}
          onMount={(editor, monaco) => {
            editorRef.current = editor
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => handleRun())
          }}
          options={{
            fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'Courier New', monospace",
            fontSize: 14, lineHeight: 1.55,
            minimap: { enabled: false }, scrollBeyondLastLine: false, tabSize: 2,
            automaticLayout: true, wordWrap: 'on', renderLineHighlight: 'line',
            padding: { top: 14, bottom: 14 },
            scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
          }}
          loading={<div style={{ padding: 20, color: 'var(--muted)' }}>Carregando editor Monaco…</div>}
        />
      </section>

      {/* 24/08/2026 (P3): terminal interativo WebSocket. Aparece SÓ quando
          useTerminal=true. xterm.js cuida de stdin/stdout ao vivo. */}
      {useTerminal && (
        <section className="dev-terminal-panel" aria-label="Terminal interativo">
          <header className="dev-section-title">
            <Terminal size={16} /> Terminal ao vivo — input() em tempo real
            {terminalSession && (
              <span className="dev-mode-toggle" style={{ marginLeft: 'auto' }}>
                <span style={{ color: 'var(--brand)' }}>● conectado</span>
              </span>
            )}
            {!terminalSession && !terminalConnecting && (
              <span className="dev-mode-toggle" style={{ marginLeft: 'auto', color: 'var(--muted)' }}>
                clique em “Conectar terminal”
              </span>
            )}
          </header>
          <XtermTerminal session={terminalSession} />

          {/* P3.8 mobile — input bar nativa abaixo do xterm. Aparece quando
              a sessão WS tá ativa. Teclado virtual mobile funciona normal em
              <input> HTML, ao contrário do textarea helper do xterm. */}
          {terminalSession && (
            <div className="dev-terminal-stdin">
              <input
                ref={terminalStdinRef}
                type="text"
                inputMode="text"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="Digite sua resposta e toque em Enviar (Enter)…"
                value={terminalStdin}
                onChange={e => setTerminalStdin(e.target.value)}
                onKeyDown={handleStdinKeyDown}
                aria-label="Entrada para o terminal (stdin)"
              />
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleSendStdin}
                disabled={!terminalStdin}
                title="Manda o texto + newline pro stdin (Enter)"
              >
                <Send size={16} /> <span className="label">Enviar</span>
              </button>
            </div>
          )}
        </section>
      )}

      {/* P2.6 — output da última execução em destaque + botão Mentor grande */}
      {lastTurn && (
        <section className="dev-latest-result" aria-label="Última execução">
          <h3 className="dev-section-title">
            <Terminal size={16} /> Última execução · {LANG_LABEL[lastTurn.language]} ·{' '}
            {new Date(lastTurn.ts).toLocaleTimeString('pt-BR')}
            {lastTurn.result && (
              <span className={`dev-turn-exit ${lastTurn.result.code === 0 ? 'is-ok' : 'is-err'}`}>
                exit {lastTurn.result.code} · {lastTurn.result.wall_time}ms
              </span>
            )}
          </h3>
          {lastTurn.result && (
            <div className="dev-latest-outputs">
              {lastTurn.result.stdout && (
                <div className={`dev-output ${lastTurn.result.code === 0 ? 'is-ok' : 'is-err'}`}>
                  <h4>stdout</h4>
                  <pre>{lastTurn.result.stdout}</pre>
                </div>
              )}
              {!lastTurn.result.stdout && lastTurn.result.stderr && (
                <div className="dev-output is-err">
                  <h4>stderr</h4>
                  <pre>{lastTurn.result.stderr}</pre>
                </div>
              )}
              {lastTurn.result.stdout && lastTurn.result.stderr && (
                <div className="dev-output dev-output-err">
                  <h4>stderr</h4>
                  <pre>{lastTurn.result.stderr}</pre>
                </div>
              )}
            </div>
          )}

          {/* P2.6 — botão grande e visível "Pergunte ao Mentor" */}
          <div className="dev-mentor-cta">
            {lastTurn.feedback ? (
              <div className="dev-mentor-bubble">
                <h4><Sparkles size={14} /> Mentor Dev</h4>
                <p>{lastTurn.feedback}</p>
              </div>
            ) : lastTurn.feedbackLoading ? (
              <div className="dev-mentor-bubble dev-mentor-loading">
                <h4><Sparkles size={14} /> Mentor Dev</h4>
                <p><RefreshCw size={14} className="spin" /> Pensando (pode levar até 30s)...</p>
              </div>
            ) : lastTurn.feedbackError ? (
              <div className="dev-mentor-bubble dev-mentor-err">
                <h4><Sparkles size={14} /> Mentor Dev</h4>
                <p>{lastTurn.feedbackError}</p>
                <button className="btn btn-primary dev-mentor-btn" onClick={handleAskMentor}>
                  <Sparkles size={16} /> Tentar de novo
                </button>
              </div>
            ) : (
              <button
                className="btn btn-primary dev-mentor-btn"
                onClick={handleAskMentor}
                disabled={feedbackLoading || !lastTurn.result}
              >
                <Sparkles size={16} /> Pergunte ao Mentor Dev sobre este código
              </button>
            )}
          </div>
        </section>
      )}

      {/* Histórico compacto das execuções anteriores (sem botão inline, Mentor só na última) */}
      {turns.length > 1 && (
        <section className="dev-turns" aria-label="Execuções anteriores">
          <h2 className="dev-section-title">
            <Terminal size={16} /> Execuções anteriores ({turns.length - 1})
          </h2>
          {turns.slice(0, -1).slice().reverse().map(t => (
            <DevTurn key={t.id} turn={t} />
          ))}
          <div ref={turnsBottomRef} />
        </section>
      )}

      {turns.length === 0 && (
        <div className="dev-empty">
          Nenhuma execução ainda. Escreve código acima e clica em <strong>Rodar</strong>.
        </div>
      )}
    </div>
  )
}

// Versão compacta pra execuções antigas — sem botão Mentor (só a última tem)
function DevTurn({ turn }: { turn: FeedbackTurn }) {
  const r = turn.result
  return (
    <article className="dev-turn">
      <header className="dev-turn-header">
        <span className="dev-turn-time">{new Date(turn.ts).toLocaleTimeString('pt-BR')}</span>
        <span className="dev-turn-lang">{LANG_LABEL[turn.language]}</span>
        {r && (
          <span className={`dev-turn-exit ${r.code === 0 ? 'is-ok' : 'is-err'}`}>
            exit {r.code} · {r.wall_time}ms
          </span>
        )}
      </header>
      {r && (
        <div className="dev-latest-outputs">
          {r.stdout && (
            <div className={`dev-output ${r.code === 0 ? 'is-ok' : 'is-err'}`}>
              <h4>stdout</h4>
              <pre>{r.stdout}</pre>
            </div>
          )}
          {r.stderr && (
            <div className="dev-output dev-output-err">
              <h4>stderr</h4>
              <pre>{r.stderr}</pre>
            </div>
          )}
        </div>
      )}
      {turn.feedback && (
        <div className="dev-mentor-bubble dev-mentor-compact">
          <h4><Sparkles size={14} /> Mentor Dev</h4>
          <p>{turn.feedback}</p>
        </div>
      )}
    </article>
  )
}

// P2.4b — painel de PDF embutido na Sala Dev.
// Mesmo PdfViewer do ReaderPage, com toolbar própria (nav/zoom/TTS).
// Quando o livro não tá presente (modo anônimo), mostra placeholder.
interface DevPdfPanelProps {
  book: Book | null | undefined
  pdfUrl: string | null
  pdfError: string | null
  pdfLoading: boolean
  pdfPage: number
  setPdfPage: (n: number) => void
  pdfScale: number
  setPdfScale: (n: number) => void
  pageText: string
  setPageText: (s: string) => void
  pdfTtsStatus: 'idle' | 'speaking'
  setPdfTtsStatus: (s: 'idle' | 'speaking') => void
  wrapRef: React.RefObject<HTMLDivElement | null>
  onBack: () => void
}

function DevPdfPanel({
  book, pdfUrl, pdfError, pdfLoading,
  pdfPage, setPdfPage, pdfScale, setPdfScale,
  pageText, setPageText, pdfTtsStatus, setPdfTtsStatus,
  wrapRef, onBack,
}: DevPdfPanelProps) {
  // Sem livro: não tenta carregar PDF. Mostra placeholder pra ficar claro
  // que o chat/code playground funcionam mesmo sem livro (modo anônimo).
  if (!book) {
    return (
      <section className="dev-pdf-panel dev-pdf-empty" aria-label="PDF (sem livro)">
        <BookOpen size={20} />
        <span>
          Sem livro aberto. Abra um livro de programação pela biblioteca pra ler aqui dentro.
        </span>
      </section>
    )
  }

  // Loading da signed URL
  if (pdfLoading) {
    return (
      <section className="dev-pdf-panel" aria-label="PDF carregando">
        <div className="pdf-loading"><div className="spinner" /><p>Carregando o livro…</p></div>
      </section>
    )
  }

  // Erro ao buscar signed URL
  if (pdfError || !pdfUrl) {
    return (
      <section className="dev-pdf-panel dev-pdf-err" aria-label="PDF com erro">
        <p>Não consegui carregar o PDF: {pdfError ?? 'URL não gerada'}</p>
        <button className="btn-primary" onClick={() => window.location.reload()}>Tentar de novo</button>
      </section>
    )
  }

  const clampPage = (p: number) => Math.min(Math.max(1, p), book.totalPages)
  const onInternalNav = useCallback((_n: number) => { /* noop — React já controla */ }, [])

  return (
    <section className="dev-pdf-panel" aria-label="Leitor de PDF embutido na Sala Dev">
      {/* Toolbar do PDF — espelha a do ReaderPage pra manter familiaridade */}
      <div className="pdf-toolbar">
        <div className="pdf-toolbar-row">
          <button className="icon-btn" onClick={() => setPdfPage(clampPage(pdfPage - 1))} aria-label="Página anterior">
            <ChevronLeft size={18} />
          </button>
          <span className="page-label">Página</span>
          <input
            type="number"
            min={1}
            max={book.totalPages}
            value={pdfPage}
            onChange={(e) => setPdfPage(clampPage(Number(e.target.value) || 1))}
          />
          <span className="page-label">de {book.totalPages}</span>
          <button className="icon-btn" onClick={() => setPdfPage(clampPage(pdfPage + 1))} aria-label="Próxima página">
            <ChevronRight size={18} />
          </button>
          <span className="page-progress-meta" aria-label="Progresso de leitura">
            <strong>{Math.round((pdfPage / book.totalPages) * 100)}%</strong>
          </span>
        </div>
        <div className="pdf-toolbar-row pdf-toolbar-actions">
          <button className="icon-btn" onClick={() => setPdfScale(Math.max(0.8, +(pdfScale - 0.3).toFixed(1)))} disabled={pdfScale <= 0.8} title="Diminuir zoom" aria-label="Diminuir zoom">
            <ZoomOut size={16} />
          </button>
          <span className="zoom-label" aria-live="polite">{Math.round(pdfScale * 100)}%</span>
          <button className="icon-btn" onClick={() => setPdfScale(Math.min(3, +(pdfScale + 0.3).toFixed(1)))} disabled={pdfScale >= 3} title="Aumentar zoom" aria-label="Aumentar zoom">
            <ZoomIn size={16} />
          </button>
          <button
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
          <button className="icon-btn" onClick={onBack} title="Voltar à biblioteca">
            Voltar
          </button>
        </div>
      </div>
      <div ref={wrapRef} className="dev-pdf-viewer-wrap">
        <PdfViewer
          pdfPath={pdfUrl}
          page={pdfPage}
          onPageChange={setPdfPage}
          onInternalNav={onInternalNav}
          scale={pdfScale}
          onTextExtracted={setPageText}
        />
      </div>
    </section>
  )
}
