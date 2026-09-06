// BASE_URL — origem dinâmica pra todos os paths da API/WS/convite.
//
// 06/09/2026 v11 Isaías: migração do Leitor de preview.automacaojs.us
// (path /leitor-inteligente/) pra leitorinteligente.automacaojs.us (raiz /).
// Antes os caminhos eram hardcoded como `${BASE_URL}/api/...` —
// isso quebrava no novo subdomínio. Agora import.meta.env.BASE_URL é a
// fonte da verdade e o vite.config.ts define `base: '/'` pra produção.
//
// `BASE_URL` é SEMPRE relativa — começa e termina com `/` (ou é só `/`).
// Pra montar URL absoluta use `window.location.origin + BASE_URL`.
//
// Exemplos:
//   fetch(`${BASE_URL}api/quiz/score?...`)
//   fetch(`${BASE_URL}signed-url-api/sign`)
//   fetch(`${BASE_URL}upload-api/api/admin/upload-book`)
//   fetch(`${BASE_URL}ws/collab`) // WS — mas no front usamos `${proto}//${host}${BASE_URL}ws/collab`
//
// Em preview ainda funciona porque BASE_URL volta a `${BASE_URL}/`
// se o build foi feito com vite.config.ts base=`${BASE_URL}/` —
// mas como o v11 já é o build principal, BASE_URL = '/' em prod.

export const BASE_URL: string = import.meta.env.BASE_URL || '/'

/** Monta uma URL absoluta (origin + path) — útil pra compartilhar/WhatsApp. */
export function absoluteUrl(path: string): string {
  if (typeof window === 'undefined') return path
  // Se path já é absoluta (http://...), retorna como está
  if (/^https?:\/\//.test(path)) return path
  // Garante 1 barra entre origin e path
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${window.location.origin}${cleanPath}`
}
