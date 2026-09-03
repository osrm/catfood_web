import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installDemoPreviewFetch } from './demo-preview'
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

installDemoPreviewFetch()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
