import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // 06/09/2026 v11 Isaías: migração pra leitorinteligente.automacaojs.us
  // (raiz /) — antes era /leitor-inteligente/ no preview.automacaojs.us.
  // src/lib/baseUrl.ts lê esse valor dinamicamente em runtime.
  base: '/',
  // 04/09/2026: y-monaco importa `monaco-editor/esm/vs/editor/editor.api.js`
  // mas o pacote monaco-editor não exporta esse subpath no campo "exports".
  // Resolvemos manualmente pro arquivo real pra Vite conseguir bundlar.
  resolve: {
    alias: {
      'monaco-editor/esm/vs/editor/editor.api.js':
        '/root/projetos/leitor-inteligente/node_modules/monaco-editor/esm/vs/editor/editor.api.js',
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
