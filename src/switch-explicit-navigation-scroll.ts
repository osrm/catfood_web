import type { SwitchStep } from './switch-session'

export type SwitchExplicitScrollTarget = SwitchStep | 'compare'

export type SwitchExplicitScrollIntent = {
  target: SwitchExplicitScrollTarget
  generation: number
  released: boolean
}

export type SwitchExplicitScrollSettleHandle = {
  generation: number
  cancel: () => void
}

type ActiveSettle = {
  intent: SwitchExplicitScrollIntent
  target: SwitchExplicitScrollTarget
  anchor: HTMLElement
  owner: HTMLElement
  frame: number
  canceled: boolean
  handle: SwitchExplicitScrollSettleHandle
}

const TARGET_ANCHORS: Record<SwitchExplicitScrollTarget, string> = {
  current: '.switch-find-stage',
  sku: '.switch-sku-list',
  change: '.switch-no-change',
  keep: '.switch-current-facts-summary',
  results: '.switch-candidate-list',
  compare: '.compare-stage',
}

let nextGeneration = 1
let activeIntent: SwitchExplicitScrollIntent | null = null
let activeSettle: ActiveSettle | null = null

function finishIntent(intent: SwitchExplicitScrollIntent): void {
  intent.released = true
  if (activeIntent === intent) activeIntent = null
}

function cancelSettle(settle: ActiveSettle): void {
  if (settle.canceled) return
  settle.canceled = true
  if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(settle.frame)
  if (activeSettle === settle) activeSettle = null
  finishIntent(settle.intent)
}

function resetTargetScroll(target: SwitchExplicitScrollTarget): { anchor: HTMLElement; owner: HTMLElement } | null {
  const anchor = document.querySelector<HTMLElement>(TARGET_ANCHORS[target])
  if (!anchor) return null
  const owner = switchScrollOwner(anchor)
  owner.scrollTop = 0
  return { anchor, owner }
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
  if (activeSettle) cancelSettle(activeSettle)
  if (activeIntent) finishIntent(activeIntent)
  const intent = { target, generation: nextGeneration++, released: false }
  activeIntent = intent
  return intent
}

export function cancelSwitchExplicitScrollSettle(handle: SwitchExplicitScrollSettleHandle): void {
  handle.cancel()
}

export function releaseSwitchExplicitScrollIntent(intent: SwitchExplicitScrollIntent): void {
  if (intent.released) return
  if (activeSettle?.intent === intent) {
    cancelSettle(activeSettle)
    return
  }
  finishIntent(intent)
}

export function resetSwitchExplicitNavigationScroll(
  intent: SwitchExplicitScrollIntent,
  onSettled?: () => void,
): SwitchExplicitScrollSettleHandle | null {
  if (intent.released || activeIntent !== intent) return null
  const reset = resetTargetScroll(intent.target)
  if (!reset) return null

  if (typeof window.requestAnimationFrame !== 'function') {
    finishIntent(intent)
    return null
  }

  if (activeSettle) cancelSettle(activeSettle)
  const { anchor, owner } = reset
  let settle: ActiveSettle
  const handle: SwitchExplicitScrollSettleHandle = {
    generation: intent.generation,
    cancel: () => cancelSettle(settle),
  }
  const frame = window.requestAnimationFrame(() => {
    if (settle.canceled || activeSettle !== settle || intent.released || activeIntent !== intent) return
    activeSettle = null
    const currentAnchor = document.querySelector<HTMLElement>(TARGET_ANCHORS[intent.target])
    if (currentAnchor === anchor && anchor.isConnected && switchScrollOwner(anchor) === owner) {
      owner.scrollTop = 0
    }
    finishIntent(intent)
    onSettled?.()
  })
  settle = {
    intent,
    target: intent.target,
    anchor,
    owner,
    frame,
    canceled: false,
    handle,
  }
  activeSettle = settle
  return handle
}
