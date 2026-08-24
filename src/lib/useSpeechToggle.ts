import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type SpeechStatus = 'idle' | 'speaking'

// Vozes MiniMax usadas no Professor IA.
// Modo Mentor (system prompt do Mentor do livro) → voz masculina varonil.
// Modo normal (Professor IA padrão) → voz feminina PT-BR.
// Isaías escolheu essas em 23/08/2026 após ouvir amostras.
const VOICE_MENTOR = 'Portuguese_Deep-VoicedGentleman'
const VOICE_NORMAL = 'female-shaonv'

/**
 * Hook compartilhado pra NARRAÇÃO por TTS no Leitor Inteligente.
 *
 * Histórico de versões:
 *  v1: useState('idle'|'speaking'|'paused') + pause/resume nativo
 *      → Botão ficava stuck em 'paused' no mobile, sem narrar nem parar
 *  v2: useState binário + setTimeout(50) entre cancel e speak
 *      → setTimeout trava em mobile quando componente desmonta
 *  v3: 2 estados binários + requestAnimationFrame + pickVoice fallback
 *      + onvoiceschanged listener
 *  v4 (14/08/2026): mesmo de v3 PLUS return useMemo
 *      → BUG do Isaías: hook retornava objeto NOVO a cada render, então o
 *        useEffect(() => () => speech.stop(), [speech]) do ProfessorChat
 *        cancelava a fala IMEDIATAMENTE assim que a resposta do Professor
 *        chegava (cada setMessages re-renderiza o componente). Fix:
 *        useMemo estabiliza o retorno, speech não muda mais entre renders.
 *      → botões do Professor IA não iniciavam a fala pelo mesmo motivo.
 *      → PLUS: 3 RAF (não 2) entre cancel() e speak() pra Chrome Android
 *        que tem delay maior pra enfileirar utterance.
 *  v5 (23/08/2026 1ª): aceita `useCloudTts` (boolean). Quando true, usa
 *      fetch /leitor-inteligente/tts-api/tts (MiniMax Audio Starter
 *      R$13,50, voz Portuguese_Deep-VoicedGentleman) + elemento <audio>.
 *      Quando false, mantém speechSynthesis nativo (voz do browser).
 *      Mapeamento: Modo Mentor = useCloudTts=true (voz do Mentor),
 *      modo normal = useCloudTts=false (voz nativa do browser).
 *  v6 (23/08/2026 2ª): SEMPRE usa MiniMax (sem fallback nativo). Isaías
 *      pediu voz MiniMax em ambos os modos (igual nas rádios com voz
 *      clonada). O param agora é `modoMentor` e seleciona a voz:
 *        - modoMentor=true  → VOICE_MENTOR (Portuguese_Deep-VoicedGentleman)
 *        - modoMentor=false → VOICE_NORMAL (female-shaonv)
 *      Removido todo o código de speechSynthesis nativo — agora só TTS cloud.
 */
export function useSpeechToggle(modoMentor: boolean = false) {
  const [status, setStatus] = useState<SpeechStatus>('idle')
  const [debugInfo, setDebugInfo] = useState<string>('') // aparece na UI pra debug
  const currentTextRef = useRef<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const voiceId = modoMentor ? VOICE_MENTOR : VOICE_NORMAL

  const log = useCallback((msg: string) => {
    // eslint-disable-next-line no-console
    console.log('[TTS]', msg)
    setDebugInfo((prev) => prev + ' | ' + msg)
    // mantém só últimas 3 mensagens
    setDebugInfo((prev) => {
      const parts = prev.split(' | ').filter(Boolean)
      const last3 = parts.slice(-3).join(' | ')
      return last3
    })
  }, [])

  const stop = useCallback(() => {
    if (audioRef.current) {
      try {
        audioRef.current.pause()
        audioRef.current.currentTime = 0
        audioRef.current.src = ''
      } catch (e) {
        log(`stop pause fail: ${(e as Error).message}`)
      }
    }
    currentTextRef.current = null
    log(`stopped (voice=${voiceId})`)
    setStatus('idle')
  }, [log, voiceId])

  const speak = useCallback(async (text: string) => {
    // v6: SEMPRE MiniMax via proxy. Voz decidida pelo modoMentor.
    if (!text || !text.trim()) {
      if (audioRef.current) {
        try { audioRef.current.pause(); audioRef.current.src = '' } catch { /* ignore */ }
      }
      currentTextRef.current = null
      setStatus('idle')
      return
    }

    log(`speak(voice=${voiceId} "${text.slice(0, 30)}...")`)

    // Para qualquer audio anterior antes de buscar novo
    if (audioRef.current) {
      try { audioRef.current.pause(); audioRef.current.currentTime = 0 } catch { /* ignore */ }
    }

    try {
      const res = await fetch('/leitor-inteligente/tts-api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice_id: voiceId }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        log(`❌ TTS erro: ${err.error || res.status}`)
        currentTextRef.current = null
        setStatus('idle')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)

      const audio = new Audio(url)
      audioRef.current = audio
      currentTextRef.current = text

      audio.onended = () => {
        log('audio.onended')
        if (currentTextRef.current === text) {
          currentTextRef.current = null
          audioRef.current = null
          URL.revokeObjectURL(url)
          setStatus('idle')
        }
      }
      audio.onerror = (event) => {
        log(`❌ audio.onerror: ${(event as ErrorEvent).message || 'desconhecido'}`)
        if (currentTextRef.current === text) {
          currentTextRef.current = null
          audioRef.current = null
          URL.revokeObjectURL(url)
          setStatus('idle')
        }
      }

      setStatus('speaking')
      log('state → speaking')
      try {
        await audio.play()
        log('audio.play() ok')
      } catch (playErr) {
        // Autoplay pode ser bloqueado em mobile até o user interagir.
        // Nesse caso, fica em 'speaking' mas o user precisa tocar de novo.
        log(`❌ audio.play() falhou: ${(playErr as Error).message}`)
      }
    } catch (err) {
      log(`❌ fetch TTS falhou: ${(err as Error).message}`)
      currentTextRef.current = null
      setStatus('idle')
    }
  }, [log, voiceId])

  const toggle = useCallback((text: string) => {
    if (status === 'speaking') {
      stop()
    } else {
      speak(text)
    }
  }, [status, stop, speak])

  // TTS cloud sempre disponível (basta network). Não checa mais
  // speechSynthesis do browser — MiniMax provê a voz.
  const isSupported = true

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        try { audioRef.current.pause(); audioRef.current.src = '' } catch { /* ignore */ }
      }
      currentTextRef.current = null
    }
  }, [])

  // v4: estabiliza o retorno com useMemo pra evitar que qualquer consumer
  // do hook (ProfessorChat, useEffect com [speech]) re-rode cleanup em
  // todo render e cancele a fala no meio.
  return useMemo(
    () => ({ status, speak, stop, toggle, isSupported, debugInfo, voiceId }),
    [status, speak, stop, toggle, isSupported, debugInfo, voiceId],
  )
}