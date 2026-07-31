import { useEffect, useState } from 'react'
import { Upload, CheckCircle, AlertCircle, FileText, ArrowLeft } from 'lucide-react'
import { useAuth } from '../lib/AuthContext'
import { supabase } from '../lib/supabase'

type Status = 'idle' | 'uploading' | 'processing' | 'done' | 'error'

interface Props {
  onBack: () => void
  onSuccess?: () => void
}

export function UploadPage({ onBack, onSuccess }: Props) {
  const { user } = useAuth()
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [progress, setProgress] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [ebookId, setEbookId] = useState<string | null>(null)
  const [showPayment, setShowPayment] = useState(false)
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null)
  const [etaMinutes, setEtaMinutes] = useState<number>(2)

  // Conta páginas do PDF via API legada (PDF.js carrega no ReaderPage depois)
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
    // Tenta extrair metadados do PDF (pdfinfo via arraybuffer)
    try {
      const buf = await f.arrayBuffer()
      const view = new Uint8Array(buf)
      const text = new TextDecoder('latin1').decode(view)
      // Extrai /Author e /Title
      const authorMatch = text.match(/\/Author\s*\(([^)]+)\)/)
      const titleMatch = text.match(/\/Title\s*\(([^)]+)\)/)
      const pageMatch = text.match(/\/Count\s+(\d+)/)
      if (authorMatch) setAuthor(authorMatch[1])
      if (titleMatch) setTitle(titleMatch[1])
      if (pageMatch) setPdfPageCount(Number(pageMatch[1]))
    } catch {
      // silencia — usuário pode preencher manualmente
    }
  }

  const startUpload = async () => {
    if (!file) {
      setErrorMsg('Selecione um PDF')
      return
    }
    setShowPayment(true)
  }

  // Re-após check de null acima, TS acha que file é não-null dentro do escopo
  // Polling: a cada 4s pergunta pro backend se o livro está pronto
  const pollStatus = async (id: string) => {
    const tries = 60 // 60 × 4s = 4min
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, 4000))
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
        // silêncio, tenta de novo
      }
    }
    // Timeout: livro grande ou erro silencioso
    setErrorMsg('O processamento está demorando mais que o esperado. Atualize a biblioteca em alguns minutos — se não aparecer, fale conosco.')
    setStatus('error')
  }

  const confirmPaymentAndUpload = async () => {
    if (!file) return
    const f = file
    setShowPayment(false)
    setStatus('uploading')
    setProgress(0)
    setErrorMsg(null)

    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (!token) throw new Error('Sessão inválida')

      // 1. Gera signed URL
      const urlRes = await fetch(`${import.meta.env.BASE_URL}upload-api/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ filename: f.name }),
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
        xhr.send(f)
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

      // ETA estimando baseado no nº de páginas: ~5s/página (BGE CPU)
      // Livro 28p ≈ 1.5min, Livro 200p ≈ 5min, Livro 653p ≈ 13min
      const etaSeconds = Math.max(60, (pdfPageCount || 28) * 3)
      const etaMin = Math.ceil(etaSeconds / 60)
      setEtaMinutes(etaMin)

      // Começa a checar periodicamente se o livro já tá na biblioteca
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
            <li>Você paga uma taxa de processamento de R$15 (simulado)</li>
            <li>Faz upload do PDF</li>
            <li>O sistema processa em background (1-5 min dependendo do tamanho)</li>
            <li>Livro aparece automaticamente na sua biblioteca, pronto pra ler e perguntar</li>
          </ol>
        </div>

        {!showPayment && status === 'idle' && (
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
              Continuar (pagar R$15) →
            </button>
          </div>
        )}

        {showPayment && (
          <div className="upload-payment">
            <h3>Taxa de processamento</h3>
            <div className="payment-amount">R$ 15,00</div>
            <p>Esta taxa cobre:</p>
            <ul>
              <li>Processamento automático (extração de texto ou OCR se escaneado)</li>
              <li>Geração de embeddings semânticos pra RAG</li>
              <li>Armazenamento seguro no seu perfil isolado</li>
            </ul>
            <div className="payment-actions">
              <button className="btn-ghost" onClick={() => setShowPayment(false)}>Cancelar</button>
              <button className="btn-primary" onClick={confirmPaymentAndUpload}>
                ✓ Confirmar pagamento (simulado)
              </button>
            </div>
          </div>
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
            <p>Estamos indexando <strong>{pdfPageCount || 'as páginas'}</strong> páginas no Professor IA.</p>
            <div className="eta-box">
              <strong>⏱️ Pronto em ~{etaMinutes} minuto{etaMinutes > 1 ? 's' : ''}</strong>
              <small>Você pode ficar aqui, ou voltar à biblioteca e atualizar — o livro <strong>aparecerá sozinho</strong> quando terminar.</small>
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
