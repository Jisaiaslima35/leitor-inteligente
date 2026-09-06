// Painel de Estudo Colaborativo em Tempo Real
// 04/09/2026 — Claudinho
//
// Painel lateral (drawer direita) que abre em qualquer livro do ReaderPage
// e também na DevPage. URL aceita `?room=<uuid>` — gera a sala via UUID e
// copia pro clipboard pra mandar no WhatsApp.
//
// Stack: Yjs (CRDT) + y-websocket (sync) + y-monaco (binding pro Monaco).
// Backend relay em `api/collab_server.py:2006` faz fan-out binário.
//
// Modes:
// - text      → anotações livres (default pra livros não-programação)
// - python    → código Python (default pra DevPage)
// - javascript → código JavaScript (acesso direto ao Piston sem mudar livro)

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { MonacoBinding } from 'y-monaco'
import { v4 as uuidv4 } from 'uuid'
import { Users } from 'lucide-react'
import { fetchJson } from '../lib/fetchJson'

interface CollabPanelProps {
  roomId: string
  displayName: string
  jwtToken: string
  isAuthenticated: boolean
  defaultMode?: 'text' | 'python' | 'javascript' | 'php'
  onClose: () => void
}

// URL do backend WS — produção via Nginx, dev via localhost
// 04/09/2026: o front roda em https://preview.automacaojs.us/leitor-inteligente/
// mas o nginx SÓ tem `location /leitor-inteligente/ws/collab` (com prefixo).
// Montar `wss://host/ws/collab` (sem prefixo) dá 404 → handshake nunca fecha.
const isDev = typeof window !== 'undefined' && window.location.port === '5173'
const WS_BASE = isDev
  ? 'ws://127.0.0.1:2006/collab'
  : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/leitor-inteligente/ws/collab`

// localStorage prefix consistente com o resto do app
const LS_KEY = (roomId: string) => `leitor-ia:room-${roomId}:draft`

const MODES = [
  { id: 'text', label: '📝 Texto', lang: undefined, monacoLang: 'plaintext' },
  { id: 'python', label: '🐍 Python', lang: 'python', monacoLang: 'python' },
  { id: 'javascript', label: '🟨 JavaScript', lang: 'javascript', monacoLang: 'javascript' },
  { id: 'php', label: '🐘 PHP', lang: 'php', monacoLang: 'php' },
] as const

type ModeId = (typeof MODES)[number]['id']

export default function CollabPanel({
  roomId,
  displayName,
  jwtToken,
  isAuthenticated,
  defaultMode = 'text',
  onClose,
}: CollabPanelProps) {
  const editorRef = useRef<any>(null)
  const ydocRef = useRef<Y.Doc | null>(null)
  const ytextRef = useRef<Y.Text | null>(null)
  const providerRef = useRef<WebsocketProvider | null>(null)
  const bindingRef = useRef<MonacoBinding | null>(null)
  const saveTimeoutRef = useRef<number | null>(null)

  const [mode, setMode] = useState<ModeId>(defaultMode)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'guest' | 'error'>('connecting')
  const [peers, setPeers] = useState<{ user_id: string; display_name: string }[]>([])
  const [running, setRunning] = useState(false)
  const [execOut, setExecOut] = useState<string>('')
  const [execTs, setExecTs] = useState<number>(0)
  const [inviteCopied, setInviteCopied] = useState(false)

  const monacoLang = MODES.find((m) => m.id === mode)?.monacoLang || 'plaintext'

  // ── Conecta Yjs + WebSocketProvider ─────────────────────────────────
  // 04/09/2026 Isaías pediu modo HÍBRIDO: editor SEMPRE editável
  // (independente do WS). O Y.Doc é local desde o primeiro paint — o
  // usuário digita mesmo offline. Quando o WebSocket conecta, ele faz
  // sync do state local com o server (CRDT mergeia sem perder nada).
  // Antes: sem JWT → early return + readOnly + status='guest'. Agora:
  // sempre cria Y.Doc + tenta conectar; falha de auth vira 'guest' mas
  // o Y.Doc continua editável localmente e o save localStorage funciona.
  useEffect(() => {
    if (!roomId) return

    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    ydocRef.current = ydoc
    ytextRef.current = ytext

    let mounted = true
    let provider: WebsocketProvider | null = null
    try {
      // Token pode estar vazio (guest) — server rejeita com 4401 mas o
      // Y.Doc continua funcional. y-websocket reconecta sozinho.
      provider = new WebsocketProvider(WS_BASE, roomId, ydoc, {
        params: { token: jwtToken || '', display_name: displayName },
      })
      providerRef.current = provider
    } catch (e) {
      console.error('[CollabPanel] WebSocketProvider falhou:', e)
      setStatus('error')
      // SEM ydoc montado, mas o MonacoBinding no onMount usa ytextRef
      // que setamos acima — então o editor AINDA funciona local.
    }

    if (provider) {
      provider.on('status', (evt: { status: 'connecting' | 'connected' | 'disconnected' }) => {
        if (!mounted) return
        if (evt.status === 'connected') {
          setStatus(isAuthenticated ? 'connected' : 'guest')
        } else {
          setStatus('connecting')
        }
      })

      provider.on('connection-close', (evt) => {
        if (!mounted) return
        // 4401 = JWT inválido/ausente (guest continua editando local)
        // 4429 = rate limit (raro, retry em 1s)
        // Outros = erro de rede (vai reconectar)
        if (evt?.code === 4401) {
          setStatus('guest')
        } else if (evt?.code === 4429) {
          setStatus('connecting') // continua tentando
        } else {
          setStatus('connecting')
        }
      })

      provider.on('sync', (synced: boolean) => {
        if (!mounted) return
        // sync OK — peer state chegou, CRDT mergeia automaticamente
      })

      // Welcome lista peers + snapshot inicial
      provider.awareness.on('change', () => {
        if (!mounted) return
        const states = Array.from(provider!.awareness.getStates().values()) as any[]
        setPeers(
          states
            .filter((s) => s?.user && s.user.display_name)
            .map((s) => ({ user_id: s.user.user_id, display_name: s.user.display_name }))
        )
      })
    }

    // Status inicial: se tem JWT vai tentar conectar, senão fica 'guest'
    // editando local (sem sync remoto até logar).
    if (!isAuthenticated) {
      setStatus('guest')
    } else if (provider) {
      setStatus('connecting')
    }

    return () => {
      mounted = false
      try {
        bindingRef.current?.destroy()
      } catch {}
      bindingRef.current = null
      try {
        provider?.destroy()
      } catch {}
      provider = null
      providerRef.current = null
      ydoc.destroy()
      ydocRef.current = null
      ytextRef.current = null
    }
  }, [roomId, jwtToken, isAuthenticated, displayName])

  // ── Bind Monaco ↔ Y.Text quando editor monta ─────────────────────────
  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    const ytext = ytextRef.current
    if (!ytext) return

    // Carrega rascunho do localStorage ANTES de criar binding (pra mostrar
    // primeiro). Yjs sync vai sobrescrever com state do peer em milissegundos.
    const saved = localStorage.getItem(LS_KEY(roomId))
    if (saved) {
      const len = ytext.length
      ytext.insert(0, saved)
      // marca como "saving-draft" pra remover depois se vier state do peer
      // (peer state vai aplicar updates sem conflitar com esse trecho)
      setTimeout(() => {
        // se o Yjs ainda não trouxe state maior, mantém o draft;
        // senão ele mesmo se funde via CRDT.
      }, 1500)
    }

    try {
      const binding = new MonacoBinding(
        ytext,
        editor.getModel()!,
        new Set([editor]),
        providerRef.current?.awareness
      )
      bindingRef.current = binding
    } catch (e) {
      console.warn('[CollabPanel] binding falhou:', e)
    }

    // Autosave rascunho (debounced 2s) — captura o que ESTE usuário escreveu,
    // mesmo que depois o peer traga updates adicionais.
    editor.onDidChangeModelContent(() => {
      if (saveTimeoutRef.current) window.clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = window.setTimeout(() => {
        const text = editor.getValue()
        try {
          if (text && text.length < 200_000) {
            localStorage.setItem(LS_KEY(roomId), text)
          }
        } catch {}
      }, 2000)
    })
  }

  // ── Mudar modo: troca language do Monaco, NÃO substitui conteúdo ─────
  const switchMode = (newMode: ModeId) => {
    setMode(newMode)
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel()
    if (!model) return
    const target = MODES.find((m) => m.id === newMode)?.monacoLang || 'plaintext'
    // Monaco detecta via URI; importMap precisa ser instanciado pelo editor
    // (default já tem python/javascript/php sem setup extra)
  }

  // ── Botão Rodar (Python/JS/PHP) ─────────────────────────────────────
  const runCode = async () => {
    const cfg = MODES.find((m) => m.id === mode)
    if (!cfg?.lang) return
    setRunning(true)
    setExecOut('')
    const code = editorRef.current?.getValue() || ''
    // mesma rota que DevPage usa
    const result = await fetchJson<{ stdout: string; stderr?: string; error?: string }>(
      '/leitor-inteligente/dev-api/exec',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: cfg.lang, code }),
      },
      30_000
    )
    setRunning(false)
    setExecTs(Date.now())
    if (!result.ok) {
      setExecOut(`❌ Erro (status ${result.status})${result.timedOut ? ' — timeout' : ''}\n${result.raw || result.error || ''}`)
      return
    }
    const out = [
      result.json?.stdout && `\`\`\`\n${result.json.stdout}\n\`\`\``,
      result.json?.stderr && `⚠ stderr:\n\`\`\`\n${result.json.stderr}\n\`\`\``,
      result.json?.error && `💥 ${result.json.error}`,
    ].filter(Boolean).join('\n\n')
    setExecOut(out || '(sem saída)')
  }

  // ── Convidar (gera URL ?room= e copia pro clipboard) ─────────────────
  // 04/09/2026: bug crítico no mobile — a versão antiga montava
  //   `${origin}${pathname}?room=...` que PERDIA o hash atual (#/reader/<slug>).
  // Ao abrir o link, o app caía na home/biblioteca em vez do livro.
  // Fix: preservar window.location.hash atual (sem query) e adicionar ?room= na frente.
  const invite = async () => {
    const hashBase = window.location.hash.split('?')[0] || ''
    const url = `${location.origin}${location.pathname}${hashBase}?room=${roomId}`
    const text = `Bora estudar comigo? Painel de Estudo em Dupla:\n${url}`
    try {
      await navigator.clipboard.writeText(text)
      setInviteCopied(true)
      setTimeout(() => setInviteCopied(false), 2000)
    } catch {
      prompt('Copie o link:', text)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────
  // 05/09/2026 Isaías: removida a barreira 🔒 Entre pra editar. Y.Doc é
  // local desde o primeiro paint e o MonacoBinding já usa readOnly:false,
  // então o guest SEMPRE pôde digitar no editor — só faltava renderizar.
  // Quando o WS rejeitar com 4401 (sem JWT), o provider fica disconnected
  // mas o Y.Doc local segue editável. Status 'guest' agora é só um banner
  // amarelo dizendo que sync remoto tá pausado até logar.
  return (
    <aside
      // 04/09/2026 mobile: `h-full` no mobile não funcionava porque o pai
      // (ReaderPage) tem altura limitada — Monaco renderizava esmagado.
      // Forçamos 100dvh (dynamic viewport) no mobile, com fallback 100vh.
      // Desktop (md+) usa h-full porque o aside é fixo na lateral.
      className="fixed right-0 top-0 h-[100dvh] md:h-full w-full md:w-[560px] bg-[#0F1B2D] text-[#F0E8D8] shadow-2xl z-50 flex flex-col"
      role="dialog"
      aria-label="Painel de Estudo Colaborativo"
    >
      <header
        // 06/09/2026 v9 Isaías: header unificado — ícone Users (lucide,
        // consistente com o botão gatilho redesenhado) + título truncado +
        // badge de status com texto explícito + ações 🔗✕ alinhadas à
        // direita. Antes tinha 👥 emoji + bolinha pequena só — info demais
        // escondida no tooltip. Agora mostra o status em texto.
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '12px 16px',
          borderBottom: '1px solid #1F2B3D',
          background: 'linear-gradient(180deg, #142840 0%, #0F1B2D 100%)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            borderRadius: 8,
            background: 'linear-gradient(135deg, #059669, #0891b2)',
            color: '#fff',
            shrink: 0,
          } as any}>
            <Users size={18} />
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 14, color: '#F0E8D8', lineHeight: '1.2' }}>
              Estudo em Dupla
            </span>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              color: status === 'connected' ? '#86efac' :
                     status === 'connecting' ? '#fde047' :
                     status === 'guest' ? '#fcd34d' :
                     '#fca5a5',
              lineHeight: '1.2',
            }}>
              <span style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: status === 'connected' ? '#4ade80' :
                            status === 'connecting' ? '#facc15' :
                            status === 'guest' ? '#fbbf24' :
                            '#f87171',
                animation: status === 'connecting' ? 'collab-pulse 1.2s ease-in-out infinite' : 'none',
              }} />
              {status === 'connected'
                ? `${peers.length + 1} online${peers.length > 0 ? ' · ' + peers.map(p => p.display_name).join(', ') : ''}`
                : status === 'connecting'
                ? 'conectando...'
                : status === 'guest'
                ? 'convidado · sem sync'
                : 'erro de conexão'}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <button
            onClick={invite}
            title="Copiar link da sala"
            aria-label="Copiar link da sala"
            style={{
              background: 'transparent',
              border: '1px solid #2F3B4D',
              color: '#F0E8D8',
              padding: '6px 10px',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 13,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#1F2B3D' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            {inviteCopied ? '✅ copiado' : '🔗 convidar'}
          </button>
          <button
            onClick={onClose}
            title="Fechar painel"
            aria-label="Fechar painel"
            style={{
              background: 'transparent',
              border: '1px solid #2F3B4D',
              color: '#F0E8D8',
              width: 32,
              height: 32,
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 16,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#1F2B3D' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            ✕
          </button>
        </div>
      </header>

      {status === 'guest' && (
        <div
          className="px-3 py-2 bg-amber-500/20 text-amber-200 text-xs border-b border-amber-500/30"
          role="status"
        >
          ✏️ Modo convidado: você pode digitar à vontade, mas suas edições ficam só
          no seu navegador. Faça login no Leitor pra sincronizar com o anfitrião em tempo real.
        </div>
      )}

      <div className="flex items-center gap-1 p-2 border-b border-[#1F2B3D] overflow-x-auto">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={`text-xs px-3 py-1 rounded-full whitespace-nowrap ${
              mode === m.id
                ? 'bg-[#E8A547] text-[#0F1B2D]'
                : 'bg-[#1F2B3D] text-[#F0E8D8] hover:bg-[#2F3B4D]'
            }`}
            onClick={() => switchMode(m.id)}
          >
            {m.label}
          </button>
        ))}
        <div className="ml-auto flex gap-1">
          {mode !== 'text' && (
            <button
              className="text-xs px-3 py-1 rounded-full bg-[#E8A547] text-[#0F1B2D] font-semibold disabled:opacity-50"
              onClick={runCode}
              disabled={running}
              title="Rodar no Piston (independe do sync da sala)"
            >
              {running ? '⏳ rodando…' : '▶️ Rodar'}
            </button>
          )}
        </div>
      </div>

      <div
        // 04/09/2026 mobile: o padrão `flex-1 min-h-0` falhava porque o pai
        // do CollabPanel (ReaderPage) tem altura limitada — Monaco abria
        // com 0px. Mesmo padrão da Sala Dev: altura fixa em pixels.
        // 320px = ~10 linhas visíveis, suficiente pra digitar sem zoom.
        className="overflow-hidden border-b border-[#1F2B3D]"
        style={{ height: '40vh', minHeight: '320px' }}
      >
        <Editor
          height="100%"
          defaultLanguage={monacoLang}
          language={monacoLang}
          theme="vs-dark"
          onMount={onMount}
          loading={<div className="p-4 text-sm opacity-70">⌛ carregando editor…</div>}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            // 04/09/2026 Isaías: editor SEMPRE editável, mesmo offline.
            // Y.Doc é local desde o primeiro paint — quando o WS conecta,
            // CRDT sincroniza o que já foi escrito sem perder nada.
            readOnly: false,
            // Autocomplete igual VS Code (igual Sala Dev usa)
            quickSuggestions: { other: true, comments: false, strings: true },
            suggestOnTriggerCharacters: true,
            tabCompletion: 'on',
          }}
        />
      </div>

      {execOut && (
        <div className="border-t border-[#1F2B3D] max-h-[30%] overflow-y-auto p-3 bg-black/40">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs opacity-70">Saída {new Date(execTs).toLocaleTimeString('pt-BR')}</span>
            <button className="text-xs opacity-70 hover:opacity-100" onClick={() => setExecOut('')}>limpar</button>
          </div>
          <pre className="text-xs whitespace-pre-wrap font-mono">{execOut}</pre>
        </div>
      )}
    </aside>
  )
}

// Helper exposto pra criar UUID de sala a partir do front
export function newRoomId(): string {
  return uuidv4().replace(/-/g, '').slice(0, 16)
}
