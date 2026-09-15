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

function cancelRestoreFrame(lease: ScrollRestorationLease): void {
  if (lease.restoreFrame === null) return
  window.cancelAnimationFrame(lease.restoreFrame)
  lease.restoreFrame = null
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
      restoreFrame: null,
    }
    restorationLease = lease
  }

  if (lease) {
    cancelRestoreFrame(lease)
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
  if (lease.owners > 0 || lease.restoreFrame !== null) return

  const leaseId = lease.id
  const frame = window.requestAnimationFrame(() => {
    const activeLease = restorationLease
    if (!activeLease || activeLease.id !== leaseId || activeLease.restoreFrame !== frame || activeLease.owners !== 0) return
    activeLease.restoreFrame = null
    window.history.scrollRestoration = activeLease.original
    restorationLease = null
  })
  lease.restoreFrame = frame
}

export function resetSwitchExplicitNavigationScroll(target: SwitchExplicitScrollTarget): boolean {
  const anchor = document.querySelector<HTMLElement>(TARGET_ANCHORS[target])
  if (!anchor) return false
  switchScrollOwner(anchor).scrollTop = 0
  return true
}
