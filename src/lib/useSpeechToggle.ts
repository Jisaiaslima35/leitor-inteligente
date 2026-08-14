import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type SpeechStatus = 'idle' | 'speaking'

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
 *  v4 (atual, 14/08/2026): mesmo de v3 PLUS return useMemo
 *      → BUG do Isaías: hook retornava objeto NOVO a cada render, então o
 *        useEffect(() => () => speech.stop(), [speech]) do ProfessorChat
 *        cancelava a fala IMEDIATAMENTE assim que a resposta do Professor
 *        chegava (cada setMessages re-renderiza o componente). Fix:
 *        useMemo estabiliza o retorno, speech não muda mais entre renders.
 *      → botões do Professor IA não iniciavam a fala pelo mesmo motivo.
 *      → PLUS: 3 RAF (não 2) entre cancel() e speak() pra Chrome Android
 *        que tem delay maior pra enfileirar utterance.
 */
export function useSpeechToggle() {
  const [status, setStatus] = useState<SpeechStatus>('idle')
  const [debugInfo, setDebugInfo] = useState<string>('') // aparece na UI pra debug
  const currentTextRef = useRef<string | null>(null)
  const currentUtterRef = useRef<SpeechSynthesisUtterance | null>(null)
  const voicesPromiseRef = useRef<Promise<SpeechSynthesisVoice[]> | null>(null)

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

  const getVoices = useCallback((): Promise<SpeechSynthesisVoice[]> => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return Promise.resolve([])
    }
    const synth = window.speechSynthesis

    if (voicesPromiseRef.current) return voicesPromiseRef.current

    voicesPromiseRef.current = new Promise<SpeechSynthesisVoice[]>((resolve) => {
      const initial = synth.getVoices()
      if (initial && initial.length > 0) {
        log(`Voices loaded initially: ${initial.length}`)
        resolve(initial)
        return
      }

      let resolved = false
      const cleanup = () => {
        synth.removeEventListener?.('voiceschanged', onChange)
      }
      const onChange = () => {
        if (resolved) return
        resolved = true
        cleanup()
        const v = synth.getVoices()
        log(`voiceschanged fired: ${v.length}`)
        resolve(v)
      }
      synth.addEventListener?.('voiceschanged', onChange)

      setTimeout(() => {
        if (resolved) return
        resolved = true
        cleanup()
        const v = synth.getVoices()
        log(`Timeout 500ms - voices: ${v.length}`)
        resolve(v)
      }, 500)
    })

    return voicesPromiseRef.current
  }, [log])

  const pickVoice = useCallback(async (): Promise<SpeechSynthesisVoice | null> => {
    const voices = await getVoices()
    log(`pickVoice: ${voices.length} available`)

    if (voices.length === 0) {
      log('⚠️ NENHUMA voz disponível')
      return null
    }

    const ptBR = voices.find((v) => v.lang === 'pt-BR' || v.lang === 'pt_BR')
    if (ptBR) {
      log(`✓ pt-BR: ${ptBR.name}`)
      return ptBR
    }

    const anyPt = voices.find((v) => v.lang.startsWith('pt'))
    if (anyPt) {
      log(`⚠ fallback pt-*: ${anyPt.lang} (${anyPt.name})`)
      return anyPt
    }

    const enUS = voices.find((v) => v.lang === 'en-US' || v.lang === 'en_US' || v.lang.startsWith('en'))
    if (enUS) {
      log(`⚠ fallback en: ${enUS.lang} (${enUS.name})`)
      return enUS
    }

    log(`⚠ primeira voz: ${voices[0].lang} (${voices[0].name})`)
    return voices[0]
  }, [getVoices, log])

  const stop = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    try {
      window.speechSynthesis.cancel()
    } catch (e) {
      log(`stop cancel fail: ${(e as Error).message}`)
    }
    currentTextRef.current = null
    currentUtterRef.current = null
    log('stopped')
    setStatus('idle')
  }, [log])

  const waitForCancel = useCallback((): Promise<void> => {
    // Polling real em synth.speaking / synth.pending (não contagem cega
    // de frames). Chrome Android varia o tempo de flush do cancel().
    return new Promise((resolve) => {
      const synth = window.speechSynthesis
      const start = Date.now()
      const check = () => {
        const clear = !synth.speaking && !synth.pending
        if (clear || Date.now() - start > 1500) {
          // +80ms de margem pra fila assentar
          setTimeout(resolve, 80)
        } else {
          requestAnimationFrame(check)
        }
      }
      requestAnimationFrame(check)
    })
  }, [])

  const speak = useCallback(async (text: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      log('❌ TTS não suportado neste navegador')
      return
    }
    const synth = window.speechSynthesis

    if (!text || !text.trim()) {
      try { synth.cancel() } catch { /* ignore */ }
      currentTextRef.current = null
      currentUtterRef.current = null
      setStatus('idle')
      return
    }

    log(`speak("${text.slice(0, 30)}...")`)
    log(`synth.speaking antes: ${synth.speaking}, pending: ${synth.pending}`)

    try { synth.cancel() } catch { /* ignore */ }
    await waitForCancel()
    log(`after 3 RAF + 80ms: cancelled`)

    const voice = await pickVoice()

    const utter = new SpeechSynthesisUtterance(text)
    if (voice) utter.voice = voice
    utter.lang = voice?.lang || 'pt-BR'
    utter.rate = 1

    utter.onstart = () => {
      log(`utter.onstart fired`)
    }
    utter.onend = () => {
      log(`utter.onend`)
      if (currentTextRef.current === text) {
        currentTextRef.current = null
        currentUtterRef.current = null
        setStatus('idle')
      }
    }
    utter.onerror = (event) => {
      log(`utter.onerror: ${event.error}`)
      if (currentTextRef.current === text) {
        currentTextRef.current = null
        currentUtterRef.current = null
        setStatus('idle')
      }
    }

    currentTextRef.current = text
    currentUtterRef.current = utter
    setStatus('speaking')
    log(`state → speaking`)

    try {
      synth.speak(utter)
      log(`synth.speak() chamado`)
    } catch (err) {
      log(`❌ synth.speak falhou: ${(err as Error).message}`)
      currentTextRef.current = null
      currentUtterRef.current = null
      setStatus('idle')
    }
  }, [waitForCancel, pickVoice, log])

  const toggle = useCallback((text: string) => {
    if (status === 'speaking') {
      stop()
    } else {
      speak(text)
    }
  }, [status, stop, speak])

  const isSupported = typeof window !== 'undefined' && 'speechSynthesis' in window

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        try { window.speechSynthesis.cancel() } catch { /* ignore */ }
      }
      currentTextRef.current = null
      currentUtterRef.current = null
    }
  }, [])

  // v4: estabiliza o retorno com useMemo pra evitar que qualquer consumer
  // do hook (ProfessorChat, useEffect com [speech]) re-rode cleanup em
  // todo render e cancele a fala no meio.
  return useMemo(
    () => ({ status, speak, stop, toggle, isSupported, debugInfo }),
    [status, speak, stop, toggle, isSupported, debugInfo],
  )
}