import { useCallback, useEffect, useRef, useState } from 'react'

type SpeechStatus = 'idle' | 'speaking'

/**
 * Hook compartilhado pra NARRAÇÃO por TTS no Leitor Inteligente.
 *
 * Versão BLINDADA (Pitfall #110, 13/08/2026 + review Claude 13/08):
 *
 * BUGS RESOLVIDOS (Claude auditar 13/08/2026):
 *  1. Botão não ficava verde em celular sem voz pt-BR instalada:
 *     Agora resolve voz com fallback → pt-BR → pt-PT → pt-* → en-US.
 *     Loga console.warn quando cai no fallback pra Isaías saber.
 *
 *  2. cancel() + speak() imediato engole utterance nova (Chrome Android):
 *     Espera onvoiceschanged ou 2x requestAnimationFrame antes de speak().
 *     Race condition evitada sem setTimeout solto.
 *
 * API mantida idêntica ao anterior (status, speak, stop, toggle, isSupported).
 */
export function useSpeechToggle() {
  const [status, setStatus] = useState<SpeechStatus>('idle')
  const currentTextRef = useRef<string | null>(null)
  const currentUtterRef = useRef<SpeechSynthesisUtterance | null>(null)
  const voicesPromiseRef = useRef<Promise<SpeechSynthesisVoice[]> | null>(null)

  /**
   * Carrega lista de vozes — Chrome Android dispara onvoiceschanged assíncrono.
   * Cacheia a Promise pra chamadas repetidas não recarregarem.
   */
  const getVoices = useCallback((): Promise<SpeechSynthesisVoice[]> => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return Promise.resolve([])
    }
    const synth = window.speechSynthesis

    if (voicesPromiseRef.current) return voicesPromiseRef.current

    voicesPromiseRef.current = new Promise<SpeechSynthesisVoice[]>((resolve) => {
      const initial = synth.getVoices()
      if (initial && initial.length > 0) {
        resolve(initial)
        return
      }

      // Chrome Android dispara onvoiceschanged depois. Espera no máximo 500ms.
      let resolved = false
      const cleanup = () => {
        synth.removeEventListener?.('voiceschanged', onChange)
      }
      const onChange = () => {
        if (resolved) return
        resolved = true
        cleanup()
        resolve(synth.getVoices())
      }
      synth.addEventListener?.('voiceschanged', onChange)

      // Fallback de timeout: resolve com lista vazia se nunca vier evento
      setTimeout(() => {
        if (resolved) return
        resolved = true
        cleanup()
        resolve(synth.getVoices())
      }, 500)
    })

    return voicesPromiseRef.current
  }, [])

  /**
   * Escolhe a melhor voz PT-BR disponível com fallback progressivo.
   * Logs warn se cair fora do pt-BR.
   */
  const pickVoice = useCallback(async (): Promise<SpeechSynthesisVoice | null> => {
    const voices = await getVoices()
    if (voices.length === 0) return null

    const ptBR = voices.find((v) => v.lang === 'pt-BR' || v.lang === 'pt_BR')
    if (ptBR) return ptBR

    // Fallback 1: qualquer pt-* (pt-PT, pt-AO, etc)
    const anyPt = voices.find((v) => v.lang.startsWith('pt'))
    if (anyPt) {
      // eslint-disable-next-line no-console
      console.warn(`[useSpeechToggle] voz pt-BR não encontrada, usando fallback ${anyPt.lang} (${anyPt.name}). Instale voz pt-BR no sistema pra melhor experiência.`)
      return anyPt
    }

    // Fallback 2: en-US (mais natural que francês ou espanhol pra leitor brasileiro)
    const enUS = voices.find((v) => v.lang === 'en-US' || v.lang === 'en_US' || v.lang.startsWith('en'))
    if (enUS) {
      // eslint-disable-next-line no-console
      console.warn(`[useSpeechToggle] nenhuma voz pt-* instalada. Usando fallback ${enUS.lang} (${enUS.name}). Texto será narrado em inglês (com pronúncia estranha). Instale voz pt-BR no sistema.`)
      return enUS
    }

    // Último fallback: primeira voz disponível
    if (voices[0]) {
      // eslint-disable-next-line no-console
      console.warn(`[useSpeechToggle] nenhuma voz pt/en disponível, usando primeira voz do sistema: ${voices[0].lang} (${voices[0].name}).`)
      return voices[0]
    }
    return null
  }, [getVoices])

  const stop = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    try {
      window.speechSynthesis.cancel()
    } catch {
      // ignore
    }
    currentTextRef.current = null
    currentUtterRef.current = null
    setStatus('idle')
  }, [])

  /**
   * Espera 2x requestAnimationFrame pra garantir que cancel() assíncrono
   * do Chrome Android realmente processou antes de falar de novo.
   * Sem setTimeout solto.
   */
  const waitForCancel = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      let rafCount = 0
      const tick = () => {
        rafCount++
        if (rafCount >= 2) {
          resolve()
        } else {
          requestAnimationFrame(tick)
        }
      }
      requestAnimationFrame(tick)
    })
  }, [])

  const speak = useCallback(async (text: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    const synth = window.speechSynthesis

    // Texto vazio = pra tudo
    if (!text || !text.trim()) {
      try { synth.cancel() } catch { /* ignore */ }
      currentTextRef.current = null
      currentUtterRef.current = null
      setStatus('idle')
      return
    }

    // Cancela o anterior
    try { synth.cancel() } catch { /* ignore */ }
    // Espera 2 frames pra cancel() processar (Chrome Android bug)
    await waitForCancel()

    // Resolve voz (com fallback)
    const voice = await pickVoice()

    const utter = new SpeechSynthesisUtterance(text)
    if (voice) utter.voice = voice
    utter.lang = voice?.lang || 'pt-BR' // lang hint (alguns browsers ignoram utter.voice)
    utter.rate = 1

    utter.onend = () => {
      if (currentTextRef.current === text) {
        currentTextRef.current = null
        currentUtterRef.current = null
        setStatus('idle')
      }
    }
    utter.onerror = () => {
      if (currentTextRef.current === text) {
        currentTextRef.current = null
        currentUtterRef.current = null
        setStatus('idle')
      }
    }

    currentTextRef.current = text
    currentUtterRef.current = utter
    setStatus('speaking') // marca ANTES de speak() pra UI atualizar imediato

    try {
      synth.speak(utter)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[useSpeechToggle] synth.speak falhou:', err)
      currentTextRef.current = null
      currentUtterRef.current = null
      setStatus('idle')
    }
  }, [waitForCancel, pickVoice])

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

  return { status, speak, stop, toggle, isSupported }
}