import { supabase, SUPABASE_READY } from './supabase'

export interface Streak {
  current_streak: number
  best_streak: number
  last_read_date: string | null
  days_with_progress: number
}

export async function fetchStreak(): Promise<Streak | null> {
  if (!SUPABASE_READY) return null
  const { data: session } = await supabase.auth.getSession()
  if (!session.session) return null
  const user_id = session.session.user.id
  const r = await fetch(`${import.meta.env.BASE_URL}streak-api/streak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id }),
  })
  if (!r.ok) return null
  return r.json()
}