import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { isDemoPreview, isRealVisualPreview, isStressPreview } from './preview-mode'
import './styles.css'
import './refinements.css'
import './warm-editorial.css'
import './home.css'
import './research-ui.css'
import './switch-flow.css'
import './switch-workflow.css'
import './ingredient-avoidance.css'
import './switch-results-polish.css'
import './compare.css'
import './product-detail.css'
import './final-polish.css'
import './consumer-visual.css'
import './home-visual-anchor.css'
import './home-start-polish.css'
import './home-scroll-fix.css'
import './input-focus-fix.css'
import './switch-consumer-refresh.css'
import './demo-preview.css'
import './detail-consumer-refresh.css'
import './document-scroll-fix.css'
import './stitch-final-polish.css'
import './stitch-final-polish-fixes.css'
import './explore-package-polish.css'
import './consumer-navigation.css'
import './explore-condition-disclosure.css'

function syncCompareScroll(event: Event) {
  const target = event.target
  if (!(target instanceof HTMLElement) || !target.classList.contains('compare-table-wrap')) return
  target.style.setProperty('--compare-scroll-x', `${target.scrollLeft}px`)
}

document.addEventListener('scroll', syncCompareScroll, true)

async function start() {
  if (import.meta.env.DEV) {
    if (isDemoPreview()) (await import('./demo-preview')).installDemoPreviewFetch()
    if (isRealVisualPreview()) (await import('./real-visual-preview')).installRealVisualPreviewFetch()
    if (isStressPreview()) (await import('./stress-preview')).installStressPreviewFetch()
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void start()
