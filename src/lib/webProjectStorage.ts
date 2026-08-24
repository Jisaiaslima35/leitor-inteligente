// webProjectStorage.ts — persistência dos "Projetos Web" da Sala Dev no Supabase.
// ISAÍAS 24/08/2026 (P7) — escolheu Supabase em vez de localStorage pra ter
// sync cross-device (celular ↔ PC).
//
// Tabela web_projects:
//   id           uuid pk default gen_random_uuid()
//   user_id      uuid not null  → auth.users
//   book_id      text not null  → ebooks.slug (text, não uuid)
//   files        jsonb not null → { '/index.html': '...', '/styles.css': '...', '/script.js': '...' }
//   updated_at   timestamptz default now()
//   UNIQUE (user_id, book_id)  → 1 projeto por user por livro
//   RLS: cada user lê/escreve só os próprios
//
// Funções expostas:
//   loadWebProject(userId, bookId)       → WebProjectFiles | null
//   saveWebProject(userId, bookId, files) → ok | error string
//   deleteWebProject(userId, bookId)      → ok | error string

import { supabase } from './supabase'

export interface WebProjectFiles {
  '/index.html': string
  '/styles.css': string
  '/script.js': string
}

/** Template didático padrão — primeiro acesso do aluno. */
export const DEFAULT_WEB_PROJECT: WebProjectFiles = {
  '/index.html':
    "<!DOCTYPE html>\n" +
    "<html>\n<head>\n" +
    "  <link rel='stylesheet' href='styles.css'>\n" +
    "</head>\n<body>\n" +
    "  <h1>Meu Projeto Web</h1>\n" +
    "  <p>Edita o HTML à esquerda e vê o resultado aqui!</p>\n" +
    "  <script src='script.js'></script>\n" +
    "</body>\n</html>\n",
  '/styles.css':
    "body {\n" +
    "  font-family: sans-serif;\n" +
    "  background: #f4f4f4;\n" +
    "  color: #333;\n" +
    "  text-align: center;\n" +
    "  padding: 2rem;\n" +
    "}\n" +
    "h1 { color: #2563eb; }\n",
  '/script.js':
    "console.log('Projeto carregado com sucesso!');\n" +
    "document.addEventListener('DOMContentLoaded', () => {\n" +
    "  console.log('DOM pronto pra brincar');\n" +
    "});\n",
}

/** Valida estrutura mínima de files. Aceita extras mas exige os 3 canônicos. */
function isValidFiles(files: unknown): files is WebProjectFiles {
  if (!files || typeof files !== 'object') return false
  const f = files as Record<string, unknown>
  return (
    typeof f['/index.html'] === 'string' &&
    typeof f['/styles.css'] === 'string' &&
    typeof f['/script.js'] === 'string'
  )
}

/** Carrega projeto do Supabase. Retorna null se não existir ou erro. */
export async function loadWebProject(
  userId: string,
  bookId: string,
): Promise<WebProjectFiles | null> {
  if (!userId || !bookId) return null
  try {
    const { data, error } = await supabase
      .from('web_projects')
      .select('files')
      .eq('user_id', userId)
      .eq('book_id', bookId)
      .maybeSingle()
    if (error) {
      console.warn('[webProjectStorage] load erro:', error.message)
      return null
    }
    if (!data) return null
    if (!isValidFiles(data.files)) {
      console.warn('[webProjectStorage] files inválido, descartando')
      return null
    }
    return data.files
  } catch (e: any) {
    console.warn('[webProjectStorage] load exception:', e?.message)
    return null
  }
}

/** Salva (upsert) projeto. Retorna true se ok, false se erro. */
export async function saveWebProject(
  userId: string,
  bookId: string,
  files: WebProjectFiles,
): Promise<boolean> {
  if (!userId || !bookId) return false
  if (!isValidFiles(files)) return false
  try {
    const { error } = await supabase
      .from('web_projects')
      .upsert(
        {
          user_id: userId,
          book_id: bookId,
          files,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,book_id' },
      )
    if (error) {
      console.warn('[webProjectStorage] save erro:', error.message)
      return false
    }
    return true
  } catch (e: any) {
    console.warn('[webProjectStorage] save exception:', e?.message)
    return false
  }
}

/** Apaga projeto. */
export async function deleteWebProject(
  userId: string,
  bookId: string,
): Promise<boolean> {
  if (!userId || !bookId) return false
  try {
    const { error } = await supabase
      .from('web_projects')
      .delete()
      .eq('user_id', userId)
      .eq('book_id', bookId)
    if (error) {
      console.warn('[webProjectStorage] delete erro:', error.message)
      return false
    }
    return true
  } catch (e: any) {
    console.warn('[webProjectStorage] delete exception:', e?.message)
    return false
  }
}

/**
 * Trunca payload pra caber no limite de ~5000 chars do /feedback.
 * Mantém CSS e JS inteiros (didáticos), encolhe HTML priorizando head e
 * primeiras tags do body. Estratégia: se total > MAX, pega head completo +
 * primeiros N chars do body. Se ainda passar, trunca o CSS (último recurso).
 *
 * Regra do Isaías: NÃO subir limite do /feedback — manter consistência de
 * segurança em todos os modos.
 */
export function truncateForFeedback(
  files: WebProjectFiles,
  max: number = 4500,
): { payload: string; truncated: boolean; reason?: string } {
  // Monta payload completo
  const full = [
    'HTML:',
    files['/index.html'],
    '',
    'CSS:',
    files['/styles.css'],
    '',
    'JS:',
    files['/script.js'],
  ].join('\n')

  if (full.length <= max) {
    return { payload: full, truncated: false }
  }

  // Estratégia 1: trunca body do HTML (preserva head + início do body)
  const html = files['/index.html']
  const headEnd = html.toLowerCase().indexOf('</head>')
  const bodyStart = html.toLowerCase().indexOf('<body')
  const bodyEnd = html.toLowerCase().indexOf('</body>')
  let htmlTrimmed = html
  if (headEnd > 0 && bodyStart > headEnd && bodyEnd > bodyStart) {
    const head = html.slice(0, headEnd + '</head>'.length)
    const bodyKeep = 800 // chars do início do body
    const bodyRest = html.slice(bodyStart, bodyEnd + '</body>'.length)
    const bodyTruncated =
      bodyRest.length > bodyKeep
        ? bodyRest.slice(0, bodyKeep) + '\n<!-- ... (truncado) -->\n'
        : bodyRest
    htmlTrimmed = head + '\n' + bodyTruncated
  }

  let payload = [
    'HTML:',
    htmlTrimmed,
    '',
    'CSS:',
    files['/styles.css'],
    '',
    'JS:',
    files['/script.js'],
  ].join('\n')

  if (payload.length <= max) {
    return {
      payload,
      truncated: true,
      reason: 'HTML truncado (body depois de 800 chars)',
    }
  }

  // Estratégia 2: trunca CSS se ainda passar (preserva head do HTML + JS inteiro)
  const css = files['/styles.css']
  const cssKeep = Math.max(0, max - (htmlTrimmed.length + files['/script.js'].length + 50))
  if (cssKeep > 200) {
    payload = [
      'HTML:',
      htmlTrimmed,
      '',
      'CSS (truncado):',
      css.slice(0, cssKeep) + '\n/* ... */\n',
      '',
      'JS:',
      files['/script.js'],
    ].join('\n')
    return {
      payload,
      truncated: true,
      reason: 'CSS truncado (último recurso)',
    }
  }

  // Estratégia 3: trunca JS (raro acontecer se CSS não salvou)
  const js = files['/script.js']
  const jsKeep = Math.max(0, max - (htmlTrimmed.length + 200))
  payload = [
    'HTML:',
    htmlTrimmed,
    '',
    'CSS:',
    '(omitido — projeto muito grande)',
    '',
    'JS (truncado):',
    js.slice(0, jsKeep) + '\n// ...\n',
  ].join('\n')
  return {
    payload,
    truncated: true,
    reason: 'CSS omitido + JS truncado',
  }
}
