import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API = process.env.API_ORIGIN ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // The preview proxy sends a *.e2b.app Host header; allow every origin so the
    // sandbox preview and localhost both work.
    allowedHosts: true,
    proxy: {
      '/api': { target: API, changeOrigin: true },
    },
    hmr: { clientPort: 443 },
  },
  preview: { host: '0.0.0.0', allowedHosts: true },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 3000 },
})
