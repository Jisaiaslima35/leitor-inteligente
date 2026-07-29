import { createClient } from '@supabase/supabase-js'

/**
 * Cliente Supabase singleton. Aceita env vars de build (VITE_*).
 * Validei em 28/07/2026 no Leitor Inteligente.
 *
 * Setup:
 *   1. Criar `.env.production`:
 *        VITE_SUPABASE_URL=https://<ref>.supabase.co
 *        VITE_SUPABASE_ANON_KEY=eyJ...   ← JWT do tipo "anon" (NÃO service_role!)
 *   2. `npm install @supabase/supabase-js`
 *   3. Em build: `npm run build` bakea as env vars no JS bundle
 *
 * Pitfall #21 da SKILL.md: usar `service_role` no front vaza TODA a RLS.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('[supabase] VITE_SUPABASE_URL ou VITE_SUPABASE_ANON_KEY ausentes')
}

export const supabase = createClient(SUPABASE_URL ?? '', SUPABASE_ANON_KEY ?? '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})

export const SUPABASE_READY = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)
