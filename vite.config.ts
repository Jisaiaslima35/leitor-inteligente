import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // 06/09/2026 v11 Isaías: migração pra leitorinteligente.automacaojs.us
  // (raiz /) — antes era /leitor-inteligente/ no preview.automacaojs.us.
  // src/lib/baseUrl.ts lê esse valor dinamicamente em runtime.
  base: '/',
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
  },
  // 06/09/2026 v14.1 auditoria pré-divulgação: source maps OFF explícito.
  // Vite default já é false, mas deixar documentado evita alguém habilitar
  // acidentalmente em build futuro e vazar TS original no DevTools.
  build: {
    sourcemap: false,
  },
  // 04/09/2026: y-monaco importa `monaco-editor/esm/vs/editor/editor.api.js`
  // mas o pacote monaco-editor não exporta esse subpath no campo "exports".
  // Resolvemos dinamicamente pro arquivo real pra Vite conseguir bundlar.
  resolve: {
    alias: {
      'monaco-editor/esm/vs/editor/editor.api.js': path.resolve(
        __dirname,
        'node_modules/monaco-editor/esm/vs/editor/editor.api.js'
      ),
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      disable: true,
      injectRegister: false,
      manifest: false,
      includeAssets: ['favicon.svg', 'icon-192.svg', 'icon-512.svg'],
    }),
  ],
})

