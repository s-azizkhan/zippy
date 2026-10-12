import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { Agentation } from 'agentation'

// chunk from an older build is gone (app updated under an open page): reload to pick up new index.html
window.addEventListener('vite:preloadError', () => location.reload())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {import.meta.env.DEV && <Agentation />}
  </StrictMode>,
)
