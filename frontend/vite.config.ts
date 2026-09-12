import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Wails v3 dev server contract: the host proxies non-/wails/* requests to
// this URL, so the Vite dev server must bind 127.0.0.1:9245 (or the
// WAILS_VITE_PORT override).
const vitePort = Number(process.env.WAILS_VITE_PORT) || 9245

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: vitePort,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
