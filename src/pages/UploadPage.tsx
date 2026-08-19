import { useEffect, useState } from 'react'
import { Upload, CheckCircle, AlertCircle, FileText, ArrowLeft, CreditCard } from 'lucide-react'
import { useAuth } from '../lib/AuthContext'
import { supabase } from '../lib/supabase'

type Status = 'idle' | 'uploading' | 'processing' | 'done' | 'error'
type AccessStatus = 'loading' | 'paid' | 'unpaid' | 'awaiting_confirmation'

interface Props {
  onBack: () => void
  onSuccess?: () => void
}

const VITE_PAYMENT_SERVER = (import.meta as any).env?.VITE_PAYMENT_SERVER_URL || 'https://pay.automacaojs.us'
const UPLOAD_FEE_CENTS = 1000  // R$10 por livro (modelo 1 pagamento = 1 upload)

export function UploadPage({ onBack, onSuccess }: Props) {
  const { user } = useAuth()
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [progress, setProgress] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [ebookId, setEbookId] = useState<string | null>(null)
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null)
  const [etaMinutes, setEtaMinutes] = useState<number>(2)

  // === Controle de acesso (pagamento de upload_fee) ===
  const [access, setAccess] = useState<AccessStatus>('loading')
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [awaitingSince, setAwaitingSince] = useState<number | null>(null)

  // 1. Ao montar, checa se o user já pagou (tem upload_payments válida)
  useEffect(() => {
    if (!user?.id) return
    checkAccess()
  }, [user?.id])

  // 2. Se voltou do Asaas (success_url), polling a cada 3s por até 5 min
  useEffect(() => {
    if (access !== 'awaiting_confirmation') return
    if (!user?.id) return
    const startedAt = awaitingSince ?? Date.now()
    const tick = async () => {
      try {
        const r = await fetch(`${VITE_PAYMENT_SERVER}/api/upload/access?user_id=${user.id}`)
        const data = await r.json()
        if (data.ok && data.has_access) {
          setAccess('paid')
          setExpiresAt(data.expires_at)
          return
        }
      } catch {
        // silencioso, tenta de novo
      }
      // Timeout 5 min
      if (Date.now() - startedAt < 5 * 60 * 1000) {
        setTimeout(tick, 3000)
      } else {
        setAccess('unpaid')
        setErrorMsg('Confirmação não chegou em 5 minutos. Tente pagar novamente.')
      }
    }
    setTimeout(tick, 3000)
  }, [access, user?.id, awaitingSince])

  // 3. Detecta se o user acabou de voltar do Asaas (hash com from=asaas)
  useEffect(() => {
    if (window.location.hash.includes('from=asaas')) {
      setAccess('awaiting_confirmation')
      setAwaitingSince(Date.now())
    }
  }, [])

  async function checkAccess() {
    if (!user?.id) return
    try {
      const r = await fetch(`${VITE_PAYMENT_SERVER}/api/upload/access?user_id=${user.id}`)
      const data = await r.json()
      if (data.ok && data.has_access) {
        setAccess('paid')
        setExpiresAt(data.expires_at)
      } else {
        setAccess('unpaid')
      }
    } catch {
      setAccess('unpaid')
    }
  }

  async function handlePayFee() {
    if (!user?.id || !user.email) return
    setErrorMsg(null)
    try {
      const r = await fetch(`${VITE_PAYMENT_SERVER}/api/upload/create-checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: user.id,
          user_email: user.email,
          success_url: 'https://preview.automacaojs.us/leitor-inteligente/#/upload?from=asaas',
          cancel_url: 'https://preview.automacaojs.us/leitor-inteligente/#/upload',
        }),
      })
      const data = await r.json()
      if (!data.ok || !data.checkout_url) {
        setErrorMsg(data.error || 'Falha ao criar checkout')
        return
      }
      // Redireciona pro Asaas. Quando voltar, success_url tem #/upload?from=asaas
      // e o useEffect acima ativa o polling.
      window.location.href = data.checkout_url
    } catch (e: any) {
      setErrorMsg(e.message || 'Erro de rede ao criar checkout')
    }
  }

  // Conta páginas do PDF via arraybuffer (mesma lógica do código original)
  const handleFile = async (f: File) => {
    if (!f.name.toLowerCase().endsWith('.pdf')) {
      setErrorMsg('Apenas PDFs são aceitos')
      return
    }
    if (f.size > 50 * 1024 * 1024) {
      setErrorMsg('Arquivo muito grande (máx 50 MB)')
      return
    }
    setFile(f)
    setErrorMsg(null)
    try {
      const buf = await f.arrayBuffer()
      const view = new Uint8Array(buf)
      const text = new TextDecoder('latin1').decode(view)
      const authorMatch = text.match(/\/Author\s*\(([^)]+)\)/)
      const titleMatch = text.match(/\/Title\s*\(([^)]+)\)/)
      const pageMatch = text.match(/\/Count\s+(\d+)/)
      if (authorMatch) setAuthor(authorMatch[1])
      if (titleMatch) setTitle(titleMatch[1])
      if (pageMatch) setPdfPageCount(Number(pageMatch[1]))
    } catch {
      // silencia
    }
  }

  const pollStatus = async (id: string) => {
    const tries = 360 // 360 × 5s = 30 min
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, 5000))
      try {
        const { data } = await supabase
          .from('user_library')
          .select('ebook_id')
          .eq('ebook_id', id)
          .eq('user_id', user!.id)
          .maybeSingle()
        if (data) {
          setStatus('done')
          setTimeout(() => onSuccess?.(), 2000)
          return
        }
      } catch (e) {
        // silêncio
      }
    }
    setErrorMsg('O processamento está demorando mais que o esperado (mais de 30min). Pode ser livro muito grande ou erro silencioso. Atualize a biblioteca em alguns minutos.')
    setStatus('error')
  }

  const startUpload = async () => {
    if (!file) {
      setErrorMsg('Selecione um PDF')
      return
    }
    setStatus('uploading')
    setProgress(0)
    setErrorMsg(null)

    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (!token) throw new Error('Sessão inválida')

      // 1. Signed URL upload
      const urlRes = await fetch(`${import.meta.env.BASE_URL}upload-api/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ filename: file.name }),
      })
      if (!urlRes.ok) throw new Error(`Falha ao gerar URL: ${await urlRes.text()}`)
      const { upload_url, storage_path } = await urlRes.json()

      // 2. PUT direto pro Storage
      const xhr = new XMLHttpRequest()
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100))
      })
      const putOk: { ok: boolean } = await new Promise((resolve, reject) => {
        xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300 })
        xhr.onerror = () => reject(new Error('Falha no upload'))
        xhr.open('PUT', upload_url)
        xhr.setRequestHeader('Content-Type', 'application/pdf')
        xhr.send(file)
      })
      if (!putOk.ok) throw new Error(`Upload falhou: HTTP ${xhr.status}`)

      setProgress(100)
      setStatus('processing')

      // 3. Dispara processamento
      const finalTitle = title.trim() || file.name.replace('.pdf', '')
      const finalAuthor = author.trim() || 'Desconhecido'
      const procRes = await fetch(`${import.meta.env.BASE_URL}upload-api/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          storage_path,
          title: finalTitle,
          author: finalAuthor,
          total_pages: pdfPageCount || 0,
        }),
      })
      if (!procRes.ok) throw new Error(`Processamento falhou: ${await procRes.text()}`)
      const proc = await procRes.json()
      setEbookId(proc.ebook_id)

      const effectivePages = pdfPageCount || 100
      const etaSeconds = Math.max(60, effectivePages * 3)
      const etaMin = Math.ceil(etaSeconds / 60)
      setEtaMinutes(etaMin)

      pollStatus(proc.ebook_id)
    } catch (e: any) {
      setErrorMsg(e.message || String(e))
      setStatus('error')
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: '40px auto', padding: '0 16px' }}>
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={16} /> voltar
      </button>

      <div className="upload-card">
        <div className="upload-head">
          <div className="upload-icon"><Upload size={24} /></div>
          <h1>Enviar meu livro</h1>
          <p>Faça upload do seu PDF e tenha um Professor IA só pra ele. O livro fica <strong>privado</strong> na sua biblioteca — só você vê.</p>
        </div>

        <div className="upload-info">
          <strong>Como funciona:</strong>
          <ol>
            <li>Você paga uma taxa de processamento de R$10 por livro (Asaas — PIX, cartão ou boleto)</li>
            <li>Após confirmar, faz upload do PDF</li>
            <li>O sistema processa em background (1-30 min dependendo do tamanho)</li>
            <li>Livro aparece automaticamente na sua biblioteca, pronto pra ler e perguntar</li>
            <li>Para subir outro livro, é só pagar a taxa de novo (R$10 por livro)</li>
          </ol>
        </div>

        {/* === LOADING inicial === */}
        {access === 'loading' && (
          <div className="upload-status">
            <div className="spinner" />
            <p>Verificando acesso...</p>
          </div>
        )}

        {/* === AGUARDANDO confirmação do Asaas (depois do redirect) === */}
        {access === 'awaiting_confirmation' && (
          <div className="upload-status">
            <div className="spinner" />
            <h3>⏳ Confirmando pagamento...</h3>
            <p>Você voltou do Asaas. Estamos validando o pagamento — isso leva até 5 segundos.</p>
            <small>Se demorar mais que 5 minutos, fale com a gente.</small>
          </div>
        )}

        {/* === NÃO PAGOU — mostra tela de pagamento === */}
        {access === 'unpaid' && (
          <div className="upload-payment">
            <h3>💳 Taxa de processamento</h3>
            <div className="payment-amount">
              {(UPLOAD_FEE_CENTS / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
            </div>
            <p>Esta taxa cobre o processamento pesado (10-30 min por livro):</p>
            <ul>
              <li>Extração automática de texto (ou OCR se escaneado)</li>
              <li>Geração de embeddings semânticos pra RAG do Professor IA</li>
              <li>Armazenamento seguro e isolado no seu perfil (RLS)</li>
              <li>Pagamento único por livro (cada novo upload = nova taxa de R$10)</li>
            </ul>
            {errorMsg && (
              <div className="auth-msg auth-msg-err" style={{ marginBottom: 12 }}>
                <AlertCircle size={14} /> {errorMsg}
              </div>
            )}
            <div className="payment-actions">
              <button className="btn-ghost" onClick={onBack}>Voltar</button>
              <button className="btn-primary" onClick={handlePayFee}>
                <CreditCard size={16} /> Pagar e enviar livro
              </button>
            </div>
            <small style={{ display: 'block', marginTop: 12, color: 'var(--muted)' }}>
              💡 Você será redirecionado pro Asaas (sandbox). Cartão de teste: <code>4444 4444 4444 4444</code> / CVV <code>123</code> / val <code>12/30</code>
            </small>
          </div>
        )}

        {/* === PAGOU — mostra form de upload === */}
        {access === 'paid' && status === 'idle' && (
          <>
            <div className="auth-msg auth-msg-ok" style={{ marginBottom: 16 }}>
              <CheckCircle size={14} /> Taxa paga. Você pode subir <strong>1 livro</strong>. Para enviar
              outro, é só pagar a taxa de novo.
            </div>
            <div className="upload-form">
              <label className="upload-drop">
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => e.target.files && handleFile(e.target.files[0])}
                  style={{ display: 'none' }}
                />
                {file ? (
                  <>
                    <FileText size={32} />
                    <strong>{file.name}</strong>
                    <span>{(file.size / 1024 / 1024).toFixed(2)} MB {pdfPageCount ? `· ${pdfPageCount} páginas` : ''}</span>
                    <small>Clique pra trocar o arquivo</small>
                  </>
                ) : (
                  <>
                    <Upload size={32} />
                    <strong>Clique ou arraste seu PDF aqui</strong>
                    <span>Até 50 MB · Apenas .pdf</span>
                  </>
                )}
              </label>

              <label className="field">
                <span>Título (editável — preenchido automaticamente se o PDF tiver metadado)</span>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Ex: Meu livro favorito"
                />
              </label>

              <label className="field">
                <span>Autor</span>
                <input
                  type="text"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  placeholder="Ex: Eu mesmo"
                />
              </label>

              {errorMsg && (
                <div className="auth-msg auth-msg-err">
                  <AlertCircle size={14} /> {errorMsg}
                </div>
              )}

              <button className="btn-primary" disabled={!file} onClick={startUpload}>
                <Upload size={16} /> Enviar livro
              </button>
            </div>
          </>
        )}

        {status === 'uploading' && (
          <div className="upload-status">
            <div className="spinner" />
            <h3>Enviando PDF...</h3>
            <div className="progress-bar"><span style={{ width: `${progress}%` }} /></div>
            <small>{progress}%</small>
          </div>
        )}

        {status === 'processing' && (
          <div className="upload-status">
            <div className="spinner" />
            <h3>📖 Processando seu livro...</h3>
            <p>Estamos indexando <strong>{pdfPageCount || '~100'}</strong> páginas no Professor IA.</p>
            <div className="eta-box">
              <strong>⏱️ Pronto em ~{etaMinutes} minuto{etaMinutes > 1 ? 's' : ''}</strong>
              <small>
                <strong>Pode fechar esta aba e voltar depois.</strong> Quando o livro terminar, ele
                aparece sozinho na sua biblioteca — basta atualizar a página da biblioteca.
                Pra livros grandes (&gt;300 páginas), pode levar até 30 min.
              </small>
            </div>
            <div className="processing-steps">
              <div className="step done">✓ PDF salvo com segurança</div>
              <div className="step active">⚙️ Extraindo texto página por página</div>
              <div className="step">🧠 Gerando embeddings semânticos</div>
              <div className="step">📚 Indexando na sua biblioteca</div>
            </div>
          </div>
        )}

        {status === 'done' && (
          <div className="upload-status success">
            <CheckCircle size={40} />
            <h3>✅ Livro pronto na biblioteca!</h3>
            <p>Redirecionando...</p>
          </div>
        )}

        {status === 'error' && (
          <div className="upload-status error">
            <AlertCircle size={40} />
            <h3>Erro no upload</h3>
            <p>{errorMsg}</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="btn-primary" onClick={() => setStatus('idle')}>Tentar de novo</button>
              <a className="btn-ghost" href="https://wa.me/5544884182083" target="_blank" rel="noopener">
                Falar com suporte
              </a>
            </div>
          </div>
        )}

        <div className="auth-foot">
          <span>📚 Logado como <strong>{user.email}</strong> · Seus livros ficam isolados por usuário (RLS)</span>
        </div>
      </div>
    </div>
  )
}


// CSS injetado pros novos componentes
const style = document.createElement('style')
style.textContent = `
  .eta-box {
    background: rgba(82, 193, 166, 0.12);
    border: 1px solid rgba(82, 193, 166, 0.3);
    border-radius: 12px;
    padding: 16px 20px;
    margin: 16px 0;
    text-align: left;
  }
  .eta-box strong { display: block; font-size: 18px; color: #52c1a6; margin-bottom: 6px; }
  .eta-box small { color: rgba(255,255,255,0.7); line-height: 1.4; }

  .processing-steps {
    margin-top: 20px;
    text-align: left;
  }
  .processing-steps .step {
    padding: 10px 14px;
    margin: 4px 0;
    border-radius: 8px;
    background: rgba(255,255,255,0.04);
    color: rgba(255,255,255,0.5);
    font-size: 14px;
  }
  .processing-steps .step.done {
    background: rgba(82, 193, 166, 0.15);
    color: #52c1a6;
  }
  .processing-steps .step.active {
    background: rgba(82, 193, 166, 0.10);
    color: #52c1a6;
    border-left: 3px solid #52c1a6;
    animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }
`
if (!document.head.querySelector('style[data-leitor-upload]')) {
  style.setAttribute('data-leitor-upload', '1')
  document.head.appendChild(style)
}
