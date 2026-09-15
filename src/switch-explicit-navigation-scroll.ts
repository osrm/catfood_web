import type { SwitchStep } from './switch-session'

export type SwitchExplicitScrollTarget = SwitchStep | 'compare'

export type SwitchExplicitScrollIntent = {
  target: SwitchExplicitScrollTarget
  restorationLeaseId: number | null
  released: boolean
}

type ScrollRestorationLease = {
  id: number
  original: ScrollRestoration
  owners: number
  settleFrame: number | null
  restoreFrame: number | null
}

const TARGET_ANCHORS: Record<SwitchExplicitScrollTarget, string> = {
  current: '.switch-find-stage',
  sku: '.switch-step-main',
  change: '.switch-step-main',
  keep: '.switch-step-main',
  results: '.switch-candidate-list',
  compare: '.compare-stage',
}

let nextRestorationLeaseId = 1
let restorationLease: ScrollRestorationLease | null = null

function canControlScrollRestoration(): boolean {
  return 'scrollRestoration' in window.history
}

function cancelPendingFrames(lease: ScrollRestorationLease): void {
  if (lease.settleFrame !== null) {
    window.cancelAnimationFrame(lease.settleFrame)
    lease.settleFrame = null
  }
  if (lease.restoreFrame !== null) {
    window.cancelAnimationFrame(lease.restoreFrame)
    lease.restoreFrame = null
  }
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
  if (!canControlScrollRestoration()) {
    return { target, restorationLeaseId: null, released: false }
  }

  let lease = restorationLease
  if (!lease && historyTraversal) {
    lease = {
      id: nextRestorationLeaseId++,
      original: window.history.scrollRestoration,
      owners: 0,
      settleFrame: null,
      restoreFrame: null,
    }
    restorationLease = lease
  }

  if (lease) {
    cancelPendingFrames(lease)
    lease.owners += 1
    window.history.scrollRestoration = 'manual'
  }

  return { target, restorationLeaseId: lease?.id ?? null, released: false }
}

export function releaseSwitchExplicitScrollIntent(intent: SwitchExplicitScrollIntent): void {
  if (intent.released) return
  intent.released = true
  if (intent.restorationLeaseId === null || !canControlScrollRestoration()) return

  const lease = restorationLease
  if (!lease || lease.id !== intent.restorationLeaseId) return
  lease.owners = Math.max(0, lease.owners - 1)
  if (lease.owners > 0 || lease.settleFrame !== null || lease.restoreFrame !== null) return

  const leaseId = lease.id
  const settleFrame = window.requestAnimationFrame(() => {
    const activeLease = restorationLease
    if (!activeLease || activeLease.id !== leaseId || activeLease.settleFrame !== settleFrame || activeLease.owners !== 0) return
    activeLease.settleFrame = null
    resetSwitchExplicitNavigationScroll(intent.target)

    const restoreFrame = window.requestAnimationFrame(() => {
      const currentLease = restorationLease
      if (!currentLease || currentLease.id !== leaseId || currentLease.restoreFrame !== restoreFrame || currentLease.owners !== 0) return
      currentLease.restoreFrame = null
      window.history.scrollRestoration = currentLease.original
      restorationLease = null
    })
    activeLease.restoreFrame = restoreFrame
  })
  lease.settleFrame = settleFrame
}

export function resetSwitchExplicitNavigationScroll(target: SwitchExplicitScrollTarget): boolean {
  const anchor = document.querySelector<HTMLElement>(TARGET_ANCHORS[target])
  if (!anchor) return false
  switchScrollOwner(anchor).scrollTop = 0
  return true
}
