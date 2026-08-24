// devSocket.ts — cliente WebSocket pro terminal interativo da Sala Dev.
//
// ISAÍAS 24/08/2026 — feature/terminal-interativo
// Conecta em /leitor-inteligente/ws/exec (proxy Nginx → terminal_server.py:2005
// → Piston 127.0.0.1:2000). Token do Supabase vai na primeira msg `init`.
//
// API simples:
//   const sess = await openTerminal({ slug, language, code, getToken })
//   // sess.sendStdin('Isaias\n')
//   // sess.sendSignal('SIGKILL')
//   // sess.on('stdout', cb) / sess.on('exit', cb) / sess.on('close', cb)
//   sess.close()
//
// Mantém o backpressure baixo e fecha WS se o socket morrer do lado browser.

export interface OpenTerminalOpts {
  slug: string
  language: string
  code: string
  getToken: () => Promise<string | null>
  /** caminho do WS, default já configurado pro proxy do Nginx em prod. */
  url?: string
}

export interface TerminalEvents {
  runtime: (d: { language: string; version: string }) => void
  stage: (d: { stage: string }) => void
  stdout: (chunk: string) => void
  stderr: (chunk: string) => void
  exit: (d: { stage: string; code: number | null; signal: string | null }) => void
  error: (msg: string) => void
  close: (code: number, reason: string) => void
}

export interface TerminalSession {
  sendStdin: (data: string) => void
  sendSignal: (signal: 'SIGKILL' | 'SIGTERM' | 'SIGINT') => void
  close: () => void
  on: <K extends keyof TerminalEvents>(name: K, cb: TerminalEvents[K]) => void
  off: <K extends keyof TerminalEvents>(name: K, cb: TerminalEvents[K]) => void
}

const DEFAULT_URL = (() => {
  if (typeof window === 'undefined') return ''
  // Em prod, Nginx escuta 9121 e proxy em /leitor-inteligente/ws/exec.
  // Em dev, Vite faz proxy diretamente pro terminal_server (configura em vite.config.ts).
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/leitor-inteligente/ws/exec`
})()

export function openTerminal(opts: OpenTerminalOpts): Promise<TerminalSession> {
  return new Promise(async (resolve, reject) => {
    const url = opts.url || DEFAULT_URL
    if (!url) {
      reject(new Error('URL do terminal indefinida'))
      return
    }
    const token = await opts.getToken()
    if (!token) {
      reject(new Error('Sem token Supabase — faça login'))
      return
    }

    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'

    const listeners: { [K in keyof TerminalEvents]?: TerminalEvents[K][] } = {}
    const emit = <K extends keyof TerminalEvents>(
      name: K,
      ...args: Parameters<TerminalEvents[K]>
    ) => {
      const cbs = listeners[name] || []
      for (const cb of cbs) (cb as any)(...args)
    }

    let opened = false

    ws.addEventListener('open', () => {
      // Primeira msg: init com tudo que backend precisa
      ws.send(JSON.stringify({
        type: 'init',
        token,
        slug: opts.slug,
        language: opts.language,
        code: opts.code,
      }))
      opened = true
      const session: TerminalSession = {
        sendStdin(data) {
          if (ws.readyState !== WebSocket.OPEN) return
          ws.send(JSON.stringify({ type: 'data', stream: 'stdin', data }))
        },
        sendSignal(signal) {
          if (ws.readyState !== WebSocket.OPEN) return
          ws.send(JSON.stringify({ type: 'signal', signal }))
        },
        close() {
          try {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
              ws.close(1000, 'closed by client')
            }
          } catch { /* noop */ }
        },
        on(name, cb) {
          const key = name as keyof TerminalEvents
          const arr = listeners[key] || (listeners[key] = [] as any)
          arr.push(cb as any)
        },
        off(name, cb) {
          const arr = listeners[name as keyof TerminalEvents]
          if (!arr) return
          const idx = arr.indexOf(cb as any)
          if (idx >= 0) arr.splice(idx, 1)
        },
      }
      resolve(session)
    })

    ws.addEventListener('message', (ev) => {
      let parsed: any
      try {
        parsed = JSON.parse(ev.data as string)
      } catch {
        // Não-JSON: trata como stderr genérico
        emit('stderr', `[não-json] ${ev.data as string}`)
        return
      }
      const type = parsed?.type
      if (type === 'data') {
        const stream = parsed.stream === 'stderr' ? 'stderr' : 'stdout'
        if (stream === 'stderr') emit('stderr', parsed.data || '')
        else emit('stdout', parsed.data || '')
      } else if (type === 'runtime') {
        emit('runtime', { language: parsed.language, version: parsed.version })
      } else if (type === 'stage') {
        emit('stage', { stage: parsed.stage })
      } else if (type === 'exit') {
        emit('exit', {
          stage: parsed.stage,
          code: parsed.code ?? null,
          signal: parsed.signal ?? null,
        })
      } else if (type === 'error') {
        emit('error', parsed.message || 'erro desconhecido')
      }
    })

    ws.addEventListener('close', (ev) => {
      if (!opened) {
        // Não chegou a abrir — rejeita a promise inicial.
        reject(new Error(`WS não abriu: ${ev.code} ${ev.reason || ''}`))
        return
      }
      emit('close', ev.code, ev.reason || '')
    })

    ws.addEventListener('error', () => {
      // Erros geralmente vêm ANTES de close (ou junto). Não rejeitamos aqui
      // se já resolveu, porque o close handler será chamado logo em seguida.
      // Se ainda não abriu, deixa o close rejeitar.
      if (!opened) {
        // browser vai disparar close logo após error
      }
    })
  })
}
