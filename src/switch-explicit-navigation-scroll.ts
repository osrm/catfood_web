import type { SwitchStep } from './switch-session'

export type SwitchExplicitScrollTarget = SwitchStep | 'compare'

export type SwitchExplicitScrollIntent = {
  target: SwitchExplicitScrollTarget
  previousScrollRestoration: ScrollRestoration | null
}

const TARGET_ANCHORS: Record<SwitchExplicitScrollTarget, string> = {
  current: '.switch-find-stage',
  sku: '.switch-step-main',
  change: '.switch-step-main',
  keep: '.switch-step-main',
  results: '.switch-candidate-list',
  compare: '.compare-stage',
}

export function switchScrollOwner(anchor: HTMLElement): HTMLElement {
  let element: HTMLElement | null = anchor
  while (element) {
    const overflowY = element.ownerDocument.defaultView?.getComputedStyle(element).overflowY ?? ''
    if ((overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight) {
      return element
    }
    element = element.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

export function beginSwitchExplicitScrollIntent(
  target: SwitchExplicitScrollTarget,
  historyTraversal = false,
): SwitchExplicitScrollIntent {
  let previousScrollRestoration: ScrollRestoration | null = null
  if (historyTraversal && 'scrollRestoration' in window.history) {
    previousScrollRestoration = window.history.scrollRestoration
    window.history.scrollRestoration = 'manual'
  }
  return { target, previousScrollRestoration }
}

export function releaseSwitchExplicitScrollIntent(intent: SwitchExplicitScrollIntent): void {
  if (intent.previousScrollRestoration === null || !('scrollRestoration' in window.history)) return
  const previous = intent.previousScrollRestoration
  window.requestAnimationFrame(() => {
    window.history.scrollRestoration = previous
  })
}

export function resetSwitchExplicitNavigationScroll(target: SwitchExplicitScrollTarget): boolean {
  const anchor = document.querySelector<HTMLElement>(TARGET_ANCHORS[target])
  if (!anchor) return false
  switchScrollOwner(anchor).scrollTop = 0
  return true
}
