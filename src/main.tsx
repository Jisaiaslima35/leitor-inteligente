import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles/global.css'
import './styles/dev.css'
import './styles/web.css'
// 04/09/2026: importado pra renderizar textLayer no PdfViewer (highlight + notas).
// Sem este CSS, os spans do textLayer ficam opacos por cima do canvas (efeito fantasma).
import 'pdfjs-dist/web/pdf_viewer.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)