import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 600,   // hls.js is ~524KB — expected and unavoidable
    rollupOptions: {
      output: {
        manualChunks: {
          'hls': ['hls.js'],   // Split hls.js into its own cacheable chunk
        },
      },
    },
  },
})
