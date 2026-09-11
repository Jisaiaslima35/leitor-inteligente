// Helpers pra feature "Estúdio de Transmissão ao Vivo" do Leitor.
//
// 07/09/2026 — Claudinho (v16).
//
// Como o bridge_server (api/bridge_server.py) escuta a sala global "_broadcast",
// o front envia anúncios de ON/OFF + chunks de áudio pra lá. Esta sala é
// "fantasma" — collab_server aceita qualquer peer (mesmo guest) e o relay é
// texto puro (sem Yjs sync necessário).
//
// v16: trocou WebsocketProvider (y-websocket) por WebSocket cru. O Yjs tentava
// parsear as mensagens customizadas (broadcast_audio/state) como update binário
// e crashava com "Unexpected end of array". Não precisamos de Yjs sync nessa
// sala — é canal one-way de áudio.
//
// 08/09/2026 (v19) — Trava admin: CollabPanel só permite broadcast pra quem
// tem email em ADMIN_EMAILS (lib/jwt.ts). Defesa em profundidade:
// collab_server.py:2006 fecha a sala _broadcast com 4403 se não-admin tentar
// abrir WS. Aqui a gente já evita mandar se o token não for admin, pra não
// gerar ruído no log.
//
// 08/09/2026 (v19.2) — Isaías reportou que decodeJwtPayload às vezes retorna
// payload sem campo `email` (Supabase põe em user_metadata dependendo do
// provider/refresh), fazendo jwtIsAdmin dar false mesmo pra admin real.
// FIX: NÃO confiar mais no JWT cru. Aceitar `isAdmin` boolean já resolvido
// pelo CollabPanel via `supabase.auth.getUser()` (que consulta o servidor,
// não parseia string). Manter jwtIsAdmin só como fallback síncrono pra
// compatibilidade, mas o caminho oficial agora é `checkBroadcastAdmin()`.

import { jwtIsAdmin } from './jwt'
import { supabase } from './supabase'

const BROADCAST_ROOM = '_broadcast'

const ADMIN_EMAIL = 'brisacamera34@gmail.com'

const isDev = typeof window !== 'undefined' && window.location.port === '5173'
const WS_BASE = isDev
  ? 'ws://127.0.0.1:2006/collab'
  : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/collab`

/** Fonte da verdade: pergunta ao Supabase quem tá logado e compara email.
 *  Async. Use no mount/effect — não segura render. */
export async function checkBroadcastAdmin(): Promise<boolean> {
  try {
    const { data, error } = await supabase.auth.getUser()
    if (error || !data?.user) {
      console.warn('[broadcast] checkBroadcastAdmin: getUser falhou:', error?.message || 'sem user')
      return false
    }
    const email = (data.user.email || '').trim().toLowerCase()
    const meta = data.user.user_metadata || {}
    const metaEmail = (meta.email || '').toString().trim().toLowerCase()
    console.log('[broadcast] checkBroadcastAdmin: email auth=', JSON.stringify(email), 'metadata.email=', JSON.stringify(metaEmail))
    const admin = email === ADMIN_EMAIL || metaEmail === ADMIN_EMAIL
    console.log('[broadcast] checkBroadcastAdmin: isAdmin =', admin)
    return admin
  } catch (e) {
    console.warn('[broadcast] checkBroadcastAdmin: erro:', e)
    return false
  }
}

export interface BroadcastHandle {
  /** Envia evento broadcast_state (on/off) com identificação da sala real. */
  setState: (state: 'on' | 'off', roomId: string, sender: string, jwtToken: string) => void
  /** Envia chunk de áudio (base64 data URL). */
  sendAudio: (dataUrl: string, sender: string) => void
  /** Fecha WS. */
  close: () => void
  /** Retorna Promise que resolve quando o WS está OPEN. */
  wsReady: () => Promise<void>
}

/** Abre conexão WS crua pra sala _broadcast. Sem Yjs, sem provider.
 *
 *  v19.2: aceita `isAdmin` boolean já validado por checkBroadcastAdmin()
 *  (supabase.auth.getUser). Se omitido, cai no fallback jwtIsAdmin(jwtToken)
 *  que pode falhar se o JWT não trouxer o campo email no payload (caso real
 *  reportado por Isaías 08/09 20:37 — bloqueava admin indevidamente).
 */
export function openBroadcastHandle(
  jwtToken: string,
  displayName: string,
  isAdmin?: boolean
): BroadcastHandle {
  // 08/09/2026 v19.2: trava admin via param `isAdmin` (fonte: supabase.auth.getUser).
  // Fallback síncrono via decodeJwtPayload se não vier (compat com versões antigas).
  const admin = typeof isAdmin === 'boolean' ? isAdmin : jwtIsAdmin(jwtToken)
  console.log('[broadcast] openBroadcastHandle: admin=', admin, '(via', typeof isAdmin === 'boolean' ? 'supabase.auth.getUser()' : 'fallback jwtIsAdmin', ')')
  if (!admin) {
    console.warn(
      '[broadcast] openBroadcastHandle BLOQUEADO: sessão não-admin. ' +
        'Transmissão restrita.'
    )
    // Retorna um handle "fantasma" — todas as funções são no-op logando warning.
    return {
      setState: () =>
        console.warn('[broadcast] setState SKIP (não-admin)'),
      sendAudio: () =>
        console.warn('[broadcast] sendAudio SKIP (não-admin)'),
      close: () => {},
      wsReady: () => Promise.resolve(),
    }
  }
  const url = `${WS_BASE}/${BROADCAST_ROOM}?token=${encodeURIComponent(jwtToken || '')}&display_name=${encodeURIComponent(displayName || 'Transmissor')}`
  console.log('[broadcast] openBroadcastHandle: conectando em', url)
  const ws = new WebSocket(url)
  let onStatusCallback: ((open: boolean) => void) | null = null

  ws.onopen = () => {
    console.log('[broadcast] WS onopen (OPEN)')
    if (onStatusCallback) onStatusCallback(true)
  }
  ws.onerror = (e) => {
    console.warn('[broadcast] WS onerror:', e)
  }
  ws.onclose = (e) => {
    console.log('[broadcast] WS onclose code=', e.code, 'reason=', e.reason)
    if (onStatusCallback) onStatusCallback(false)
  }
  // O collab pode mandar pings/snapshots binários Yjs — ignoramos silencioso.
  // Mas o `Unexpected end of array` vinha do y-websocket tentando parsear;
  // como NÃO usamos mais WebsocketProvider, isso não acontece mais.
  ws.onmessage = () => { /* one-way: front só envia */ }

  return {
    setState: (state, roomId, sender, jwtToken) => {
      if (ws.readyState !== WebSocket.OPEN) {
        console.warn('[broadcast] setState SKIP: readyState=', ws.readyState)
        return
      }
      try {
        ws.send(JSON.stringify({
          type: 'broadcast_state',
          state,
          room_id: roomId,
          sender,
          token: jwtToken,
          timestamp: Date.now(),
        }))
        console.log('[broadcast] setState OK:', state, 'room_id=', roomId)
      } catch (e) {
        console.warn('[broadcast] setState falhou:', e)
      }
    },
    sendAudio: (dataUrl, sender) => {
      if (ws.readyState !== WebSocket.OPEN) {
        console.warn('[BROADCAST] sendAudio SKIP: readyState=', ws.readyState)
        return
      }
      try {
        // 08/09 v19.3: bridge_server.py valida `msg.token` no payload pra
        // confirmar admin (defesa em profundidade). Sem ele, o chunk é
        // descartado silenciosamente (log "msg broadcast_audio bloqueada
        // (token ausente)"). Capturamos jwtToken do closure de openBroadcastHandle.
        ws.send(JSON.stringify({
          type: 'broadcast_audio',
          audio: dataUrl,
          sender,
          token: jwtToken,
          timestamp: Date.now(),
        }))
        console.log('[BROADCAST] Enviando chunk de áudio:', dataUrl.length, 'bytes (b64)')
      } catch (e) {
        console.warn('[broadcast] sendAudio falhou:', e)
      }
    },
    close: () => {
      try { ws.close() } catch {}
    },
    wsReady: (): Promise<void> => new Promise((resolve) => {
      if (ws.readyState === WebSocket.OPEN) {
        console.log('[broadcast] wsReady: já estava OPEN')
        resolve()
        return
      }
      // Se CLOSED ou CLOSING, tenta reconectar
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        console.warn('[broadcast] wsReady: WS em estado terminal, não resolve')
        resolve()  // send vai SKIP
        return
      }
      onStatusCallback = (open: boolean) => {
        if (open) {
          onStatusCallback = null
          clearTimeout(timer)
          console.log('[broadcast] wsReady: onopen → resolved')
          resolve()
        }
      }
      const timer = setTimeout(() => {
        onStatusCallback = null
        const rs = ws.readyState
        if (rs === WebSocket.OPEN) {
          console.log('[broadcast] wsReady: timeout 30s mas OPEN → resolved')
          resolve()
        } else {
          console.warn('[broadcast] wsReady: timeout 30s, readyState=', rs, '— send vai SKIP')
          resolve()
        }
      }, 30000)
    }),
  }
}

/** Dispara evento global de ducking pro AmbientRadioPlayer escutar. */
export function dispatchPttActive(active: boolean, source: 'px' | 'studio' = 'px') {
  try {
    window.dispatchEvent(new CustomEvent('leitor:ptt-active', {
      detail: { active, source },
    }))
  } catch {}
}
