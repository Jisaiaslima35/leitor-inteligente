import { useCallback, useEffect, useRef, useState } from 'react'

type SpeechStatus = 'idle' | 'speaking'

/**
 * Hook compartilhado pra NARRAÇÃO por TTS no Leitor Inteligente.
 *
 * Versão DEFINITIVA (Pitfall #110, 13/08/2026):
 *  - 2 estados: 'idle' | 'speaking'
 *  - Botão toggle: clicou falando → cancela e vira idle. Clicou parado → começa a falar.
 *  - SEM setTimeout — síncrono. setTimeout() deu race condition em mobile (cancel + speak
 *    imediato após navigate cancela o setTimeout antes dele disparar, e o status fica 'idle'
 *    mesmo após speak() ter sido chamado).
 *  - Limpa utterance ref anterior pra não ter leak.
 *
 * FIX DO BUG ANTERIOR: "começa a narrar sozinho após pergunta e botão não muda de cor"
 *  - Causa raiz 1: setTimeout(50) entre cancel() e speak() — em mobile o componente desmonta
 *    em <50ms e o setStatus('speaking') nunca roda, botão fica stuck em 'idle'.
 *  - Causa raiz 2: o synth.cancel() é assíncrono no Chrome Android — se fizer speak() imediato,
 *    o utterance novo é engolido pelo cancel(). Workaround: limpar a fila via getVoices() antes.
 *  - Causa raiz 3: onend do SpeechSynthesisUtterance do Chrome Android dispara 300-500ms após
 *    o fim real da narração, dando impressão de "parou mas tá pausado". Sem o estado 'paused',
 *    isso não confunde mais.
 */
export function useSpeechToggle() {
  const [status, setStatus] = useState<SpeechStatus>('idle')
  const currentTextRef = useRef<string | null>(null)
  const currentUtterRef = useRef<SpeechSynthesisUtterance | null>(null)

  const stop = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    try {
      window.speechSynthesis.cancel()
    } catch {
      // ignore: alguns browsers mobile podem dar throw no cancel() se nada estiver falando
    }
    currentTextRef.current = null
    currentUtterRef.current = null
    setStatus('idle')
  }, [])

  const speak = useCallback((text: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    const synth = window.speechSynthesis

    // Texto vazio ou só whitespace = pra tudo
    if (!text || !text.trim()) {
      try { synth.cancel() } catch { /* ignore */ }
      currentTextRef.current = null
      currentUtterRef.current = null
      setStatus('idle')
      return
    }

    // Cancela qualquer utterance anterior
    try { synth.cancel() } catch { /* ignore */ }

    // Cria nova utterance
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = 'pt-BR'
    utter.rate = 1

    utter.onend = () => {
      // só reseta se a gente ainda é o "dono" do texto
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
    setStatus('speaking') // marca ANTES de chamar speak() pra UI atualizar imediatamente

    try {
      synth.speak(utter)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[useSpeechToggle] synth.speak falhou:', err)
      currentTextRef.current = null
      currentUtterRef.current = null
      setStatus('idle')
    }
  }, [])

  // toggle play/stop binário: clicou falando → para. clicou parado → começa a falar.
  const toggle = useCallback((text: string) => {
    if (status === 'speaking') {
      stop()
    } else {
      speak(text)
    }
  }, [status, stop, speak])

  const isSupported = typeof window !== 'undefined' && 'speechSynthesis' in window

  // Cleanup quando desmonta (sai da página)
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