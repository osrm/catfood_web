import type { SwitchStep } from './switch-session'

export type SwitchExplicitScrollTarget = SwitchStep | 'compare'

export type SwitchExplicitScrollIntent = {
  target: SwitchExplicitScrollTarget
  generation: number
  released: boolean
}

type PendingSettle = {
  generation: number
  target: SwitchExplicitScrollTarget
  frame: number
}

const TARGET_ANCHORS: Record<SwitchExplicitScrollTarget, string> = {
  current: '.switch-find-stage',
  sku: '.switch-sku-list',
  change: '.switch-no-change',
  keep: '.switch-current-facts-strip',
  results: '.switch-candidate-list',
  compare: '.compare-stage',
}

let nextGeneration = 1
let activeIntent: { generation: number; target: SwitchExplicitScrollTarget } | null = null
let pendingSettle: PendingSettle | null = null

function cancelPendingSettle(): void {
  if (!pendingSettle) return
  if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(pendingSettle.frame)
  pendingSettle = null
}

function resetTargetScroll(target: SwitchExplicitScrollTarget): boolean {
  const anchor = document.querySelector<HTMLElement>(TARGET_ANCHORS[target])
  if (!anchor) return false
  switchScrollOwner(anchor).scrollTop = 0
  return true
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
  void historyTraversal
  cancelPendingSettle()
  const generation = nextGeneration++
  activeIntent = { generation, target }
  return { target, generation, released: false }
}

export function releaseSwitchExplicitScrollIntent(intent: SwitchExplicitScrollIntent): void {
  if (intent.released) return
  intent.released = true
  if (activeIntent?.generation !== intent.generation) return
  if (pendingSettle?.generation === intent.generation) return
  activeIntent = null
}

export function resetSwitchExplicitNavigationScroll(target: SwitchExplicitScrollTarget): boolean {
  const didReset = resetTargetScroll(target)
  if (!didReset) return false

  const current = activeIntent
  if (!current || current.target !== target) return true
  if (typeof window.requestAnimationFrame !== 'function') {
    activeIntent = null
    return true
  }

  cancelPendingSettle()
  const generation = current.generation
  const frame = window.requestAnimationFrame(() => {
    const settle = pendingSettle
    if (!settle || settle.frame !== frame || settle.generation !== generation) return
    pendingSettle = null
    if (activeIntent?.generation !== generation || activeIntent.target !== target) return
    resetTargetScroll(target)
    activeIntent = null
  })
  pendingSettle = { generation, target, frame }
  return true
}
