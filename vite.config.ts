import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/leitor-inteligente/',
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
