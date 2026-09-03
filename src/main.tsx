import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
