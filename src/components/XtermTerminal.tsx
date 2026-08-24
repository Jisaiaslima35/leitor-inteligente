// XtermTerminal.tsx — wrapper React do @xterm/xterm com addon-fit.
//
// ISAÍAS 24/08/2026 — feature/terminal-interativo. Usa o terminal real do
// xterm.js (mesmo que Replit/Programiz usam). Lida com \r\n, backspace,
// Ctrl+C, ANSI escapes — tudo que um terminal real faz.
//
// API:
//   <XtermTerminal
//     session={terminalSession}   // lib/devSocket.ts
//     onReady={(term, fit) => {}}
//     className="minha-classe"
//   />

import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

import type { TerminalSession } from '../lib/devSocket'

export interface XtermTerminalProps {
  session: TerminalSession | null
  className?: string
  /** Callback com `(term, fit)` para o pai conseguir fazer write extra. */
  onReady?: (term: XTerm, fit: FitAddon) => void
}

export function XtermTerminal({
  session,
  className,
  onReady,
}: XtermTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<TerminalSession | null>(null)

  // Cria terminal uma vez
  useEffect(() => {
    if (!containerRef.current) return
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'JetBrains Mono, SF Mono, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: '#0e1116',
        foreground: '#e6edf3',
        cursor: '#d4af37',
        selectionBackground: '#d4af3733',
      },
      convertEol: true,        // \n sozinho já vira \r\n
      cursorStyle: 'block',
      allowProposedApi: true,
      // Mobile: o textarea helper do xterm nem sempre foca em teclado virtual.
      // Forçamos foco via click/touchstart (vide useInputBar no DevPage).
      screenReaderMode: false,
      // Disable focus loss when something else (like a <input>) is clicked
      // on mobile — without this, the soft keyboard may dismiss immediately.
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    if (onReady) onReady(term, fit)

    // ResizeObserver pra quando container muda de tamanho
    const ro = new ResizeObserver(() => {
      try { fit.fit() } catch { /* noop */ }
    })
    ro.observe(containerRef.current)

    // 24/08/2026 (P3.8 mobile): garantir foco do xterm ao tocar/clicar no container.
    // Sem isso o textarea helper do xterm não pega foco em teclado virtual (Android/iOS
    // mandam touch pro body, não pro textarea oculto).
    const focusTerminal = () => {
      try { term.focus() } catch { /* noop */ }
    }
    containerRef.current.addEventListener('touchstart', focusTerminal, { passive: true })
    containerRef.current.addEventListener('click', focusTerminal)

    // Quando o aluno digita no terminal → manda stdin
    term.onData((data) => {
      if (sessionRef.current) {
        sessionRef.current.sendStdin(data)
      }
    })

    return () => {
      ro.disconnect()
      if (containerRef.current) {
        containerRef.current.removeEventListener('touchstart', focusTerminal)
        containerRef.current.removeEventListener('click', focusTerminal)
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [onReady])

  // Conecta o cycle de eventos do session → terminal
  useEffect(() => {
    sessionRef.current = session
    const term = termRef.current
    if (!term || !session) return

    const onStdout = (chunk: string) => term.write(chunk)
    const onStderr = (chunk: string) =>
      term.write(`\x1b[31m${chunk}\x1b[0m`) // vermelho
    const onRuntime = (d: { language: string; version: string }) =>
      term.write(`\x1b[2m── ${d.language} ${d.version} ─────────────────\x1b[0m\r\n`)
    const onStage = (d: { stage: string }) =>
      term.write(`\x1b[2m── ${d.stage} ─────────────────\r\n\x1b[0m`)
    const onExit = (d: { stage: string; code: number | null; signal: string | null }) => {
      const ok = d.code === 0 && !d.signal
      const prefix = ok ? '\x1b[32m' : '\x1b[31m'
      const suffix = '\x1b[0m'
      const txt = d.signal
        ? `\r\n${prefix}✖ ${d.stage} interrompido (${d.signal})${suffix}\r\n`
        : `\r\n${prefix}✔ ${d.stage} saiu com código ${d.code}${suffix}\r\n`
      term.write(txt)
    }
    const onError = (msg: string) =>
      term.write(`\r\n\x1b[31m✖ ERRO: ${msg}\x1b[0m\r\n`)
    const onClose = (code: number, reason: string) =>
      term.write(
        `\r\n\x1b[33m── conexão fechada (${code} ${reason || ''}) ──\x1b[0m\r\n`,
      )

    session.on('stdout', onStdout)
    session.on('stderr', onStderr)
    session.on('runtime', onRuntime)
    session.on('stage', onStage)
    session.on('exit', onExit)
    session.on('error', onError)
    session.on('close', onClose)

    return () => {
      session.off('stdout', onStdout)
      session.off('stderr', onStderr)
      session.off('runtime', onRuntime)
      session.off('stage', onStage)
      session.off('exit', onExit)
      session.off('error', onError)
      session.off('close', onClose)
    }
  }, [session])

  return (
    <div
      ref={containerRef}
      className={className ?? 'xterm-host'}
      style={{ width: '100%', minHeight: 240, height: 280 }}
    />
  )
}
