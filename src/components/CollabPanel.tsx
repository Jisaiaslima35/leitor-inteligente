// Painel de Estudo Colaborativo em Tempo Real
// Atualizado em 22/09/2026 — Sala de Aula Interativa v3 (awareness estendido +
// popover de participantes mostra página e score por aluno)
//
// Stack: Yjs (CRDT) + y-websocket (sync) + y-monaco (binding pro Monaco) + Supabase (snapshots).
// Backend relay em `api/collab_server.py:2006` faz fan-out binário e PTT.

import { useEffect, useMemo, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { MonacoBinding } from 'y-monaco'
import { v4 as uuidv4 } from 'uuid'
import { Users, Radio, Megaphone, X as XIcon, ChevronDown, Check, RefreshCw, Link as LinkIcon } from 'lucide-react'
import { fetchJson } from '../lib/fetchJson'
import { BASE_URL } from '../lib/baseUrl'
import { openBroadcastHandle, dispatchPttActive, type BroadcastHandle } from '../lib/broadcast'
import { pcmToBase64DataUrl } from '../lib/audioPcm'
import { supabase } from '../lib/supabase'
import { getLocalQuizScore } from '../lib/quizScore'
import { useTenant } from '../lib/tenant'

const ADMIN_EMAILS = ['brisacamera34@gmail.com', 'geminijose356@gmail.com']

interface CollabPanelProps {
  roomId: string
  displayName: string
  jwtToken: string
  isAuthenticated: boolean
  defaultMode?: 'text' | 'python' | 'javascript' | 'php'
  // 22/09/2026 — Sala de Aula Interativa: awareness carrega página atual + score
  currentPage?: number
  bookSlug?: string
  bookTitle?: string
  tenantId?: string
  chapterTitle?: string
  pageStart?: number
  pageEnd?: number
  pageRange?: string
  onScopeSync?: (scope: { pageStart: number; pageEnd: number; pageRange: string }) => void
  onChapterSync?: (chapterTitle: string) => void
  onHostStatusChange?: (isHost: boolean) => void
  onClose: () => void
}

export interface CollabPeer {
  clientID: number
  user_id: string
  name: string
  color: string
  isHost: boolean
  isSpeaking: boolean
  // Sala de Aula Interativa — consciência de turma
  currentPage?: number
  currentScore?: number
  lastQuizScore?: number
}

// URL do backend WS — produção via Nginx, dev via localhost
const isDev = typeof window !== 'undefined' && window.location.port === '5173'
const WS_BASE = isDev
  ? 'ws://127.0.0.1:2006/collab'
  : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${BASE_URL}ws/collab`

const LS_KEY = (roomId: string) => `leitor-ia:room-${roomId}:draft`

const PALETTE = [
  '#f59e0b', // amber
  '#10b981', // emerald
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
  '#14b8a6', // teal
  '#6366f1', // indigo
  '#e11d48', // rose
]

const ANIMAL_NAMES = ['Raposa', 'Falcão', 'Coruja', 'Lobo', 'Águia', 'Leão', 'Tigre', 'Panda', 'Lince', 'Gavião']

function getGuestAlias(roomId: string): string {
  const key = `leitor-ia:guest-alias:${roomId}`
  try {
    const existing = sessionStorage.getItem(key)
    if (existing) return existing
    const randomAnimal = ANIMAL_NAMES[Math.floor(Math.random() * ANIMAL_NAMES.length)]
    const num = Math.floor(Math.random() * 90) + 10
    const alias = `Estudante ${randomAnimal} ${num}`
    sessionStorage.setItem(key, alias)
    return alias
  } catch {
    return 'Estudante Convidado'
  }
}

function getUserColor(identifier: string): string {
  let hash = 0
  for (let i = 0; i < identifier.length; i++) {
    hash = (hash << 5) - hash + identifier.charCodeAt(i)
    hash |= 0
  }
  const idx = Math.abs(hash) % PALETTE.length
  return PALETTE[idx]
}

function updateCursorStyles(peerList: Array<{ clientID: number; name: string; color: string }>) {
  if (typeof document === 'undefined') return
  let styleEl = document.getElementById('y-monaco-cursor-styles') as HTMLStyleElement | null
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'y-monaco-cursor-styles'
    document.head.appendChild(styleEl)
  }

  const rules = peerList
    .map((p) => {
      const safeName = (p.name || 'Estudante').replace(/['"\\]/g, '')
      const color = p.color || '#3b82f6'
      return `
      .yRemoteSelection-${p.clientID} {
        background-color: ${color}33 !important;
      }
      .yRemoteSelectionHead-${p.clientID} {
        position: absolute;
        border-left: 2px solid ${color} !important;
        border-top: 2px solid ${color} !important;
        border-bottom: 2px solid ${color} !important;
        height: 100%;
        box-sizing: border-box;
      }
      .yRemoteSelectionHead-${p.clientID}::after {
        content: '${safeName}';
        position: absolute;
        top: -18px;
        left: -2px;
        background-color: ${color};
        color: #ffffff;
        font-size: 10px;
        font-weight: 600;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        padding: 1px 5px;
        border-radius: 3px 3px 3px 0;
        white-space: nowrap;
        pointer-events: none;
        z-index: 100;
        opacity: 0.95;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      }
    `
    })
    .join('\n')

  styleEl.textContent = rules
}

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
  currentPage,
  bookSlug,
  bookTitle,
  tenantId,
  chapterTitle,
  pageStart,
  pageEnd,
  pageRange,
  onScopeSync,
  onChapterSync,
  onHostStatusChange,
  onClose,
}: CollabPanelProps) {
  const { tenant } = useTenant()
  const editorRef = useRef<any>(null)
  const monacoWrapRef = useRef<HTMLDivElement | null>(null)
  const ydocRef = useRef<Y.Doc | null>(null)
  const ytextRef = useRef<Y.Text | null>(null)
  const ymetaRef = useRef<Y.Map<any> | null>(null)
  const providerRef = useRef<WebsocketProvider | null>(null)
  const bindingRef = useRef<MonacoBinding | null>(null)
  const saveTimeoutRef = useRef<number | null>(null)
  const debouncedSnapshotRef = useRef<number | null>(null)
  const participantsRef = useRef<HTMLDivElement | null>(null)

  const [mode, setMode] = useState<ModeId>(defaultMode)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'guest' | 'error'>('connecting')
  const [peers, setPeers] = useState<{ user_id: string; display_name: string }[]>([])
  const [collabPeers, setCollabPeers] = useState<CollabPeer[]>([])
  const [showParticipants, setShowParticipants] = useState(false)

  // Resolução de Nome amigável e Cor
  const [resolvedName, setResolvedName] = useState<string>(() => {
    if (displayName && displayName !== 'Convidado' && displayName !== 'Anônimo') {
      return displayName
    }
    return getGuestAlias(roomId)
  })
  const myColor = useMemo(() => getUserColor(resolvedName || roomId), [resolvedName, roomId])

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

  // Estúdio de Transmissão
  const [onAir, setOnAir] = useState(false)
  const [onAirStarting, setOnAirStarting] = useState(false)
  const [onAirSeconds, setOnAirSeconds] = useState(0)
  const [isRoomHost, setIsRoomHost] = useState(false)
  const onAirRecorderRef = useRef<MediaRecorder | null>(null)
  const onAirStreamRef = useRef<MediaStream | null>(null)
  const onAirHandleRef = useRef<BroadcastHandle | null>(null)
  const onAirTickRef = useRef<number | null>(null)
  const onAirStartedAtRef = useRef<number>(0)
  const onAirAudioCtxRef = useRef<AudioContext | null>(null)
  const onAirProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const onAirGainRef = useRef<GainNode | null>(null)
  const onAirMixerRef = useRef<GainNode | null>(null)

  const [isBroadcastAdmin, setIsBroadcastAdmin] = useState(false)

  // 22/09/2026 — Sala de Aula Interativa: placar atual do usuário (do localStorage do livro)
  const [currentScore, setCurrentScore] = useState<number>(() => {
    if (!bookSlug) return 0
    return getLocalQuizScore(bookSlug).totalPoints
  })
  const lastQuizScoreRef = useRef<number>(0)

  // Atualiza currentScore sempre que bookSlug muda ou o score local muda
  useEffect(() => {
    if (!bookSlug) return
    const refresh = () => setCurrentScore(getLocalQuizScore(bookSlug).totalPoints)
    refresh()
    const onStorage = (e: StorageEvent) => {
      if (e.key === `quiz_score_${bookSlug}`) refresh()
    }
    window.addEventListener('storage', onStorage)
    // poll leve (2s) pra capturar mudanças feitas na MESMA aba (storage event não dispara lá)
    const iv = window.setInterval(refresh, 2000)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.clearInterval(iv)
    }
  }, [bookSlug])

  // Resolve nome do usuário autenticado via Supabase
  useEffect(() => {
    if (!isAuthenticated) return
    let active = true
    supabase.auth.getUser().then(({ data }) => {
      if (!active || !data?.user) return
      const u = data.user
      const realName =
        u.user_metadata?.name ||
        u.user_metadata?.full_name ||
        u.email?.split('@')[0]
      if (realName && (!displayName || displayName === 'Convidado' || displayName === 'Anônimo')) {
        setResolvedName(realName)
      }
    }).catch(() => {})
    return () => {
      active = false
    }
  }, [isAuthenticated, displayName])

  // Verificação de Admin de Transmissão da Web Rádio
  useEffect(() => {
    let cancelled = false
    if (!isAuthenticated) {
      setIsBroadcastAdmin(false)
      return
    }

    const isRadio =
      (tenant as any)?.type === 'radio' ||
      tenant?.edition === 'radio_embed' ||
      tenant?.slug?.toLowerCase().startsWith('radio') ||
      tenant?.slug === 'radio-devocional-12'

    // Botão de transmissão EXCLUSIVO para tenants de rádio
    if (!isRadio) {
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
        const email = (data.user.email || '').toLowerCase().trim()
        const meta = data.user.user_metadata || {}
        const metaEmail = (meta.email || '').toString().toLowerCase().trim()

        const isWhitelisted =
          ADMIN_EMAILS.includes(email) ||
          ADMIN_EMAILS.includes(metaEmail) ||
          email.includes('brisacamera34') ||
          email.includes('geminijose356')

        if (isWhitelisted) {
          setIsBroadcastAdmin(true)
          return
        }

        // Checagem de Dono do Tenant
        if (tenant?.owner_user_id && tenant.owner_user_id === data.user.id) {
          setIsBroadcastAdmin(true)
          return
        }

        // Checagem de role owner ou admin no tenant
        if (tenant?.id) {
          const { data: member } = await supabase
            .from('user_tenants')
            .select('role')
            .eq('user_id', data.user.id)
            .eq('tenant_id', tenant.id)
            .maybeSingle()

          if (member && (member.role === 'owner' || member.role === 'admin')) {
            setIsBroadcastAdmin(true)
            return
          }
        }

        setIsBroadcastAdmin(false)
      } catch {
        if (!cancelled) setIsBroadcastAdmin(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isAuthenticated, tenant?.id, tenant?.slug, tenant?.edition, tenant?.owner_user_id])

  const monacoLang = MODES.find((m) => m.id === mode)?.monacoLang || 'plaintext'

  // Fechar popover de participantes ao clicar fora
  useEffect(() => {
    if (!showParticipants) return
    const handleClickOutside = (ev: MouseEvent) => {
      if (participantsRef.current && !participantsRef.current.contains(ev.target as Node)) {
        setShowParticipants(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showParticipants])

  // ── Snapshot Supabase: Cold-start Recovery ──────────────────────────────
  useEffect(() => {
    if (!roomId) return
    let active = true
    ;(async () => {
      try {
        const { data, error } = await supabase
          .from('collab_snapshots')
          .select('content, mode')
          .eq('room_id', roomId)
          .single()
        if (!active) return
        if (!error && data && data.content) {
          const ytext = ytextRef.current
          if (ytext && ytext.length === 0) {
            ytext.insert(0, data.content)
            console.log('[Collab] Snapshot recuperado do Supabase, tamanho:', data.content.length)
          }
          if (data.mode && MODES.some((m) => m.id === data.mode)) {
            setMode(data.mode as ModeId)
          }
        }
      } catch (e) {
        console.warn('[Collab] Falha ao recuperar snapshot Supabase:', e)
      }
    })()
    return () => {
      active = false
    }
  }, [roomId])

  // ── Autosave debounced para Supabase (5s) ───────────────────────────────
  const persistSnapshotToSupabase = (content: string, currentMode: string) => {
    if (!roomId || !content) return
    if (debouncedSnapshotRef.current) {
      window.clearTimeout(debouncedSnapshotRef.current)
    }
    debouncedSnapshotRef.current = window.setTimeout(async () => {
      try {
        await supabase.from('collab_snapshots').upsert(
          {
            room_id: roomId,
            content,
            mode: currentMode,
            updated_at: new Date().toISOString(),
            peer_count: collabPeers.length + 1,
          },
          { onConflict: 'room_id' }
        )
      } catch (err) {
        console.warn('[Collab] Erro ao salvar snapshot no Supabase:', err)
      }
    }, 5000)
  }

  // ── Conexão Yjs + WebSocketProvider + Awareness ─────────────────────────
  useEffect(() => {
    if (!roomId) return

    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    const ymeta = ydoc.getMap('room-meta')
    ydocRef.current = ydoc
    ytextRef.current = ytext
    ymetaRef.current = ymeta

    const handleMetaObserver = () => {
      const pStart = ymeta.get('pageStart') as number | undefined
      const pEnd = ymeta.get('pageEnd') as number | undefined
      const pRange = ymeta.get('pageRange') as string | undefined
      if (pStart && pEnd && onScopeSync) {
        onScopeSync({
          pageStart: pStart,
          pageEnd: pEnd,
          pageRange: pRange || `Páginas ${pStart} a ${pEnd}`,
        })
      }
      const cap = ymeta.get('chapterTitle') as string | undefined
      if (cap && onChapterSync) {
        onChapterSync(cap)
      }
    }
    ymeta.observe(handleMetaObserver)

    const initialPStart = ymeta.get('pageStart') as number | undefined
    const initialPEnd = ymeta.get('pageEnd') as number | undefined
    const initialPRange = ymeta.get('pageRange') as string | undefined
    if (initialPStart && initialPEnd && onScopeSync) {
      onScopeSync({
        pageStart: initialPStart,
        pageEnd: initialPEnd,
        pageRange: initialPRange || `Páginas ${initialPStart} a ${initialPEnd}`,
      })
    }

    const initialCap = ymeta.get('chapterTitle') as string | undefined
    if (initialCap && onChapterSync) {
      onChapterSync(initialCap)
    }

    let mounted = true
    let provider: WebsocketProvider | null = null

    try {
      provider = new WebsocketProvider(WS_BASE, roomId, ydoc, {
        params: {
          token: jwtToken || '',
          display_name: resolvedName,
          book_slug: bookSlug || '',
          book_title: bookTitle || '',
          page: String(currentPage || 1),
          tenant_id: tenantId || tenant?.id || '',
        },
        resyncInterval: 15000,
        maxBackoffTime: 4000,
        shouldReconnect: (event) => {
          if (event.code === 4403) return false
          if (event.code === 4401 && !jwtToken) return false
          return true
        },
      })
      providerRef.current = provider
    } catch (e) {
      console.error('[CollabPanel] WebSocketProvider falhou:', e)
      setStatus('error')
    }

    if (provider) {
      const myId = provider.awareness.clientID
      provider.awareness.setLocalStateField('user', {
        user_id: jwtToken ? 'auth-user' : `guest-${myId}`,
        name: resolvedName,
        display_name: resolvedName,
        color: myColor,
        isHost: isRoomHost,
        isSpeaking: pttActive,
        // 22/09/2026 — Sala de Aula Interativa
        currentPage: typeof currentPage === 'number' ? currentPage : null,
        currentScore: typeof currentScore === 'number' ? currentScore : 0,
        lastQuizScore: lastQuizScoreRef.current,
      })

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
        if (evt?.code === 4401) {
          setStatus('guest')
        } else {
          setStatus('connecting')
        }
      })

      provider.awareness.on('change', () => {
        if (!mounted) return
        const states = Array.from(provider!.awareness.getStates().entries())
        const myClientId = provider!.awareness.clientID
        const activePeers: CollabPeer[] = []

        states.forEach(([cid, s]: [number, any]) => {
          if (cid !== myClientId && s?.user) {
            activePeers.push({
              clientID: cid,
              user_id: s.user.user_id || `peer-${cid}`,
              name: s.user.name || s.user.display_name || 'Estudante',
              color: s.user.color || PALETTE[cid % PALETTE.length],
              isHost: Boolean(s.user.isHost),
              isSpeaking: Boolean(s.user.isSpeaking),
              currentPage: typeof s.user.currentPage === 'number' ? s.user.currentPage : undefined,
              currentScore: typeof s.user.currentScore === 'number' ? s.user.currentScore : undefined,
              lastQuizScore: typeof s.user.lastQuizScore === 'number' ? s.user.lastQuizScore : undefined,
            })
          }
        })

        setCollabPeers(activePeers)
        setPeers(activePeers.map((p) => ({ user_id: p.user_id, display_name: p.name })))
        updateCursorStyles(activePeers)
      })
    }

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
      try {
        ymeta.unobserve(handleMetaObserver)
      } catch {}
      ymetaRef.current = null
      ydoc.destroy()
      ydocRef.current = null
      ytextRef.current = null

      const styleEl = document.getElementById('y-monaco-cursor-styles')
      if (styleEl) styleEl.remove()
    }
  }, [roomId, jwtToken, isAuthenticated, resolvedName, myColor])

  // Sincronização centralizada do escopo de páginas pelo Tutor/Host
  useEffect(() => {
    if (isRoomHost && pageStart && pageEnd && ymetaRef.current) {
      if (ymetaRef.current.get('pageStart') !== pageStart) {
        ymetaRef.current.set('pageStart', pageStart)
      }
      if (ymetaRef.current.get('pageEnd') !== pageEnd) {
        ymetaRef.current.set('pageEnd', pageEnd)
      }
      const pStr = pageRange || `Páginas ${pageStart} a ${pageEnd}`
      if (ymetaRef.current.get('pageRange') !== pStr) {
        ymetaRef.current.set('pageRange', pStr)
      }
    }
    if (isRoomHost && chapterTitle && ymetaRef.current) {
      const current = ymetaRef.current.get('chapterTitle')
      if (current !== chapterTitle) {
        ymetaRef.current.set('chapterTitle', chapterTitle)
      }
    }
  }, [isRoomHost, pageStart, pageEnd, pageRange, chapterTitle])

  // Notifica o ReaderPage quando o status de anfitrião/tutor mudar
  useEffect(() => {
    onHostStatusChange?.(isRoomHost)
  }, [isRoomHost, onHostStatusChange])

  useEffect(() => {
    const provider = providerRef.current
    if (!provider) return
    const current = provider.awareness.getLocalState()?.user || {}
    provider.awareness.setLocalStateField('user', {
      ...current,
      name: resolvedName,
      display_name: resolvedName,
      color: myColor,
      isSpeaking: pttActive,
      isHost: isRoomHost,
    })
  }, [pttActive, isRoomHost, resolvedName, myColor])

  // 22/09/2026 — Sala de Aula Interativa: propaga currentPage + currentScore
  // sempre que o ReaderPage informa mudança de página ou o score local muda.
  useEffect(() => {
    const provider = providerRef.current
    if (!provider) return
    const current = provider.awareness.getLocalState()?.user || {}
    provider.awareness.setLocalStateField('user', {
      ...current,
      currentPage: typeof currentPage === 'number' ? currentPage : null,
      currentScore: typeof currentScore === 'number' ? currentScore : 0,
      lastQuizScore: lastQuizScoreRef.current,
    })

    try {
      const ws = provider.ws as WebSocket | undefined
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'state_update',
          page: typeof currentPage === 'number' ? currentPage : 1,
          score: typeof currentScore === 'number' ? currentScore : 0,
          book_title: bookTitle,
          book_id: bookSlug,
        }))
      }
    } catch {}
  }, [currentPage, currentScore, bookTitle, bookSlug])

  // ── Reconexão Silenciosa (Mobile / Foco / Online) ────────────────────────
  useEffect(() => {
    const handleWakeup = () => {
      const provider = providerRef.current
      if (!provider) return
      const ws = provider.ws as WebSocket | undefined
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.log('[Collab] Reconectando WS pós suspensão/online...')
        try {
          provider.connect()
        } catch {}
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') handleWakeup()
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', handleWakeup)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', handleWakeup)
    }
  }, [])

  // ── Listener de mensagens PTT no WS subjacente ─────────────────────────
  useEffect(() => {
    const provider = providerRef.current
    const ws = provider?.ws as WebSocket | undefined
    if (!ws) return

    const onMessage = (evt: MessageEvent) => {
      if (typeof evt.data !== 'string') return
      let msg: { type?: string; sender?: string; audio?: string; until?: number; active?: boolean; state?: string }
      try {
        msg = JSON.parse(evt.data)
      } catch {
        return
      }

      if (msg.type === 'ptt_audio' && msg.audio) {
        const studioCtx = onAirAudioCtxRef.current
        const mixer = onAirMixerRef.current
        if (studioCtx && mixer && msg.audio) {
          const audioUrl = msg.audio
          ;(async () => {
            try {
              const arr = await fetch(audioUrl).then((r) => r.arrayBuffer())
              const audioBuf = await studioCtx.decodeAudioData(arr)
              const src = studioCtx.createBufferSource()
              src.buffer = audioBuf
              src.connect(mixer)
              src.start()
            } catch (e) {
              console.warn('[OnAirMix] decode convidado falhou:', e)
            }
          })()
        } else {
          try {
            const audio = new Audio(msg.audio)
            audio.play().catch(() => {})
          } catch {}
        }
        const durMs = Math.min(PTT_MAX_MS, 3000)
        setPttPeerTalking({ name: msg.sender || 'Alguém', until: Date.now() + durMs })
        setTimeout(() => setPttPeerTalking(null), durMs)
        try {
          playRogerBeep()
        } catch {}
      }

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

    const saved = localStorage.getItem(LS_KEY(roomId))
    if (saved && ytext.length === 0) {
      ytext.insert(0, saved)
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

    // Autosave rascunho local + Supabase debounced
    editor.onDidChangeModelContent(() => {
      const text = editor.getValue()
      if (saveTimeoutRef.current) window.clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = window.setTimeout(() => {
        try {
          if (text && text.length < 200_000) {
            localStorage.setItem(LS_KEY(roomId), text)
          }
        } catch {}
      }, 2000)

      persistSnapshotToSupabase(text, mode)
    })

    // Layout imediato e pós-renderização do Monaco
    setTimeout(() => {
      try { editor.layout() } catch {}
    }, 50)
    setTimeout(() => {
      try { editor.layout() } catch {}
    }, 300)
  }

  // ── Reajuste dinâmico de dimensões do Monaco Editor (editor.layout()) ──
  useEffect(() => {
    const handleLayout = () => {
      if (editorRef.current) {
        try {
          editorRef.current.layout()
        } catch {}
      }
    }

    window.addEventListener('resize', handleLayout)
    window.addEventListener('scroll', handleLayout, { passive: true })

    let observer: ResizeObserver | null = null
    const wrap = monacoWrapRef.current
    if (wrap && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        handleLayout()
      })
      observer.observe(wrap)
    }

    return () => {
      window.removeEventListener('resize', handleLayout)
      window.removeEventListener('scroll', handleLayout)
      observer?.disconnect()
    }
  }, [])

  // ── Sincronização manual (botão 🔄) ──────────────────────────────────
  const manualSync = () => {
    const provider = providerRef.current
    const editor = editorRef.current
    const ytext = ytextRef.current
    if (!provider || syncing) return
    setSyncing(true)
    setSyncFlash(null)

    try {
      try {
        provider.disconnect()
      } catch {}
      try {
        provider.connect()
      } catch {}
    } catch (e) {
      console.warn('[sync] reconnect falhou:', e)
    }

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

  const switchMode = (newMode: ModeId) => {
    setMode(newMode)
    const editor = editorRef.current
    if (editor) {
      const text = editor.getValue()
      persistSnapshotToSupabase(text, newMode)
    }
  }

  // ── Botão Rodar Código ───────────────────────────────────────────────
  const runCode = async () => {
    const cfg = MODES.find((m) => m.id === mode)
    if (!cfg?.lang) return
    setRunning(true)
    setExecOut('')
    const code = editorRef.current?.getValue() || ''

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
    ]
      .filter(Boolean)
      .join('\n\n')
    setExecOut(out || '(sem saída)')
  }

  // ── Rádio PX: Handlers PTT ──────────────────────────────────────────
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
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = 800
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
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data)
      }
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: mimeType })
        const dataUrl: string = await new Promise((resolve, reject) => {
          const fr = new FileReader()
          fr.onload = () => resolve(fr.result as string)
          fr.onerror = () => reject(fr.error)
          fr.readAsDataURL(blob)
        })
        try {
          const localAudio = new Audio(dataUrl)
          localAudio.play().catch(() => {})
        } catch {}
        try {
          ws.send(
            JSON.stringify({
              type: 'ptt_audio',
              sender: resolvedName,
              audio: dataUrl,
              timestamp: Date.now(),
            })
          )
        } catch (err) {
          console.warn('[PTT] send falhou:', err)
        }
        pttStreamRef.current?.getTracks().forEach((t) => t.stop())
        pttStreamRef.current = null
        mediaRecorderRef.current = null
      }
      recorder.start()
      setPttActive(true)
      dispatchPttActive(true, 'px')
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

  // ── Estúdio de Transmissão (ON AIR) ──────────────────────────────────
  const checkRoomHost = async () => {
    try {
      const r = await fetch(`${BASE_URL}ws/collab/${roomId}/status`, {
        headers: { Accept: 'application/json' },
      })
      if (!r.ok) return false
      const j = await r.json()
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
    const iv = window.setInterval(check, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(iv)
    }
  }, [roomId, isAuthenticated, jwtToken])

  const startOnAir = async () => {
    if (onAir || onAirStarting) return
    if (!isRoomHost || !isBroadcastAdmin) return
    setOnAirStarting(true)
    try {
      const handle = openBroadcastHandle(jwtToken, resolvedName, isBroadcastAdmin)
      onAirHandleRef.current = handle
      await handle.wsReady()
      handle.setState('on', roomId, resolvedName, jwtToken)

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      onAirStreamRef.current = stream

      const audioCtx = new AudioContext({ sampleRate: 16000 })
      onAirAudioCtxRef.current = audioCtx
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
        handle.sendAudio(dataUrl, resolvedName)
      }

      mixerBus.connect(processor)
      const gain = audioCtx.createGain()
      gain.gain.value = 0
      onAirGainRef.current = gain
      processor.connect(gain)
      gain.connect(audioCtx.destination)

      onAirStartedAtRef.current = Date.now()
      setOnAir(true)
      setOnAirStarting(false)
      setOnAirSeconds(0)

      if (onAirTickRef.current) window.clearInterval(onAirTickRef.current)
      onAirTickRef.current = window.setInterval(() => {
        setOnAirSeconds(Math.floor((Date.now() - onAirStartedAtRef.current) / 1000))
      }, 1000)

      dispatchPttActive(true, 'studio')
    } catch (err) {
      console.warn('[OnAir] start falhou:', err)
      setOnAirStarting(false)
      try {
        onAirRecorderRef.current?.stop()
      } catch {}
      try {
        onAirProcessorRef.current?.disconnect()
      } catch {}
      try {
        onAirMixerRef.current?.disconnect()
      } catch {}
      try {
        onAirGainRef.current?.disconnect()
      } catch {}
      try {
        onAirAudioCtxRef.current?.close()
      } catch {}
      onAirStreamRef.current?.getTracks().forEach((t) => t.stop())
      onAirHandleRef.current?.close()
    }
  }

  const stopOnAir = () => {
    if (!onAir) return
    try {
      onAirProcessorRef.current?.disconnect()
    } catch {}
    try {
      onAirMixerRef.current?.disconnect()
    } catch {}
    try {
      onAirGainRef.current?.disconnect()
    } catch {}
    try {
      onAirAudioCtxRef.current?.close()
    } catch {}
    onAirStreamRef.current?.getTracks().forEach((t) => t.stop())
    try {
      onAirHandleRef.current?.setState('off', roomId, resolvedName, jwtToken)
    } catch {}
    setTimeout(() => {
      onAirHandleRef.current?.close()
      onAirHandleRef.current = null
    }, 1500)
    if (onAirTickRef.current) {
      window.clearInterval(onAirTickRef.current)
      onAirTickRef.current = null
    }
    setOnAir(false)
    setOnAirSeconds(0)
    dispatchPttActive(false, 'studio')
  }

  useEffect(() => {
    return () => {
      if (pttTimeoutRef.current) window.clearTimeout(pttTimeoutRef.current)
      pttStreamRef.current?.getTracks().forEach((t) => t.stop())
      try {
        mediaRecorderRef.current?.stop()
      } catch {}
      if (onAirTickRef.current) window.clearInterval(onAirTickRef.current)
      try {
        onAirProcessorRef.current?.disconnect()
      } catch {}
      try {
        onAirMixerRef.current?.disconnect()
      } catch {}
      try {
        onAirGainRef.current?.disconnect()
      } catch {}
      try {
        onAirAudioCtxRef.current?.close()
      } catch {}
      onAirStreamRef.current?.getTracks().forEach((t) => t.stop())
      try {
        onAirHandleRef.current?.close()
      } catch {}
      dispatchPttActive(false, 'studio')
    }
  }, [])

  // Awareness de transmissão
  useEffect(() => {
    const provider = providerRef.current
    if (!provider) return
    if (onAir) {
      try {
        provider.awareness.setLocalStateField('broadcasting', {
          room_id: roomId,
          since: onAirStartedAtRef.current,
        })
      } catch {}
    } else {
      try {
        provider.awareness.setLocalStateField('broadcasting', null)
      } catch {}
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
        setPeerBroadcasting({
          name: broadcaster.user?.display_name || broadcaster.user?.name || 'Anfitrião',
          since: broadcaster.broadcasting.since || Date.now(),
        })
      } else {
        setPeerBroadcasting(null)
      }
    }
    provider.awareness.on('change', onAwareness)
    onAwareness()
    return () => provider.awareness.off('change', onAwareness)
  }, [status])

  // ── Convidar (copiar link da sala) ──────────────────────────────────
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

  // 22/09/2026 — Exportar Relatório da Turma em CSV
  // Usa rankedParticipants (já calculado acima, ordenado por currentScore desc).
  // Separador ; (pt-BR abre direto no Excel sem conflitar com vírgula de número),
  // BOM UTF-8 pra acentos abrirem perfeitos, aspas duplas em valores com caracteres
  // especiais, e CRLF pra máxima compatibilidade Windows/Excel/Sheets.
  const [exporting, setExporting] = useState(false)
  const [exportSuccess, setExportSuccess] = useState(false)
  const exportSuccessTimeoutRef = useRef<number | null>(null)
  const handleExportCSV = () => {
    if (rankedParticipants.length === 0) return
    setExporting(true)
    try {
      const escapeCsv = (v: unknown): string => {
        const s = v === null || v === undefined ? '' : String(v)
        if (/[";\n\r]/.test(s)) {
          return `"${s.replace(/"/g, '""')}"`
        }
        return s
      }
      const header = [
        'Posição',
        'Nome do Aluno',
        'Página Atual',
        'Pontuação Total',
        'Último Quiz',
        'Data/Hora da Exportação',
      ]
      const exportedAt = new Date().toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
      const rows = rankedParticipants.map((p, idx) => [
        idx + 1,
        p.name + (p.isMe ? ' (Você)' : ''),
        p.currentPage ?? '',
        p.currentScore ?? 0,
        typeof p.lastQuizScore === 'number' && p.lastQuizScore !== 0
          ? (p.lastQuizScore > 0 ? `+${p.lastQuizScore}` : `${p.lastQuizScore}`)
          : 'N/A',
        exportedAt,
      ])
      const csvBody = [header, ...rows]
        .map((r) => r.map(escapeCsv).join(';'))
        .join('\r\n')
      const BOM = '﻿'
      const blob = new Blob([BOM + csvBody], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const today = new Date().toISOString().slice(0, 10)
      const a = document.createElement('a')
      a.href = url
      a.download = `relatorio_turma_${roomId}_${today}.csv`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // libera a URL após o clique (pequeno delay pra Safari processar)
      setTimeout(() => URL.revokeObjectURL(url), 1000)

      // feedback visual de sucesso — 2s no botão (sem libs externas)
      setExportSuccess(true)
      if (exportSuccessTimeoutRef.current) window.clearTimeout(exportSuccessTimeoutRef.current)
      exportSuccessTimeoutRef.current = window.setTimeout(() => {
        setExportSuccess(false)
        exportSuccessTimeoutRef.current = null
      }, 2000)
    } catch (err) {
      console.warn('[Collab] Falha ao exportar CSV:', err)
    } finally {
      setExporting(false)
    }
  }

  const totalOnline = collabPeers.length + 1

  // 22/09/2026 — Pódio da Turma (Top 3 por currentScore)
  // Combina o próprio usuário local com os peers remotos (vindos do awareness)
  // e ordena de forma estável por currentScore desc. useMemo evita re-sort
  // a cada mensagem do WebSocket quando os scores não mudaram.
  const rankedParticipants = useMemo(() => {
    const me = {
      clientID: -1, // sentinel pro próprio usuário
      user_id: 'me',
      name: resolvedName,
      color: myColor,
      isHost: isRoomHost,
      isSpeaking: false,
      currentPage: typeof currentPage === 'number' ? currentPage : undefined,
      currentScore: typeof currentScore === 'number' ? currentScore : 0,
      lastQuizScore: 0,
      isMe: true,
    }
    const others = collabPeers.map((p) => ({ ...p, isMe: false }))
    return [...others, me].sort((a, b) => {
      const diff = (b.currentScore ?? 0) - (a.currentScore ?? 0)
      if (diff !== 0) return diff
      // empate: nome alfabético asc pra ser estável
      return a.name.localeCompare(b.name, 'pt-BR')
    })
  }, [collabPeers, resolvedName, myColor, isRoomHost, currentPage, currentScore])
  const topThree = rankedParticipants.slice(0, 3)

  return (
    <aside
      className="collab-aside-container"
      role="dialog"
      aria-label="Painel de Estudo Colaborativo"
    >
      {/* ── Folha de Estilos Autônoma Scoped ── */}
      <style>{`
        .collab-aside-container {
          position: relative;
          width: 100%;
          max-width: 100%;
          min-height: 520px;
          background: #0f172a;
          color: #f8fafc;
          border: 1px solid #334155;
          border-radius: 16px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
          display: flex;
          flex-direction: column;
          box-sizing: border-box;
          overflow: hidden;
          margin: 16px 0 24px 0;
          font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }

        /* Wrapper do Monaco: largura 100% e altura confortável */
        .collab-monaco-wrap {
          width: 100%;
          height: 480px;
          min-height: 380px;
          overflow: hidden;
          border-bottom: 1px solid #1e293b;
          background: #1e1e1e;
          position: relative;
        }

        .collab-label-desktop {
          display: inline;
        }

        .collab-bottom-sheet-handle {
          display: none;
        }

        @media (max-width: 768px) {
          .collab-aside-container {
            border-radius: 12px;
            min-height: 400px;
          }
          .collab-monaco-wrap {
            height: 360px;
            min-height: 280px;
          }
          .collab-header-row {
            padding: 8px 10px !important;
            gap: 6px !important;
          }
          .collab-title-text {
            font-size: 13px !important;
          }
          .collab-pill-participants {
            padding: 2px 7px !important;
            font-size: 11px !important;
            margin-left: 6px !important;
          }
          .collab-actions-group {
            gap: 4px !important;
          }
          .collab-pill-px {
            padding: 4px 8px !important;
            font-size: 11px !important;
          }
          .collab-popover-menu {
            left: 8px !important;
            right: 8px !important;
            width: auto !important;
            max-width: calc(100% - 16px) !important;
          }
        }

        @media (max-width: 480px) {
          .collab-label-desktop {
            display: none;
          }
        }

        /* Linha 1 — Topo do Painel */
        .collab-header-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 16px;
          background: #0f172a;
          border-bottom: 1px solid #1e293b;
          color: #ffffff;
          user-select: none;
          box-sizing: border-box;
          flex-shrink: 0;
          position: relative;
        }

        .collab-header-left {
          display: flex;
          align-items: center;
          min-width: 0;
        }

        .collab-title-group {
          display: flex;
          align-items: center;
          gap: 6px;
          font-weight: 500;
          font-size: 14px;
          color: #f8fafc;
          white-space: nowrap;
        }

        /* Pílula de participantes ● 2 online ▾ */
        .collab-pill-participants {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: #1e293b;
          border: 1px solid #334155;
          color: #e2e8f0;
          font-size: 12px;
          font-weight: 500;
          padding: 4px 10px;
          border-radius: 9999px;
          cursor: pointer;
          margin-left: 8px;
          transition: all 0.15s ease-in-out;
          white-space: nowrap;
          outline: none;
        }
        .collab-pill-participants:hover {
          background: #334155;
          border-color: #475569;
        }

        .collab-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          flex-shrink: 0;
        }

        /* Lado Direito: Ações com espaçamento real */
        .collab-actions-group {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-shrink: 0;
        }

        .collab-btn-invite {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          background: #1e293b;
          border: 1px solid #334155;
          color: #e2e8f0;
          font-size: 12px;
          font-weight: 500;
          padding: 5px 10px;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.15s ease-in-out;
          outline: none;
          white-space: nowrap;
        }
        .collab-btn-invite:hover {
          background: #334155;
          border-color: #475569;
          color: #ffffff;
        }

        .collab-btn-sync {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 30px;
          height: 30px;
          background: #1e293b;
          border: 1px solid #334155;
          color: #e2e8f0;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.15s ease-in-out;
          outline: none;
        }
        .collab-btn-sync:hover {
          background: #334155;
          border-color: #475569;
          color: #ffffff;
        }

        .collab-pill-px {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          background: #1e293b;
          border: 1px solid #334155;
          color: #e2e8f0;
          font-size: 12px;
          font-weight: 500;
          padding: 5px 12px;
          border-radius: 9999px;
          cursor: pointer;
          transition: all 0.15s ease-in-out;
          user-select: none;
          touch-action: none;
          outline: none;
          white-space: nowrap;
        }
        .collab-pill-px:hover {
          background: #334155;
        }
        .collab-pill-px.active {
          background: #dc2626 !important;
          border-color: #ef4444 !important;
          color: #ffffff !important;
          box-shadow: 0 0 10px rgba(220, 38, 38, 0.5);
          animation: ptt-pulse 0.8s ease-in-out infinite;
        }

        .collab-pill-onair {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          background: transparent;
          border: 1px solid #f59e0b;
          color: #f59e0b;
          font-size: 12px;
          font-weight: 500;
          padding: 5px 12px;
          border-radius: 9999px;
          cursor: pointer;
          transition: all 0.15s ease-in-out;
          outline: none;
          white-space: nowrap;
        }
        .collab-pill-onair:hover {
          background: rgba(245, 158, 11, 0.15);
        }
        .collab-pill-onair.active {
          background: #dc2626 !important;
          border-color: #ef4444 !important;
          color: #ffffff !important;
          box-shadow: 0 0 10px rgba(220, 38, 38, 0.5);
          animation: ptt-pulse 0.8s ease-in-out infinite;
        }

        .collab-btn-close {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          background: transparent;
          border: 1px solid #334155;
          border-radius: 6px;
          color: #94a3b8;
          cursor: pointer;
          transition: all 0.15s ease-in-out;
          margin-left: 2px;
          outline: none;
        }
        .collab-btn-close:hover {
          background: #334155;
          color: #ffffff;
          border-color: #475569;
        }

        /* Linha 2 — Sub-barra de Abas de Linguagem (Tabs Bar) */
        .collab-tabs-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 4px 12px 0 12px;
          background: #020617;
          border-bottom: 1px solid rgba(30, 41, 59, 0.8);
          font-size: 12px;
          box-sizing: border-box;
          flex-shrink: 0;
          gap: 8px;
          overflow-x: auto;
          scrollbar-width: none;
          -ms-overflow-style: none;
        }
        .collab-tabs-bar::-webkit-scrollbar {
          display: none;
        }

        .collab-tabs-list {
          display: flex;
          align-items: center;
          gap: 3px;
        }

        .collab-tab-button {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 6px 12px;
          font-size: 12px;
          cursor: pointer;
          border: none;
          background: transparent;
          color: #94a3b8;
          border-bottom: 2px solid transparent;
          border-radius: 4px 4px 0 0;
          transition: all 0.15s ease-in-out;
          white-space: nowrap;
          outline: none;
        }
        .collab-tab-button:hover {
          color: #e2e8f0;
          background: rgba(30, 41, 59, 0.5);
        }
        .collab-tab-button.active {
          background: #1e293b;
          color: #ffffff;
          font-weight: 500;
          border-bottom: 2px solid #38bdf8;
        }

        .collab-btn-run {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          background: #e8a547;
          color: #0f172a;
          font-size: 11px;
          font-weight: 600;
          padding: 4px 10px;
          border-radius: 4px;
          border: none;
          cursor: pointer;
          transition: all 0.15s ease-in-out;
          flex-shrink: 0;
          margin-bottom: 4px;
        }
        .collab-btn-run:hover {
          background: #f59e0b;
        }
        .collab-btn-run:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        /* Popover de Participantes */
        .collab-popover-menu {
          position: absolute;
          top: 48px;
          left: 16px;
          z-index: 10000;
          width: 290px;
          background: rgba(15, 23, 42, 0.98);
          backdrop-filter: blur(12px);
          border: 1px solid #334155;
          border-radius: 12px;
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.6), 0 8px 10px -6px rgba(0, 0, 0, 0.6);
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          box-sizing: border-box;
          animation: collab-popover-in 0.15s ease-out;
        }

        @keyframes collab-popover-in {
          from { opacity: 0; transform: translateY(-4px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }

        @keyframes ptt-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.6); }
          50% { box-shadow: 0 0 0 6px rgba(220, 38, 38, 0); }
        }
      `}</style>

      {/* ── Linha 1: Topo do Painel (Header Principal) ── */}
      <header className="collab-header-row">
        {/* Lado Esquerdo: Ícone + Título + Pílula de Participantes */}
        <div className="collab-header-left">
          <div className="collab-title-group">
            <Users size={16} style={{ color: '#94a3b8', flexShrink: 0 }} />
            <span className="collab-title-text">Estudo em Dupla</span>
          </div>

          <button
            onClick={() => setShowParticipants((prev) => !prev)}
            className="collab-pill-participants"
            title="Ver participantes conectados"
          >
            <span
              className="collab-dot"
              style={{
                backgroundColor:
                  status === 'connected'
                    ? '#4ade80'
                    : status === 'connecting'
                    ? '#facc15'
                    : status === 'guest'
                    ? '#fbbf24'
                    : '#f87171',
              }}
            />
            <span>
              {status === 'connected'
                ? `${totalOnline} online`
                : status === 'connecting'
                ? 'conectando...'
                : status === 'guest'
                ? 'convidado'
                : 'offline'}
            </span>
            <ChevronDown
              size={12}
              style={{
                color: '#94a3b8',
                transition: 'transform 0.15s',
                transform: showParticipants ? 'rotate(180deg)' : 'rotate(0deg)',
              }}
            />
          </button>
        </div>

        {/* Lado Direito: Ações com espaçamento real */}
        <div className="collab-actions-group">
          {/* Botão Convidar */}
          <button
            onClick={invite}
            title="Copiar link da sala"
            className="collab-btn-invite"
          >
            {inviteCopied ? <Check size={13} style={{ color: '#4ade80' }} /> : <LinkIcon size={13} />}
            <span className="collab-label-desktop">{inviteCopied ? 'Copiado!' : 'Convidar'}</span>
          </button>

          {/* Botão Sync */}
          <button
            onClick={manualSync}
            disabled={syncing}
            title="Forçar sincronização de dados Yjs e texto"
            className="collab-btn-sync"
            style={{
              backgroundColor: syncFlash === 'ok' ? 'rgba(34, 197, 94, 0.2)' : undefined,
              borderColor: syncFlash === 'ok' ? '#22c55e' : undefined,
              color: syncFlash === 'ok' ? '#4ade80' : undefined,
            }}
          >
            <RefreshCw
              size={13}
              style={{
                animation: syncing ? 'spin 1s linear infinite' : undefined,
              }}
            />
          </button>

          {/* Botão PX / Rádio */}
          <button
            onPointerDown={pttStart}
            onPointerUp={pttStop}
            onPointerLeave={pttStop}
            onPointerCancel={pttStop}
            onContextMenu={(e) => e.preventDefault()}
            title={pttActive ? 'Transmitindo… solte pra encerrar' : 'Segure pra falar no Rádio PX (15s máx)'}
            className={`collab-pill-px ${pttActive ? 'active' : ''}`}
          >
            <Radio size={13} />
            <span>{pttActive ? 'Falando…' : 'PX'}</span>
          </button>

          {/* Botão Transmitir (Admin Host) */}
          {isAuthenticated && isBroadcastAdmin && (
            <button
              onClick={onAir ? stopOnAir : startOnAir}
              disabled={onAirStarting || !isRoomHost}
              title={
                !isRoomHost
                  ? 'Apenas o anfitrião pode transmitir'
                  : onAir
                  ? 'Encerrar transmissão da sala'
                  : 'Transmitir áudio da sala na Web Rádio'
              }
              className={`collab-pill-onair ${onAir ? 'active' : ''}`}
              style={{
                opacity: !isRoomHost ? 0.4 : 1,
                cursor: !isRoomHost ? 'not-allowed' : 'pointer',
              }}
            >
              <Megaphone size={13} />
              <span className="collab-label-desktop">
                {onAir
                  ? `${Math.floor(onAirSeconds / 60)
                      .toString()
                      .padStart(2, '0')}:${(onAirSeconds % 60).toString().padStart(2, '0')}`
                  : 'Transmitir'}
              </span>
            </button>
          )}

          {/* Botão Fechar ✕ isolado */}
          <button
            onClick={onClose}
            title="Fechar painel"
            aria-label="Fechar painel colaborativo"
            className="collab-btn-close"
          >
            <XIcon size={15} />
          </button>
        </div>

        {/* ── Popover Dropdown de Participantes ── */}
        {showParticipants && (
          <div ref={participantsRef} className="collab-popover-menu">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingBottom: '8px',
                borderBottom: '1px solid #334155',
              }}
            >
              <span style={{ fontWeight: 600, color: '#f1f5f9', fontSize: '12px' }}>
                Participantes na Sala ({totalOnline})
              </span>
              <span
                style={{
                  fontSize: '10px',
                  color: '#4ade80',
                  fontWeight: 500,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <span
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    backgroundColor: '#4ade80',
                  }}
                />
                CRDT Yjs Ativo
              </span>
            </div>

            {/* ── Pódio da Turma (Top 3 por pontuação) ── */}
            <div
              data-testid="collab-podium"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                paddingBottom: '8px',
                borderBottom: '1px solid rgba(51, 65, 85, 0.6)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '2px',
                }}
              >
                <span style={{ fontWeight: 600, color: '#fcd34d', fontSize: '11px' }}>
                  🏆 Pódio da Turma
                </span>
                <span style={{ fontSize: '9px', color: '#64748b', fontWeight: 500 }}>
                  top {Math.min(topThree.length, 3)}
                </span>
              </div>

              {topThree.length === 0 || topThree.every((p) => (p.currentScore ?? 0) === 0) ? (
                <div
                  style={{
                    padding: '8px 6px',
                    textAlign: 'center',
                    color: '#64748b',
                    fontSize: '10px',
                    fontStyle: 'italic',
                    backgroundColor: 'rgba(2, 6, 23, 0.4)',
                    borderRadius: '6px',
                  }}
                >
                  Aguardando primeiros quizzes da turma...
                </div>
              ) : (
                topThree.map((p, idx) => {
                  const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉'
                  const medalBg = idx === 0 ? 'rgba(245, 158, 11, 0.18)'
                    : idx === 1 ? 'rgba(203, 213, 225, 0.18)'
                    : 'rgba(180, 83, 9, 0.18)'
                  const medalBorder = idx === 0 ? 'rgba(245, 158, 11, 0.5)'
                    : idx === 1 ? 'rgba(203, 213, 225, 0.45)'
                    : 'rgba(180, 83, 9, 0.5)'
                  const scoreColor = idx === 0 ? '#fcd34d'
                    : idx === 1 ? '#e2e8f0'
                    : '#d6a378'
                  const score = p.currentScore ?? 0
                  return (
                    <div
                      key={`podium-${p.clientID}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '6px 8px',
                        borderRadius: '6px',
                        backgroundColor: medalBg,
                        border: `1px solid ${medalBorder}`,
                      }}
                    >
                      <span style={{ fontSize: '14px', lineHeight: 1, flexShrink: 0 }}>{medal}</span>
                      <span style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: 500, flexShrink: 0 }}>
                        {idx + 1}º
                      </span>
                      <div
                        style={{
                          width: '20px',
                          height: '20px',
                          borderRadius: '50%',
                          backgroundColor: p.color,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: 700,
                          color: '#ffffff',
                          fontSize: '10px',
                          flexShrink: 0,
                        }}
                      >
                        {(p.name || '?').slice(0, 1).toUpperCase()}
                      </div>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: '11px',
                          fontWeight: 500,
                          color: p.isMe ? '#fbbf24' : '#e2e8f0',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {p.name}
                        {p.isMe && (
                          <span style={{ marginLeft: '6px', color: '#60a5fa', fontWeight: 600 }}>
                            (Você)
                          </span>
                        )}
                      </span>
                      <span
                        style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          color: scoreColor,
                          flexShrink: 0,
                        }}
                      >
                        {score > 0 ? `+${score}` : score} pts
                      </span>
                    </div>
                  )
                })
              )}
            </div>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                maxHeight: '220px',
                overflowY: 'auto',
                paddingRight: '4px',
              }}
            >
              {/* Card: Você */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 10px',
                  borderRadius: '8px',
                  backgroundColor: 'rgba(2, 6, 23, 0.7)',
                  border: '1px solid #1e293b',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                  <div
                    style={{
                      width: '26px',
                      height: '26px',
                      borderRadius: '50%',
                      backgroundColor: myColor,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 700,
                      color: '#ffffff',
                      fontSize: '11px',
                      flexShrink: 0,
                    }}
                  >
                    {resolvedName.slice(0, 1).toUpperCase()}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span
                      style={{
                        fontWeight: 500,
                        color: '#f8fafc',
                        fontSize: '12px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {resolvedName}
                    </span>
                    <span style={{ fontSize: '10px', color: '#94a3b8' }}>
                      {typeof currentPage === 'number' ? `pág. ${currentPage}` : '—'}
                      {' · '}
                      <span style={{
                        color: (currentScore || 0) > 0 ? '#4ade80'
                          : (currentScore || 0) < 0 ? '#fca5a5'
                          : '#94a3b8',
                        fontWeight: 600,
                      }}>
                        {currentScore > 0 ? `+${currentScore}` : currentScore} pts
                      </span>
                    </span>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                  {isRoomHost && (
                    <span
                      style={{
                        padding: '1px 5px',
                        borderRadius: '4px',
                        backgroundColor: 'rgba(245, 158, 11, 0.2)',
                        color: '#fcd34d',
                        fontSize: '10px',
                        fontWeight: 500,
                        border: '1px solid rgba(245, 158, 11, 0.3)',
                      }}
                    >
                      Anfitrião
                    </span>
                  )}
                  <span
                    style={{
                      padding: '1px 5px',
                      borderRadius: '4px',
                      backgroundColor: 'rgba(59, 130, 246, 0.2)',
                      color: '#93c5fd',
                      fontSize: '10px',
                      fontWeight: 500,
                    }}
                  >
                    Você
                  </span>
                </div>
              </div>

              {/* Lista dos outros Peers */}
              {collabPeers.length === 0 ? (
                <div
                  style={{
                    padding: '12px 8px',
                    textAlign: 'center',
                    color: '#94a3b8',
                    fontSize: '11px',
                    backgroundColor: 'rgba(2, 6, 23, 0.4)',
                    borderRadius: '8px',
                  }}
                >
                  Nenhum colega conectado ainda.<br />
                  Clique em <strong>Convidar</strong> para enviar o link!
                </div>
              ) : (
                collabPeers.map((peer) => (
                  <div
                    key={peer.clientID}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 10px',
                      borderRadius: '8px',
                      backgroundColor: 'rgba(2, 6, 23, 0.5)',
                      border: '1px solid rgba(30, 41, 59, 0.8)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                      <div
                        style={{
                          width: '26px',
                          height: '26px',
                          borderRadius: '50%',
                          backgroundColor: peer.color,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: 700,
                          color: '#ffffff',
                          fontSize: '11px',
                          flexShrink: 0,
                        }}
                      >
                        {peer.name.slice(0, 1).toUpperCase()}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <span
                          style={{
                            fontWeight: 500,
                            color: '#f1f5f9',
                            fontSize: '12px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {peer.name}
                        </span>
                        <span style={{ fontSize: '10px', color: '#94a3b8' }}>
                          {peer.isSpeaking ? '🎙️ Falando agora...' : 'Online no editor'}
                          {typeof peer.currentPage === 'number' ? ` · pág. ${peer.currentPage}` : ''}
                          {typeof peer.currentScore === 'number' ? (
                            <>
                              {' · '}
                              <span style={{
                                color: peer.currentScore > 0 ? '#4ade80'
                                  : peer.currentScore < 0 ? '#fca5a5'
                                  : '#94a3b8',
                                fontWeight: 600,
                              }}>
                                {peer.currentScore > 0 ? `+${peer.currentScore}` : peer.currentScore} pts
                              </span>
                            </>
                          ) : null}
                        </span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                      {typeof peer.lastQuizScore === 'number' && peer.lastQuizScore !== 0 && (
                        <span
                          title={`Último quiz: ${peer.lastQuizScore > 0 ? '+' : ''}${peer.lastQuizScore} pts`}
                          style={{
                            padding: '1px 5px',
                            borderRadius: '4px',
                            backgroundColor: peer.lastQuizScore > 0 ? 'rgba(34, 197, 94, 0.18)' : 'rgba(239, 68, 68, 0.18)',
                            color: peer.lastQuizScore > 0 ? '#86efac' : '#fca5a5',
                            fontSize: '10px',
                            fontWeight: 600,
                            border: `1px solid ${peer.lastQuizScore > 0 ? 'rgba(34, 197, 94, 0.35)' : 'rgba(239, 68, 68, 0.35)'}`,
                          }}
                        >
                          {peer.lastQuizScore > 0 ? `+${peer.lastQuizScore}` : peer.lastQuizScore}
                        </span>
                      )}
                      {peer.isSpeaking && (
                        <span
                          style={{
                            padding: '1px 5px',
                            borderRadius: '4px',
                            backgroundColor: 'rgba(220, 38, 38, 0.2)',
                            color: '#fca5a5',
                            fontSize: '10px',
                            fontWeight: 500,
                          }}
                        >
                          PX
                        </span>
                      )}
                      {peer.isHost && (
                        <span
                          style={{
                            padding: '1px 5px',
                            borderRadius: '4px',
                            backgroundColor: 'rgba(245, 158, 11, 0.2)',
                            color: '#fcd34d',
                            fontSize: '10px',
                            fontWeight: 500,
                            border: '1px solid rgba(245, 158, 11, 0.3)',
                          }}
                        >
                          Anfitrião
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div
              style={{
                paddingTop: '8px',
                borderTop: '1px solid #334155',
                fontSize: '10px',
                color: '#94a3b8',
                lineHeight: 1.3,
              }}
            >
              💡 Os cursores e seleções aparecem com as cores dos participantes no editor.
            </div>

            {/* ── Exportar Relatório da Turma em CSV ── */}
            {rankedParticipants.length > 0 && status !== 'error' && (
              <button
                type="button"
                onClick={handleExportCSV}
                disabled={exporting || exportSuccess}
                title={`Baixar planilha com ${rankedParticipants.length} participante${rankedParticipants.length !== 1 ? 's' : ''} (CSV pt-BR, BOM UTF-8, abre direto no Excel/Sheets)`}
                style={{
                  marginTop: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  padding: '8px 10px',
                  fontSize: '11px',
                  fontWeight: 600,
                  color: exportSuccess ? '#86efac' : '#fbbf24',
                  backgroundColor: exportSuccess
                    ? 'rgba(34, 197, 94, 0.15)'
                    : exporting
                      ? 'rgba(245, 158, 11, 0.08)'
                      : 'rgba(245, 158, 11, 0.12)',
                  border: exportSuccess
                    ? '1px solid rgba(34, 197, 94, 0.45)'
                    : '1px solid rgba(245, 158, 11, 0.35)',
                  borderRadius: '8px',
                  cursor: exportSuccess || exporting ? 'default' : 'pointer',
                  opacity: exporting ? 0.6 : 1,
                  transition: 'background-color 0.15s, border-color 0.15s, color 0.15s',
                  outline: 'none',
                }}
                onMouseEnter={(e) => {
                  if (!exporting && !exportSuccess) e.currentTarget.style.backgroundColor = 'rgba(245, 158, 11, 0.22)'
                }}
                onMouseLeave={(e) => {
                  if (!exporting && !exportSuccess) e.currentTarget.style.backgroundColor = 'rgba(245, 158, 11, 0.12)'
                }}
              >
                <span style={{ fontSize: '13px' }}>{exportSuccess ? '✅' : '📥'}</span>
                <span>
                  {exportSuccess
                    ? 'Relatório baixado!'
                    : exporting
                      ? 'Exportando…'
                      : `Exportar Relatório (.csv) · ${rankedParticipants.length}`}
                </span>
              </button>
            )}
          </div>
        )}
      </header>

      {/* ── Linha 2: Sub-barra de Abas de Linguagem (Tabs Bar) ── */}
      <div className="collab-tabs-bar">
        {/* Abas de linguagens estilo VS Code */}
        <div className="collab-tabs-list">
          {MODES.map((m) => (
            <button
              key={m.id}
              className={`collab-tab-button ${mode === m.id ? 'active' : ''}`}
              onClick={() => switchMode(m.id)}
            >
              <span>{m.label}</span>
            </button>
          ))}
        </div>

        {/* Botão Rodar código (se modo de programação) */}
        {mode !== 'text' && (
          <button
            className="collab-btn-run"
            onClick={runCode}
            disabled={running}
            title="Executar código no ambiente Piston"
          >
            <span>{running ? '⏳ rodando…' : '▶️ Rodar'}</span>
          </button>
        )}
      </div>

      {/* Banner de Convidado */}
      {status === 'guest' && (
        <div
          style={{
            padding: '6px 14px',
            backgroundColor: 'rgba(245, 158, 11, 0.15)',
            color: '#fde68a',
            fontSize: '11px',
            borderBottom: '1px solid rgba(245, 158, 11, 0.25)',
          }}
          role="status"
        >
          ✏️ Modo convidado: edições salvas localmente e sincronizadas em tempo real com a sala.
        </div>
      )}

      {/* Alerta de Transmissão Remota */}
      {peerBroadcasting && !onAir && (
        <div
          style={{
            padding: '8px 14px',
            backgroundColor: 'rgba(220, 38, 38, 0.25)',
            color: '#fee2e2',
            fontSize: '12px',
            borderBottom: '1px solid rgba(220, 38, 38, 0.4)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
          role="status"
        >
          <Megaphone size={14} style={{ color: '#ef4444' }} />
          <span>
            🔴 <strong>NO AR NA WEB RÁDIO</strong> — {peerBroadcasting.name} está transmitindo esta sala ao vivo na{' '}
            <strong>Devocional 12</strong>.
          </span>
        </div>
      )}

      {/* Indicador de PTT Ativo de Outro Usuário */}
      {pttPeerTalking && (
        <div
          style={{
            padding: '8px 14px',
            backgroundColor: 'rgba(220, 38, 38, 0.2)',
            color: '#fee2e2',
            fontSize: '12px',
            borderBottom: '1px solid rgba(220, 38, 38, 0.3)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
          role="status"
        >
          <Radio size={14} style={{ color: '#ef4444' }} />
          <span>📻 <strong>{pttPeerTalking.name}</strong> falando no rádio…</span>
        </div>
      )}

      {/* ── Monaco Editor ── */}
      <div ref={monacoWrapRef} className="collab-monaco-wrap">
        <Editor
          height="100%"
          width="100%"
          defaultLanguage={monacoLang}
          language={monacoLang}
          theme="vs-dark"
          onMount={onMount}
          loading={<div style={{ padding: '16px', fontSize: '13px', opacity: 0.7 }}>⌛ carregando editor colaborativo…</div>}
          options={{
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            readOnly: false,
            quickSuggestions: { other: true, comments: false, strings: true },
            suggestOnTriggerCharacters: true,
            tabCompletion: 'on',
          }}
        />
      </div>

      {/* Saída de Execução de Código */}
      {execOut && (
        <div
          style={{
            borderTop: '1px solid #1e293b',
            maxHeight: '28%',
            overflowY: 'auto',
            padding: '12px',
            backgroundColor: 'rgba(0, 0, 0, 0.6)',
            fontFamily: 'monospace',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '6px',
            }}
          >
            <span style={{ fontSize: '11px', opacity: 0.7, color: '#cbd5e1' }}>
              Saída {new Date(execTs).toLocaleTimeString('pt-BR')}
            </span>
            <button
              style={{
                fontSize: '11px',
                color: '#94a3b8',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
              onClick={() => setExecOut('')}
            >
              limpar
            </button>
          </div>
          <pre
            style={{
              fontSize: '12px',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.5,
              color: '#86efac',
              margin: 0,
            }}
          >
            {execOut}
          </pre>
        </div>
      )}
    </aside>
  )
}

export function newRoomId(): string {
  return uuidv4().replace(/-/g, '').slice(0, 16)
}
