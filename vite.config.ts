/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/**
 * The shared Stoatworks footer, and with it the "report a bug" button.
 *
 * Unlike atem-scopes and pdf-presenter, this project builds the desktop app from
 * this same config — `tauri build` runs this very file — so there is no separate
 * hosted config to hang the injection off, and it has to be gated instead. Tauri 2
 * sets TAURI_ENV_PLATFORM for its own invocations and a plain `vite build` does
 * not, which is the only thing here that distinguishes the two.
 */
function supportFooter(): Plugin | false {
  if (process.env.TAURI_ENV_PLATFORM) return false
  return {
    name: 'stoatworks-support-footer',
    transformIndexHtml: {
      order: 'post',
      handler() {
        return [
          {
            tag: 'script',
            injectTo: 'body',
            attrs: {
              src: '/support-footer.js',
              defer: true,
              'data-app': 'PPTX Font Manager',
              'data-repo': 'https://github.com/stoatworks-labs/pptx-font-manager',
              'data-version': `v${pkg.version}`,
              'data-note':
                'It runs entirely in your browser — no presentation you open is uploaded.'
            }
          }
        ]
      }
    }
  }
}

// Static SPA, no backend. dist/ is what the Cloudflare Worker serves as assets.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(`v${pkg.version}`) },
  plugins: [react(), supportFooter()],
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'node',
  },
})
