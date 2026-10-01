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
import './switch-compare-overview.css'
import './product-detail.css'
import './final-polish.css'
import './consumer-visual.css'
import './home-visual-anchor.css'
import './home-start-polish.css'
import './home-scroll-fix.css'
import './input-focus-fix.css'
import './switch-consumer-refresh.css'
import './switch-change-disclosure.css'
import './switch-change-keep-editorial.css'
import './demo-preview.css'
import './detail-consumer-refresh.css'
import './document-scroll-fix.css'
import './stitch-final-polish.css'
import './stitch-final-polish-fixes.css'
import './explore-package-polish.css'
import './consumer-navigation.css'
import './explore-condition-disclosure.css'
import './switch-compare-dock-clearance.css'
import './mobile-switch-compare-header.css'
import './quick-view-editorial.css'
import './switch-results-reviewed.css'

const ingredientScrollSettleTimers = new WeakMap<HTMLElement, number>()

function alignMobileIngredientColumn(target: HTMLElement) {
  if (window.innerWidth > 760 || target.id !== 'compare-panel-ingredients') return
  if (target.closest('.compare-stage')?.classList.contains('is-switch-compare')) return

  const fixedLabel = target.querySelector<HTMLElement>('.compare-row-label')
  const productHeads = [...target.querySelectorAll<HTMLElement>('.compare-head-row .compare-product-head')]
  if (!fixedLabel || productHeads.length === 0) return

  const current = target.scrollLeft
  const maxScroll = Math.max(0, target.scrollWidth - target.clientWidth)
  const fixedRight = fixedLabel.getBoundingClientRect().right
  let closest = current
  let closestDistance = Number.POSITIVE_INFINITY

  productHeads.forEach((head) => {
    const targetLeft = Math.min(maxScroll, Math.max(0, current + head.getBoundingClientRect().left - fixedRight))
    const distance = Math.abs(targetLeft - current)
    if (distance < closestDistance) {
      closest = targetLeft
      closestDistance = distance
    }
  })

  if (Math.abs(closest - current) > 1) target.scrollTo({ left: closest, behavior: 'smooth' })
}

function syncCompareScroll(event: Event) {
  const target = event.target
  if (!(target instanceof HTMLElement) || !target.classList.contains('compare-table-wrap')) return
  target.style.setProperty('--compare-scroll-x', `${target.scrollLeft}px`)

  if (window.innerWidth > 760 || target.id !== 'compare-panel-ingredients') return
  if (target.closest('.compare-stage')?.classList.contains('is-switch-compare')) return

  const previous = ingredientScrollSettleTimers.get(target)
  if (previous != null) window.clearTimeout(previous)
  const timer = window.setTimeout(() => {
    ingredientScrollSettleTimers.delete(target)
    alignMobileIngredientColumn(target)
  }, 140)
  ingredientScrollSettleTimers.set(target, timer)
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