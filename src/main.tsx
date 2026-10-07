import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import './home.css'
import './research-ui.css'
import './product-detail.css'
import './compare.css'
import './switch-workflow.css'
import './catalog-design-refresh.css'
import { isDemoPreview, isRealVisualPreview, isStressPreview } from './preview-mode'

const ingredientScrollSettleTimers = new WeakMap<HTMLElement, number>()
const ingredientAlignedScrollPositions = new WeakMap<HTMLElement, number>()

function isMobileGeneralIngredients(target: HTMLElement) {
  return window.innerWidth <= 760
    && target.id === 'compare-panel-ingredients'
    && !target.closest('.compare-stage')?.classList.contains('is-switch-compare')
}

function nearestScrollPosition(positions: number[], value: number) {
  return positions.reduce((nearest, position) => (
    Math.abs(position - value) < Math.abs(nearest - value) ? position : nearest
  ), positions[0] ?? value)
}

function mobileIngredientScrollPositions(target: HTMLElement) {
  const fixedLabel = target.querySelector<HTMLElement>('.compare-row-label')
  const productHeads = [...target.querySelectorAll<HTMLElement>('.compare-head-row .compare-product-head')]
  if (!fixedLabel || productHeads.length === 0) return { productHeads, positions: [] as number[] }

  const current = target.scrollLeft
  const maxScroll = Math.max(0, target.scrollWidth - target.clientWidth)
  const fixedRight = fixedLabel.getBoundingClientRect().right
  const positions = [...new Set(productHeads.map((head) => (
    Math.min(maxScroll, Math.max(0, current + head.getBoundingClientRect().left - fixedRight))
  )))].sort((a, b) => a - b)
  return { productHeads, positions }
}

function rememberIngredientAlignedPosition(target: HTMLElement) {
  if (!isMobileGeneralIngredients(target)) return
  const { positions } = mobileIngredientScrollPositions(target)
  if (positions.length === 0) return
  ingredientAlignedScrollPositions.set(target, nearestScrollPosition(positions, target.scrollLeft))
}

function ingredientPanelFromEvent(event: Event) {
  for (const item of event.composedPath()) {
    if (item instanceof HTMLElement && item.id === 'compare-panel-ingredients' && item.classList.contains('compare-table-wrap')) {
      return item
    }
  }
  return null
}

function captureIngredientWheelStart(event: WheelEvent) {
  const target = ingredientPanelFromEvent(event)
  if (!target) return

  const firstProductHead = target.querySelector<HTMLElement>('.compare-head-row .compare-product-head')
  const productWidth = firstProductHead?.getBoundingClientRect().width ?? 0
  const horizontalDelta = Math.abs(event.deltaX) > 0 ? event.deltaX : event.shiftKey ? event.deltaY : 0
  if (productWidth > 0 && Math.abs(horizontalDelta) >= productWidth / 2) {
    rememberIngredientAlignedPosition(target)
  }
}

function captureIngredientKeyStart(event: KeyboardEvent) {
  if (event.key !== 'Tab' && event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
  const target = ingredientPanelFromEvent(event)
  if (target) rememberIngredientAlignedPosition(target)
}

function alignMobileIngredientColumn(target: HTMLElement) {
  if (!isMobileGeneralIngredients(target)) return

  const { productHeads, positions } = mobileIngredientScrollPositions(target)
  if (positions.length === 0) return

  const current = target.scrollLeft

  const previousAligned = ingredientAlignedScrollPositions.get(target)
    ?? nearestScrollPosition(positions, current)
  const movement = current - previousAligned
  const direction = movement > 1 ? 1 : movement < -1 ? -1 : 0
  const productWidth = productHeads[0]?.getBoundingClientRect().width ?? 0
  let destination = nearestScrollPosition(positions, current)

  const shortMovement = direction !== 0 && Math.abs(movement) < productWidth / 2
  if (shortMovement && destination === previousAligned) {
    const directional = direction > 0
      ? positions.find((position) => position > previousAligned + 1)
      : [...positions].reverse().find((position) => position < previousAligned - 1)
    if (directional != null) destination = directional
  }

  ingredientAlignedScrollPositions.set(target, destination)
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

document.addEventListener('wheel', captureIngredientWheelStart, { capture: true, passive: true })
document.addEventListener('keydown', captureIngredientKeyStart, true)
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