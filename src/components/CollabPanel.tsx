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
import { Users, Radio, Megaphone, X as XIcon } from 'lucide-react'
import { fetchJson } from '../lib/fetchJson'
import { BASE_URL } from '../lib/baseUrl'
import { openBroadcastHandle, dispatchPttActive, type BroadcastHandle } from '../lib/broadcast'
// v19.2: import do checkBroadcastAdmin não é necessário aqui — CollabPanel já
// tem isBroadcastAdmin resolvido via useEffect + supabase.auth.getUser() na
// linha 137. Só precisamos passar o state pra openBroadcastHandle().
import { pcmToBase64DataUrl } from '../lib/audioPcm'
import { supabase } from '../lib/supabase'

// 08/09/2026 v19.1 — Admin email fixo em hard-code (mesmo do backend
// ADMIN_EMAIL env). Isaías pediu pra checar via supabase.auth.getUser()
// em vez de parser JWT no front (mais seguro + sem parse custoso).
const ADMIN_EMAIL = 'brisacamera34@gmail.com'

interface CollabPanelProps {
  roomId: string
  displayName: string
  jwtToken: string
  isAuthenticated: boolean
  defaultMode?: 'text' | 'python' | 'javascript' | 'php'
  onClose: () => void
}

// URL do backend WS — produção via Nginx, dev via localhost
// 06/09/2026 v11: nginx do subdomínio novo (leitorinteligente.automacaojs.us)
// tem `location /ws/collab` (raiz) — não precisa mais de prefixo /leitor-inteligente/.
// BASE_URL é '/' em prod (raiz) e '/' em dev também (vite.config.ts base: '/').
const isDev = typeof window !== 'undefined' && window.location.port === '5173'
const WS_BASE = isDev
  ? 'ws://127.0.0.1:2006/collab'
  : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${BASE_URL}ws/collab`

// localStorage prefix consistente com o resto do app
const LS_KEY = (roomId: string) => `leitor-ia:room-${roomId}:draft`

// ── Rádio PX / Push-to-Talk ──────────────────────────────────────────────
// 06/09/2026 Isaías: áudio estilo walkie-talkie pra Estudo em Dupla.
// Cap 15s com auto-stop; Opus (webm) → webm → mp4 (Safari). Eco local
// (walkie-talkie real) + roger beep Web Audio API ~800Hz 50ms.
const PTT_MAX_MS = 15_000
const PTT_CODECS = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
] as const

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
  const [syncing, setSyncing] = useState(false)
  const [syncFlash, setSyncFlash] = useState<null | 'ok' | 'fail'>(null)
  // Rádio PX
  const [pttActive, setPttActive] = useState(false)
  const [pttPeerTalking, setPttPeerTalking] = useState<{ name: string; until: number } | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const pttStreamRef = useRef<MediaStream | null>(null)
  const pttTimeoutRef = useRef<number | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  // 07/09/2026 v15 — Estúdio de Transmissão (sala → Devocional 12 harbor 9035)
  const [onAir, setOnAir] = useState(false)
  const [onAirStarting, setOnAirStarting] = useState(false)
  const [onAirSeconds, setOnAirSeconds] = useState(0)
  const [isRoomHost, setIsRoomHost] = useState(false)
  const onAirRecorderRef = useRef<MediaRecorder | null>(null)
  const onAirStreamRef = useRef<MediaStream | null>(null)
  const onAirHandleRef = useRef<BroadcastHandle | null>(null)
  const onAirTickRef = useRef<number | null>(null)
  const onAirStartedAtRef = useRef<number>(0)
  // v18.1: AudioContext + ScriptProcessorNode (captura PCM direto, sem MediaRecorder)
  const onAirAudioCtxRef = useRef<AudioContext | null>(null)
  const onAirProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const onAirGainRef = useRef<GainNode | null>(null)
  // v18.2: mixerBus soma mic local + áudios remotos (ptt_audio dos convidados)
  const onAirMixerRef = useRef<GainNode | null>(null)

  // 08/09/2026 v19.1 — Trava admin via supabase.auth.getUser() ASYNC.
  // Isaías: parser JWT no front (atob) pode falhar/travar e quebrar render.
  // Default false, dispara useEffect separado que resolve em background
  // e atualiza o state. NÃO segura o mount do componente.
  const [isBroadcastAdmin, setIsBroadcastAdmin] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!isAuthenticated) {
      setIsBroadcastAdmin(false)
      return
    }
    ;(async () => {
      try {
        const { data, error } = await supabase.auth.getUser()
        if (cancelled) return
        if (error || !data?.user) {
          setIsBroadcastAdmin(false)
          return
        }
        const email = (data.user.email || '').toLowerCase()
        setIsBroadcastAdmin(email === ADMIN_EMAIL)
      } catch {
        if (!cancelled) setIsBroadcastAdmin(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isAuthenticated, jwtToken])

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

  // ── Listener de mensagens PTT no WS subjacente ─────────────────────────
  // y-websocket usa o WS pra binário Yjs (sync). Mensagens de texto JSON
  // (Rádio PX) chegam no mesmo socket — usamos addEventListener pra
  // escutar sem quebrar o listener interno do y-websocket. Tipos válidos:
  // ptt_audio (Blob Base64) + ptt_state (apenas avisa TX ativo/fim).
  useEffect(() => {
    const provider = providerRef.current
    const ws = provider?.ws as WebSocket | undefined
    if (!ws) return

    const onMessage = (evt: MessageEvent) => {
      // y-websocket cuida de binário; só nos importam strings
      if (typeof evt.data !== 'string') return
      let msg: { type?: string; sender?: string; audio?: string; until?: number; active?: boolean; state?: string }
      try {
        msg = JSON.parse(evt.data)
      } catch {
        return
      }
      if (msg.type === 'ptt_audio' && msg.audio) {
        // v18.2: se estúdio ON AIR, decodifica o chunk remoto e conecta no
        // mixerBus pra sair junto na rádio com o anfitrião. Caso contrário,
        // toca via <audio> normal (modo PTT sem estúdio).
        const studioCtx = onAirAudioCtxRef.current
        const mixer = onAirMixerRef.current
        if (studioCtx && mixer && msg.audio) {
          const audioUrl = msg.audio
          ;(async () => {
            try {
              const arr = await fetch(audioUrl).then(r => r.arrayBuffer())
              const audioBuf = await studioCtx.decodeAudioData(arr)
              const src = studioCtx.createBufferSource()
              src.buffer = audioBuf
              src.connect(mixer)
              src.start()
              console.log('[OnAirMix] convidado mixado:', msg.sender, audioBuf.duration.toFixed(2), 's')
            } catch (e) {
              console.warn('[OnAirMix] decode convidado falhou:', e)
            }
          })()
        } else {
          try {
            const audio = new Audio(msg.audio)
            audio.play().catch(() => { /* autoplay bloqueado — silencioso */ })
          } catch {}
        }
        // mostra indicador "📻 [nome] falando..." por até 3s (audio pode
        // acabar antes, mas enquanto toca é sinal claro)
        const durMs = Math.min(PTT_MAX_MS, 3000)
        setPttPeerTalking({ name: msg.sender || 'Alguém', until: Date.now() + durMs })
        setTimeout(() => setPttPeerTalking(null), durMs)
        // roger beep (Web Audio API — ~800Hz 50ms)
        try {
          playRogerBeep()
        } catch {}
      }
      // ptt_state (início/fim de TX) — usado pra ducking da rádio ambiente.
      if (msg.type === 'ptt_state') {
        const active = msg.active === true || msg.state === 'on' || msg.state === 'talking'
        dispatchPttActive(active, 'px')
      }
    }

    ws.addEventListener('message', onMessage)
    return () => ws.removeEventListener('message', onMessage)
  }, [status])

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

  // ── Sincronização manual (botão 🔄 + visibilitychange) ──────────────
  // 06/09/2026 Isaías: mobile + perda de foco às vezes deixava o Yjs
  // "stale" — usuário só via updates do peer depois de F5. Solução:
  // (a) botão 🔄 que re-conecta o WS e reatribui o value do Monaco do
  //     yText atual (sem recarregar a página);
  // (b) hook visibilitychange — ao voltar pro foreground, se o WS não
  //     tá OPEN ou synced, força reconexão automática.
  const manualSync = () => {
    const provider = providerRef.current
    const editor = editorRef.current
    const ytext = ytextRef.current
    if (!provider || syncing) return
    setSyncing(true)
    setSyncFlash(null)
    // 1) Força reconexão do WS — novo handshake, server envia sync-step-1
    //    e demais peers completam via fan-out.
    try {
      try { provider.disconnect() } catch {}
      try { provider.connect() } catch {}
    } catch (e) {
      console.warn('[sync] reconnect falhou:', e)
    }
    // 2) Reatribui value do Monaco do yText atual — cobre divergência
    //    local (mobile às vezes perde updates do Yjs após long sleep).
    //    Preserva posição de cursor.
    setTimeout(() => {
      try {
        if (editor && ytext) {
          const currentValue = editor.getValue()
          const ytextValue = ytext.toString()
          if (currentValue !== ytextValue) {
            const pos = editor.getPosition()
            editor.setValue(ytextValue)
            if (pos) editor.setPosition(pos)
          }
        }
      } catch (e) {
        console.warn('[sync] reatribuição falhou:', e)
      }
      setSyncing(false)
      setSyncFlash('ok')
      setTimeout(() => setSyncFlash(null), 1800)
    }, 600)
  }

  // ── Auto-recuperação no retorno de foco (mobile) ──────────────────────
  // Quando o app volta do background, o WS pode ter sido desconectado
  // silenciosamente (iOS suspende conexões após ~30s). Se detectar isso,
  // disparamos manualSync() automaticamente — sem F5.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      const provider = providerRef.current
      const ws = provider?.ws as WebSocket | undefined
      const isOpen = ws?.readyState === WebSocket.OPEN
      const wasGuest = status === 'guest'
      if (!provider || wasGuest) return
      if (!isOpen) {
        manualSync()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [status, syncing])

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
      `${BASE_URL}dev-api/exec`,
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

  // ── Rádio PX: handlers PTT ──────────────────────────────────────────────
  // MediaRecorder cap 15s, eco local (walkie-talkie real), Roger Beep
  // Web Audio API 800Hz/50ms, transporte via WS provider.ws (texto JSON).
  const pickPttMimeType = (): string => {
    if (typeof MediaRecorder === 'undefined') return ''
    for (const t of PTT_CODECS) {
      try {
        if (MediaRecorder.isTypeSupported(t)) return t
      } catch {}
    }
    return ''
  }

  const playRogerBeep = () => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)()
      }
      const ctx = audioCtxRef.current
      // resume se suspenso (iOS Safari exige gesture, mas pointerup já conta)
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = 800
      // envelope rápido: 0→1 em 5ms, sustain 40ms, 1→0 em 5ms
      const now = ctx.currentTime
      gain.gain.setValueAtTime(0, now)
      gain.gain.linearRampToValueAtTime(0.18, now + 0.005)
      gain.gain.setValueAtTime(0.18, now + 0.045)
      gain.gain.linearRampToValueAtTime(0, now + 0.05)
      osc.connect(gain).connect(ctx.destination)
      osc.start(now)
      osc.stop(now + 0.055)
    } catch {}
  }

  const pttStart = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    if (pttActive) return
    const provider = providerRef.current
    const ws = provider?.ws as WebSocket | undefined
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('[PTT] WS não conectado, fala descartada')
      return
    }
    const mimeType = pickPttMimeType()
    if (!mimeType) {
      console.warn('[PTT] nenhum codec de áudio suportado neste browser')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      pttStreamRef.current = stream
      const recorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = recorder
      const chunks: Blob[] = []
      recorder.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.push(ev.data) }
      recorder.onstop = async () => {
        // monta Blob e converte pra data: URL base64
        const blob = new Blob(chunks, { type: mimeType })
        const dataUrl: string = await new Promise((resolve, reject) => {
          const fr = new FileReader()
          fr.onload = () => resolve(fr.result as string)
          fr.onerror = () => reject(fr.error)
          fr.readAsDataURL(blob)
        })
        // eco local (walkie-talkie real — ouve o que transmitiu)
        try {
          const localAudio = new Audio(dataUrl)
          localAudio.play().catch(() => {})
        } catch {}
        // envia pros outros peers via WS subjacente
        try {
          ws.send(JSON.stringify({
            type: 'ptt_audio',
            sender: displayName,
            audio: dataUrl,
            timestamp: Date.now(),
          }))
        } catch (err) {
          console.warn('[PTT] send falhou:', err)
        }
        // libera microfone
        pttStreamRef.current?.getTracks().forEach(t => t.stop())
        pttStreamRef.current = null
        mediaRecorderRef.current = null
      }
      recorder.start()
      setPttActive(true)
      // 07/09/2026 v15: avisa AmbientRadioPlayer pra fazer ducking (fade 0.15→0.02)
      dispatchPttActive(true, 'px')
      // safety net: cap 15s
      if (pttTimeoutRef.current) window.clearTimeout(pttTimeoutRef.current)
      pttTimeoutRef.current = window.setTimeout(() => {
        pttStop()
      }, PTT_MAX_MS)
    } catch (err) {
      console.warn('[PTT] getUserMedia falhou:', err)
    }
  }

  const pttStop = (e?: React.SyntheticEvent) => {
    if (e) e.preventDefault()
    if (!pttActive) return
    if (pttTimeoutRef.current) {
      window.clearTimeout(pttTimeoutRef.current)
      pttTimeoutRef.current = null
    }
    try {
      mediaRecorderRef.current?.stop()
    } catch {}
    setPttActive(false)
    dispatchPttActive(false, 'px')
  }

  // ── Estúdio de Transmissão: handlers ON AIR ─────────────────────────────
  // 07/09/2026 v15: moderador da sala pode transmitir o áudio da sala direto
  // pra Devocional 12 (harbor 9035). Botão só aparece se isRoomHost.
  // Funcionamento: abre BroadcastHandle (WS extra pra sala _broadcast),
  // envia broadcast_state=on, captura microfone continuamente em chunks
  // de ~2s, manda como data URL base64 pelo mesmo WS. bridge_server.py
  // escreve no FIFO + spawna ffmpeg → icecast. Ao parar, broadcast_state=off
  // e bridge fecha ffmpeg em ~2s, AutoDJ retoma.
  const checkRoomHost = async () => {
    try {
      const r = await fetch(`${BASE_URL}ws/collab/${roomId}/status`, {
        headers: { 'Accept': 'application/json' },
      })
      if (!r.ok) return false
      const j = await r.json()
      // Extrai meu user_id do JWT (sub ou user_id claim)
      let myUID = ''
      try {
        const parts = (jwtToken || '').split('.')
        if (parts.length === 3) {
          const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
          myUID = payload?.sub || payload?.user_id || ''
        }
      } catch {}
      if (j?.host_user_id && myUID && j.host_user_id === myUID) return true
      return false
    } catch {
      return false
    }
  }

  useEffect(() => {
    if (!roomId || !isAuthenticated) {
      setIsRoomHost(false)
      return
    }
    let cancelled = false
    const check = async () => {
      const ok = await checkRoomHost()
      if (!cancelled) setIsRoomHost(ok)
    }
    check()
    // Re-checar a cada 30s — host pode mudar se o anterior sair e outro peer assumir
    const iv = window.setInterval(check, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(iv)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, isAuthenticated, jwtToken])

  const startOnAir = async () => {
    if (onAir || onAirStarting) return
    if (!isRoomHost) return
    // 08/09/2026 v19 — Trava admin: só transmite quem tiver email admin.
    // Defesa em profundidade (front + collab_server + bridge).
    if (!isBroadcastAdmin) {
      console.warn('[OnAir] start BLOQUEADO: sessão não-admin')
      return
    }
    setOnAirStarting(true)
    try {
      console.log('[OnAir] start: criando handle WS pra _broadcast')
      // 1. WS pro _broadcast (sala fantasma)
      // v19.2: passa isBroadcastAdmin (já resolvido via supabase.auth.getUser)
      // em vez de deixar broadcast.ts decodificar o JWT cru (que às vezes
      // não tem campo email e bloqueava admin indevidamente).
      const handle = openBroadcastHandle(jwtToken, displayName, isBroadcastAdmin)
      onAirHandleRef.current = handle
      console.log('[OnAir] aguardando WS abrir (wsReady)…')
      // 2. Espera WS estar OPEN antes de mandar setState. wsReady agora resolve
      // via onopen nativo (sem polling/evento do provider).
      await handle.wsReady()
      console.log('[OnAir] WS pronto após wsReady')
      // 3. Avisa o bridge: ON na sala <roomId>
      console.log('[OnAir] enviando broadcast_state=on room=', roomId)
      handle.setState('on', roomId, displayName, jwtToken)
      // 4. Pega microfone e começa a gravar continuamente em chunks ~2s
      console.log('[OnAir] pedindo getUserMedia (mic)…')
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      console.log('[OnAir] getUserMedia OK, tracks=', stream.getTracks().map(t => `${t.kind}:${t.label}`))
      onAirStreamRef.current = stream
      // v18.1: ScriptProcessorNode captura PCM direto da placa @ 16kHz mono.
      // Sem WebM, sem MediaRecorder, sem decodeAudioData. Chunks ~256ms
      // (4096 samples @ 16kHz). Bridge pré-acumula 6s antes de iniciar ffmpeg.
      const audioCtx = new AudioContext({ sampleRate: 16000 })
      onAirAudioCtxRef.current = audioCtx
      // v18.2: mixerBus soma mic local + áudios remotos dos convidados (ptt_audio).
      // Tudo que conecta nele é somado automaticamente (Web Audio soma no destino).
      const mixerBus = audioCtx.createGain()
      mixerBus.gain.value = 1
      onAirMixerRef.current = mixerBus
      const source = audioCtx.createMediaStreamSource(stream)
      source.connect(mixerBus)
      const processor = audioCtx.createScriptProcessor(4096, 1, 1)
      onAirProcessorRef.current = processor
      processor.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0)
        const int16 = new Int16Array(input.length)
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]))
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
        }
        const dataUrl = pcmToBase64DataUrl(int16.buffer)
        console.log('[BROADCAST] PCM chunk:', int16.length, 'samples (', int16.byteLength, 'B) s16le @16kHz')
        handle.sendAudio(dataUrl, displayName)
      }
      // mixerBus → processor.input → muteGain → destination (sem eco local).
      mixerBus.connect(processor)
      const gain = audioCtx.createGain()
      gain.gain.value = 0
      onAirGainRef.current = gain
      processor.connect(gain)
      gain.connect(audioCtx.destination)
      // 4. UI
      onAirStartedAtRef.current = Date.now()
      setOnAir(true)
      setOnAirStarting(false)
      setOnAirSeconds(0)
      // tick pra contador ON AIR
      if (onAirTickRef.current) window.clearInterval(onAirTickRef.current)
      onAirTickRef.current = window.setInterval(() => {
        setOnAirSeconds(Math.floor((Date.now() - onAirStartedAtRef.current) / 1000))
      }, 1000)
      // 5. Ducking: AmbientRadioPlayer abaixa volume enquanto estúdio tá no ar
      dispatchPttActive(true, 'studio')
    } catch (err) {
      console.warn('[OnAir] start falhou:', err)
      setOnAirStarting(false)
      // cleanup parcial se algo subiu
      try { onAirRecorderRef.current?.stop() } catch {}
      try { onAirProcessorRef.current?.disconnect() } catch {}
      try { onAirMixerRef.current?.disconnect() } catch {}
      try { onAirGainRef.current?.disconnect() } catch {}
      try { onAirAudioCtxRef.current?.close() } catch {}
      onAirProcessorRef.current = null
      onAirGainRef.current = null
      onAirAudioCtxRef.current = null
      onAirStreamRef.current?.getTracks().forEach(t => t.stop())
      onAirStreamRef.current = null
      onAirHandleRef.current?.close()
      onAirHandleRef.current = null
    }
  }

  const stopOnAir = () => {
    if (!onAir) return
    try { onAirRecorderRef.current?.stop() } catch {}
    // v18.1: cleanup AudioContext + ScriptProcessor + GainNode
    try { onAirProcessorRef.current?.disconnect() } catch {}
    try { onAirGainRef.current?.disconnect() } catch {}
    try { onAirAudioCtxRef.current?.close() } catch {}
    onAirProcessorRef.current = null
    onAirGainRef.current = null
    onAirAudioCtxRef.current = null
    onAirStreamRef.current?.getTracks().forEach(t => t.stop())
    onAirStreamRef.current = null
    onAirRecorderRef.current = null
    try {
      onAirHandleRef.current?.setState('off', roomId, displayName, jwtToken)
    } catch {}
    setTimeout(() => {
      onAirHandleRef.current?.close()
      onAirHandleRef.current = null
    }, 1500)  // dá tempo do bridge processar o "off"
    if (onAirTickRef.current) {
      window.clearInterval(onAirTickRef.current)
      onAirTickRef.current = null
    }
    setOnAir(false)
    setOnAirSeconds(0)
    dispatchPttActive(false, 'studio')
  }

  // cleanup do microfone se o componente desmontar mid-recording
  useEffect(() => {
    return () => {
      if (pttTimeoutRef.current) window.clearTimeout(pttTimeoutRef.current)
      pttStreamRef.current?.getTracks().forEach(t => t.stop())
      try { mediaRecorderRef.current?.stop() } catch {}
      // 07/09/2026 v15: cleanup do estúdio se painel fechar mid-broadcast
      if (onAirTickRef.current) window.clearInterval(onAirTickRef.current)
      try { onAirRecorderRef.current?.stop() } catch {}
      // v18.1: cleanup AudioContext
      try { onAirProcessorRef.current?.disconnect() } catch {}
      try { onAirMixerRef.current?.disconnect() } catch {}
      try { onAirGainRef.current?.disconnect() } catch {}
      try { onAirAudioCtxRef.current?.close() } catch {}
      onAirStreamRef.current?.getTracks().forEach(t => t.stop())
      try { onAirHandleRef.current?.close() } catch {}
      dispatchPttActive(false, 'studio')
    }
  }, [])

  // 07/09/2026 v15 — Awareness: publica "broadcasting" quando ON AIR, e
  // escuta peers pra mostrar badge global "NO AR NA WEB RÁDIO" pra todos.
  useEffect(() => {
    const provider = providerRef.current
    if (!provider) return
    if (onAir) {
      try { provider.awareness.setLocalStateField('broadcasting', { room_id: roomId, since: onAirStartedAtRef.current }) } catch {}
    } else {
      try { provider.awareness.setLocalStateField('broadcasting', null) } catch {}
    }
  }, [onAir, roomId])

  const [peerBroadcasting, setPeerBroadcasting] = useState<{ name: string; since: number } | null>(null)
  useEffect(() => {
    const provider = providerRef.current
    if (!provider) return
    const onAwareness = () => {
      const states = Array.from(provider.awareness.getStates().values()) as any[]
      const me = provider.awareness.clientID
      const broadcaster = states.find((s) => s?.user && s?.broadcasting && s?.user?.client_id !== me)
      if (broadcaster) {
        setPeerBroadcasting({ name: broadcaster.user?.display_name || 'Anfitrião', since: broadcaster.broadcasting.since || Date.now() })
      } else {
        setPeerBroadcasting(null)
      }
    }
    provider.awareness.on('change', onAwareness)
    onAwareness()
    return () => provider.awareness.off('change', onAwareness)
  }, [status])

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
          {/* Sync Manual (06/09/2026 Isaías): força reconexão Yjs + reatribui
              yText no Monaco. Resolve o caso mobile/perda de foco em que o
              WS fica "stale" e o usuário só vê updates do peer depois de F5.
              Feedback: ícone gira 600ms + badge verde "Sincronizado!" 1.8s. */}
          <button
            onClick={manualSync}
            title="Forçar sincronização (reconecta WS e reatribui texto do editor)"
            aria-label="Sincronizar manualmente o documento colaborativo"
            disabled={syncing || status === 'guest'}
            style={{
              background: syncFlash === 'ok' ? '#16a34a' : 'transparent',
              border: syncFlash === 'ok' ? '1px solid #22c55e' : '1px solid #2F3B4D',
              color: syncFlash === 'ok' ? '#fff' : '#F0E8D8',
              padding: '6px 10px',
              borderRadius: 8,
              cursor: syncing ? 'wait' : 'pointer',
              fontSize: 13,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              transition: 'background 0.2s, border-color 0.2s',
              opacity: status === 'guest' ? 0.4 : 1,
            }}
            onMouseEnter={(e) => {
              if (syncing || syncFlash === 'ok') return
              e.currentTarget.style.background = '#1F2B3D'
            }}
            onMouseLeave={(e) => {
              if (syncFlash === 'ok') return
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <span style={{
              display: 'inline-block',
              transition: 'transform 0.6s ease',
              transform: syncing ? 'rotate(360deg)' : 'rotate(0deg)',
            }}>🔄</span>
            {syncFlash === 'ok' ? 'Sincronizado!' : 'Sincronizar'}
          </button>
          {/* Rádio PX: botão PTT — segura pra falar estilo walkie-talkie.
              Estado normal: ícone Radio + "PX". Segurando: vermelho pulsando. */}
          <button
            onPointerDown={pttStart}
            onPointerUp={pttStop}
            onPointerLeave={pttStop}
            onPointerCancel={pttStop}
            onContextMenu={(e) => e.preventDefault()}
            title={pttActive ? 'Transmitindo… solte pra encerrar' : 'Segure pra falar no Rádio PX (15s máx)'}
            aria-label={pttActive ? 'Transmitindo no Rádio PX' : 'Segure para falar no Rádio PX'}
            style={{
              background: pttActive ? '#dc2626' : 'transparent',
              border: pttActive ? '1px solid #ef4444' : '1px solid #2F3B4D',
              color: pttActive ? '#fff' : '#F0E8D8',
              padding: '6px 10px',
              borderRadius: 8,
              cursor: pttActive ? 'wait' : 'pointer',
              fontSize: 13,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              transition: 'background 0.15s, border-color 0.15s',
              animation: pttActive ? 'ptt-pulse 0.8s ease-in-out infinite' : 'none',
              userSelect: 'none',
              touchAction: 'none',
            }}
            onMouseEnter={(e) => { if (!pttActive) e.currentTarget.style.background = '#1F2B3D' }}
            onMouseLeave={(e) => { if (!pttActive) e.currentTarget.style.background = 'transparent' }}
          >
            <Radio size={14} />
            {pttActive ? 'Transmitindo…' : 'PX'}
          </button>
          {/* 07/09/2026 v15 — Botão Estúdio de Transmissão: injeta o áudio
              da sala direto na Devocional 12 (harbor 9035). Visível SÓ pro
              anfitrião (isRoomHost) E pra admin (isBroadcastAdmin).
              08/09/2026 v19 trava: a sala `_broadcast` (que injeta no Harbor)
              é restrita por email no JWT. Convidados não vêm nem o botão.
              PTT (Rádio PX) permanece liberado. */}
          {isAuthenticated && isBroadcastAdmin && (
            <button
              onClick={onAir ? stopOnAir : startOnAir}
              disabled={onAirStarting || !isRoomHost}
              title={
                !isRoomHost
                  ? 'Só o anfitrião da sala pode transmitir'
                  : !isBroadcastAdmin
                  ? 'Só o admin (você não tem permissão) pode transmitir'
                  : onAir
                  ? 'Clique pra encerrar a transmissão (Icecast volta pro AutoDJ em ~2s)'
                  : 'Injetar áudio da sala na Devocional 12 — Devocional 12'
              }
              aria-label={onAir ? 'Encerrar transmissão ao vivo' : 'Transmitir sala ao vivo na Web Rádio Devocional 12'}
              style={{
                background: onAir ? '#dc2626' : (!isRoomHost ? 'transparent' : 'transparent'),
                border: onAir ? '1px solid #ef4444' : '1px solid #E8A547',
                color: onAir ? '#fff' : (!isRoomHost ? '#666' : '#E8A547'),
                padding: '6px 10px',
                borderRadius: 8,
                cursor: onAirStarting ? 'wait' : (isRoomHost ? 'pointer' : 'not-allowed'),
                fontSize: 13,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                transition: 'background 0.15s, border-color 0.15s',
                animation: onAir ? 'ptt-pulse 0.8s ease-in-out infinite' : 'none',
                opacity: (!isRoomHost && !onAir) ? 0.5 : 1,
              }}
              onMouseEnter={(e) => {
                if (onAir || onAirStarting) return
                if (isRoomHost) e.currentTarget.style.background = '#1F2B3D'
              }}
              onMouseLeave={(e) => {
                if (onAir || onAirStarting) return
                e.currentTarget.style.background = 'transparent'
              }}
            >
              <Megaphone size={14} />
              {onAir
                ? `NO AR · ${Math.floor(onAirSeconds / 60).toString().padStart(2, '0')}:${(onAirSeconds % 60).toString().padStart(2, '0')}`
                : onAirStarting
                ? 'conectando…'
                : 'Transmitir'}
            </button>
          )}
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

      {/* 07/09/2026 v15 — Badge global: aparece pra todos (exceto o próprio
          host que está transmitindo) quando o anfitrião ligou o estúdio.
          Awareness propaga via Yjs. */}
      {peerBroadcasting && !onAir && (
        <div
          className="px-3 py-2 bg-red-600/30 text-red-100 text-xs border-b border-red-500/50 flex items-center gap-2"
          role="status"
          aria-live="polite"
          style={{ animation: 'ptt-pulse 1.6s ease-in-out infinite' }}
        >
          <Megaphone size={14} />
          <span>
            🔴 <strong>NO AR NA WEB RÁDIO</strong> — {peerBroadcasting.name} está transmitindo esta sala ao vivo na{' '}
            <strong>Devocional 12</strong>
          </span>
        </div>
      )}

      {/* Indicador PTT remoto: aparece enquanto peer tá transmitindo */}
      {pttPeerTalking && (
        <div
          className="px-3 py-2 bg-red-500/20 text-red-200 text-xs border-b border-red-500/30 flex items-center gap-2"
          role="status"
          aria-live="polite"
        >
          <Radio size={14} className="animate-pulse" />
          <span>📻 <strong>{pttPeerTalking.name}</strong> falando no rádio…</span>
        </div>
      )}

      {/* Keyframes pra pulsação do botão PTT (vermelho on-air) */}
      <style>{`
        @keyframes ptt-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.6); }
          50% { box-shadow: 0 0 0 6px rgba(220, 38, 38, 0); }
        }
      `}</style>

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
