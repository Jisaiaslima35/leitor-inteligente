// Helpers de JWT Supabase pro front.
//
// 08/09/2026 — Claudinho (trava admin no Estúdio de Transmissão).
//
// Não validamos a assinatura (confiamos no Nginx/CollabServer). Só
// decodificamos o payload pra extrair email/user_id e checar se o user
// é admin (em hard-coded ou lista passada).

const SUPABASE_ADMIN_EMAILS = (
  // Lista re-buildada em build-time. Mantida em sincronia com o ADMIN_EMAIL
  // env do collab_server / bridge_server. Se mudar, rodar build.
  (import.meta as any).env?.VITE_ADMIN_EMAILS ||
  'brisacamera34@gmail.com'
)
  .split(',')
  .map((s: string) => s.trim().toLowerCase())
  .filter(Boolean)

export interface JwtPayload {
  sub?: string
  email?: string
  exp?: number
  role?: string
  user_role?: string
  [k: string]: unknown
}

/** Decodifica payload do JWT sem validar assinatura. Retorna null se inválido. */
export function decodeJwtPayload(token: string | null | undefined): JwtPayload | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payloadB64 = parts[1]
    const padded = payloadB64 + '='.repeat((-payloadB64.length % 4))
    const payload = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')))
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000) - 60) {
      return null
    }
    return payload
  } catch {
    return null
  }
}

/** Email do JWT (lowercase) ou null. */
export function jwtEmail(token: string | null | undefined): string | null {
  const p = decodeJwtPayload(token)
  if (!p) return null
  const email = (typeof p.email === 'string' ? p.email : '').trim().toLowerCase()
  return email || null
}

/** User ID (sub) do JWT ou null. */
export function jwtUserId(token: string | null | undefined): string | null {
  const p = decodeJwtPayload(token)
  if (!p || typeof p.sub !== 'string') return null
  return p.sub
}

/** True se o JWT pertence a um dos emails admin. */
export function jwtIsAdmin(token: string | null | undefined): boolean {
  const email = jwtEmail(token)
  if (!email) return false
  return SUPABASE_ADMIN_EMAILS.includes(email)
}

/** Lista de emails admin (read-only). Útil pra debug/exibição na UI. */
export const ADMIN_EMAILS = SUPABASE_ADMIN_EMAILS
