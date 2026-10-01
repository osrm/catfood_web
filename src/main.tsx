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

type IngredientScrollIntent = {
  direction: -1 | 1
  startScrollLeft: number
}

const ingredientScrollSettleTimers = new WeakMap<HTMLElement, number>()
const ingredientScrollIntents = new WeakMap<HTMLElement, IngredientScrollIntent>()

function isMobileGeneralIngredients(target: HTMLElement) {
  return window.innerWidth <= 760
    && target.id === 'compare-panel-ingredients'
    && !target.closest('.compare-stage')?.classList.contains('is-switch-compare')
}

function recordIngredientScrollIntent(target: HTMLElement, direction: -1 | 1) {
  if (!isMobileGeneralIngredients(target)) return
  ingredientScrollIntents.set(target, { direction, startScrollLeft: target.scrollLeft })
}

function nearestScrollPosition(positions: number[], value: number) {
  return positions.reduce((nearest, position) => (
    Math.abs(position - value) < Math.abs(nearest - value) ? position : nearest
  ), positions[0] ?? value)
}

function alignMobileIngredientColumn(target: HTMLElement) {
  if (!isMobileGeneralIngredients(target)) return

  const fixedLabel = target.querySelector<HTMLElement>('.compare-row-label')
  const productHeads = [...target.querySelectorAll<HTMLElement>('.compare-head-row .compare-product-head')]
  if (!fixedLabel || productHeads.length === 0) return

  const current = target.scrollLeft
  const maxScroll = Math.max(0, target.scrollWidth - target.clientWidth)
  const fixedRight = fixedLabel.getBoundingClientRect().right
  const positions = [...new Set(productHeads.map((head) => (
    Math.min(maxScroll, Math.max(0, current + head.getBoundingClientRect().left - fixedRight))
  )))].sort((a, b) => a - b)
  if (positions.length === 0) return

  let destination = nearestScrollPosition(positions, current)
  const intent = ingredientScrollIntents.get(target)
  ingredientScrollIntents.delete(target)

  if (intent) {
    const startPosition = nearestScrollPosition(positions, intent.startScrollLeft)
    const movement = current - intent.startScrollLeft
    const productWidth = productHeads[0]?.getBoundingClientRect().width ?? 0
    const shortMovement = Math.abs(movement) > 1 && Math.abs(movement) < productWidth / 2
    if (shortMovement && destination === startPosition) {
      const directional = intent.direction > 0
        ? positions.find((position) => position > startPosition + 1)
        : [...positions].reverse().find((position) => position < startPosition - 1)
      if (directional != null) destination = directional
    }
  }

  if (Math.abs(destination - current) > 1) target.scrollTo({ left: destination, behavior: 'smooth' })
}

function syncCompareScroll(event: Event) {
  const target = event.target
  if (!(target instanceof HTMLElement) || !target.classList.contains('compare-table-wrap')) return
  target.style.setProperty('--compare-scroll-x', `${target.scrollLeft}px`)

  if (!isMobileGeneralIngredients(target)) return

  const previous = ingredientScrollSettleTimers.get(target)
  if (previous != null) window.clearTimeout(previous)
  const timer = window.setTimeout(() => {
    ingredientScrollSettleTimers.delete(target)
    alignMobileIngredientColumn(target)
  }, 140)
  ingredientScrollSettleTimers.set(target, timer)
}

function captureIngredientWheelIntent(event: WheelEvent) {
  const target = event.target
  if (!(target instanceof Element)) return
  const panel = target.closest<HTMLElement>('#compare-panel-ingredients.compare-table-wrap')
  if (!panel) return

  const horizontalDelta = Math.abs(event.deltaX) > 0 ? event.deltaX : event.shiftKey ? event.deltaY : 0
  if (Math.abs(horizontalDelta) < 1) return
  recordIngredientScrollIntent(panel, horizontalDelta > 0 ? 1 : -1)
}

function captureIngredientKeyIntent(event: KeyboardEvent) {
  const target = event.target
  if (!(target instanceof HTMLElement) || target.id !== 'compare-panel-ingredients') return
  if (event.key === 'ArrowRight') recordIngredientScrollIntent(target, 1)
  if (event.key === 'ArrowLeft') recordIngredientScrollIntent(target, -1)
}

document.addEventListener('wheel', captureIngredientWheelIntent, { capture: true, passive: true })
document.addEventListener('keydown', captureIngredientKeyIntent, true)
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