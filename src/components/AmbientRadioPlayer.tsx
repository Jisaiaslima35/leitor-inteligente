// Player ambiente da Web Rádio Devocional 12 — toca em todas as páginas
// do Leitor Inteligente com volume baixo, slider de mute e ducking
// automático quando alguém fala no Rádio PX (Estudo em Dupla).
//
// 07/09/2026 — Claudinho (v15 — Estúdio de Transmissão ao Vivo).
//
// Stream: Icecast público exposto via CF Tunnel em azuracast.automacaojs.us
// (porta 9010 → radio.mp3). Cross-origin ok, audio/mpeg.
// Ducking: escuta `leitor:ptt-active` (CustomEvent). Quando alguém pressiona
// PX, fade 300ms para 0.02; ao soltar, fade 500ms volta ao volume do slider.

import { useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX, Radio } from 'lucide-react'

const STREAM_URL = 'https://azuracast.automacaojs.us/radio.mp3'
const LS_KEY_VOLUME = 'leitor:ambient-radio:volume'
const LS_KEY_MUTED = 'leitor:ambient-radio:muted'
const DEFAULT_VOLUME = 0.15
const DUCK_VOLUME = 0.02  // quase mudo, mas deixa leve respiração
const FADE_S = 0.3

export function AmbientRadioPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const gainRef = useRef<number>(DEFAULT_VOLUME)  // "volume desejado" (slider)
  const [muted, setMuted] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_KEY_MUTED) === '1' } catch { return false }
  })
  const [volume, setVolume] = useState<number>(() => {
    try {
      const v = parseFloat(localStorage.getItem(LS_KEY_VOLUME) || '')
      if (!Number.isNaN(v) && v >= 0 && v <= 1) return v
    } catch {}
    return DEFAULT_VOLUME
  })
  const [playing, setPlaying] = useState(false)
  const [ducked, setDucked] = useState(false)
  const [show, setShow] = useState(false)  // minimizar/expandir painel
  const lastApplyRef = useRef<number>(0)

  // ── Cria <audio> lazy ─────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (audioRef.current) return
    const audio = new Audio(STREAM_URL)
    audio.preload = 'none'  // só carrega metadados — não queremos gastar banda do ouvinte
    audio.crossOrigin = 'anonymous'
    audio.loop = true  // stream ao vivo, ao terminar reabre
    audio.volume = muted ? 0 : volume
    audioRef.current = audio

    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onErr = (e: Event) => {
      console.warn('[AmbientRadio] erro no stream:', e)
      setPlaying(false)
    }
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('error', onErr)
    return () => {
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('error', onErr)
      audio.pause()
      audioRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Aplica volume com fade (CSS-like suave) ───────────────────────────
  const applyVolume = (target: number, fadeS = FADE_S) => {
    const audio = audioRef.current
    if (!audio) return
    const now = audio.volume
    const steps = 8
    const stepMs = (fadeS * 1000) / steps
    let i = 0
    const tick = () => {
      i++
      const t = i / steps
      audio.volume = now + (target - now) * t
      if (i < steps) setTimeout(tick, stepMs)
    }
    tick()
  }

  // ── Volume slider → aplica ────────────────────────────────────────────
  useEffect(() => {
    gainRef.current = volume
    try { localStorage.setItem(LS_KEY_VOLUME, String(volume)) } catch {}
    const audio = audioRef.current
    if (!audio) return
    if (muted) {
      audio.volume = 0
      return
    }
    // Se tá ducking, mantém baixo; se não, aplica normal
    applyVolume(ducked ? DUCK_VOLUME : volume, FADE_S)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume])

  // ── Mute toggle ───────────────────────────────────────────────────────
  useEffect(() => {
    try { localStorage.setItem(LS_KEY_MUTED, muted ? '1' : '0') } catch {}
    const audio = audioRef.current
    if (!audio) return
    applyVolume(muted ? 0 : (ducked ? DUCK_VOLUME : volume), 0.15)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muted])

  // ── Ducking: escuta CustomEvent global do Rádio PX / Transmitir ──────
  useEffect(() => {
    const onPtt = (e: Event) => {
      const detail = (e as CustomEvent<{ active: boolean; source?: string }>).detail
      const active = !!detail?.active
      setDucked(active)
      const audio = audioRef.current
      if (!audio) return
      applyVolume(muted ? 0 : (active ? DUCK_VOLUME : volume), FADE_S)
    }
    window.addEventListener('leitor:ptt-active', onPtt)
    return () => window.removeEventListener('leitor:ptt-active', onPtt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muted, volume])

  // ── Autoplay (best-effort, mobile exige gesture) ─────────────────────
  const ensurePlaying = () => {
    const audio = audioRef.current
    if (!audio || playing) return
    audio.play().catch((err) => {
      // Autoplay bloqueado — usuário precisa clicar uma vez
      console.info('[AmbientRadio] autoplay bloqueado, aguardando clique do usuário')
    })
  }
  // Tenta autoplay uma vez (alguns browsers liberam sem gesto pra mídia sem som,
  // mas stream de áudio vai falhar — fica aguardando 1º clique no botão 🔊).
  useEffect(() => {
    const t = setTimeout(() => ensurePlaying(), 1500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── UI ────────────────────────────────────────────────────────────────
  return (
    <div
      // 07/09/2026: header fixo canto superior direito (acima de qualquer modal,
      // abaixo do Topbar). z-40 pra não cobrir checkout. Painel compacto
      // quando show=false (só ícone + bolinha on/off); expande no hover/clique.
      style={{
        position: 'fixed',
        top: 64,
        right: 16,
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: show ? '8px 12px' : '6px 8px',
        background: 'rgba(15, 27, 45, 0.92)',
        backdropFilter: 'blur(8px)',
        border: '1px solid #2F3B4D',
        borderRadius: 999,
        color: '#F0E8D8',
        fontSize: 12,
        boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
        transition: 'padding 0.2s ease, background 0.2s ease',
      }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      role="region"
      aria-label="Player ambiente Web Rádio Devocional 12"
    >
      <Radio size={14} color={playing ? '#86efac' : '#f87171'} />
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: playing ? '#4ade80' : '#f87171',
        boxShadow: playing ? '0 0 6px #4ade80' : 'none',
      }} />
      {show && (
        <>
          <span style={{ opacity: 0.8, whiteSpace: 'nowrap' }}>Devocional 12</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              setVolume(v)
              if (v > 0 && muted) setMuted(false)
              ensurePlaying()
            }}
            aria-label="Volume da rádio"
            style={{
              width: 80,
              accentColor: '#E8A547',
              cursor: 'pointer',
            }}
          />
          <button
            type="button"
            onClick={() => {
              setMuted((m) => !m)
              ensurePlaying()
            }}
            aria-label={muted ? 'Ativar som' : 'Silenciar rádio'}
            title={muted ? 'Ativar som' : 'Silenciar'}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#F0E8D8',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              padding: 2,
              borderRadius: 4,
            }}
          >
            {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
        </>
      )}
    </div>
  )
}

export default AmbientRadioPlayer