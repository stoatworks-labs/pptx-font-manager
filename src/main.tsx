import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// The shared Stoatworks theme first (vendored from stoatworks-backend/theme by scripts/sync-theme.sh), so the tool's own CSS layers over it.
import './stoatworks-theme.css'
import './styles.css'
import { registerServiceWorker } from './register-sw.ts'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

registerServiceWorker()
