// Helpers pra converter PCM cru (s16le 16kHz mono) em base64 data URL
// pra enviar pelo WebSocket do broadcast.
//
// 07/09/2026 — Claudinho (v18.1).
//
// v18.1: trocou MediaRecorder+decodeAudioData por ScriptProcessorNode que
// captura PCM direto da placa @ 16kHz mono. Sem WebM, sem decode, sem
// EncodingError. O bridge consome PCM cru no stdin do ffmpeg.

/** Converte ArrayBuffer de bytes s16le em base64 data URL pronto pra enviar. */
export function pcmToBase64DataUrl(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  // Converte em chunks pra evitar stack overflow em strings grandes
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return `data:audio/pcm-s16le;base64,${btoa(bin)}`
}
