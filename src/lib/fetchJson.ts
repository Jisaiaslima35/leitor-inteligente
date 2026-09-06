// fetch com timeout via AbortController. Devolve {ok, status, json, raw, contentType}.
// Se Content-Type não for JSON (ex.: nginx 504 HTML), `json` é null e `raw` tem o HTML.
// Isso evita erro "Unexpected token '<'" no frontend quando o upstream devolve HTML.

export interface FetchJsonResult<T = any> {
  ok: boolean
  status: number
  json: T | null
  raw: string
  contentType: string
  timedOut?: boolean
  parseError?: string
  error?: string
}

export async function fetchJson<T = any>(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<FetchJsonResult<T>> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    const ct = res.headers.get('content-type') || ''
    const raw = await res.text()
    if (!ct.includes('application/json')) {
      return {
        ok: res.ok,
        status: res.status,
        json: null,
        raw,
        contentType: ct,
        timedOut: false,
      }
    }
    try {
      return {
        ok: res.ok,
        status: res.status,
        json: JSON.parse(raw) as T,
        raw,
        contentType: ct,
        timedOut: false,
      }
    } catch (e: any) {
      return {
        ok: false,
        status: res.status,
        json: null,
        raw,
        contentType: ct,
        parseError: e?.message,
        timedOut: false,
      }
    }
  } catch (e: any) {
    const aborted = e?.name === 'AbortError'
    return {
      ok: false,
      status: 0,
      json: null,
      raw: '',
      contentType: '',
      timedOut: aborted,
      error: e?.message,
    }
  } finally {
    clearTimeout(t)
  }
}
