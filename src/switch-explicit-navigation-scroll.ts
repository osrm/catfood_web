type ExplicitSwitchScrollTarget = {
  signature: 'current' | 'sku' | 'change' | 'keep' | 'results' | 'compare'
  anchorSelector: string
  historyTraversal: boolean
}

type PendingScroll = ExplicitSwitchScrollTarget & {
  previousScrollRestoration: ScrollRestoration | null
}

let installed = false
let pending: PendingScroll | null = null
let observer: MutationObserver | null = null

function viewSignature(): ExplicitSwitchScrollTarget['signature'] | null {
  if (document.querySelector('.compare-stage')) return 'compare'
  if (document.querySelector('.switch-results-stage')) return 'results'
  const heading = document.querySelector('.switch-step-header h1')?.textContent?.trim()
  if (heading === '현재 먹이는 규격을 골라주세요.') return 'sku'
  if (heading === '무엇을 바꾸고 싶나요?') return 'change'
  if (heading === '무엇을 그대로 유지할까요?') return 'keep'
  if (document.querySelector('.switch-find-stage')) return 'current'
  return null
}

function scrollOwner(anchorSelector: string): HTMLElement {
  let element = document.querySelector<HTMLElement>(anchorSelector)
  while (element) {
    const overflowY = getComputedStyle(element).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight) {
      return element
    }
    element = element.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

function restoreNativeScroll(pendingScroll: PendingScroll) {
  if (pendingScroll.previousScrollRestoration !== null && 'scrollRestoration' in window.history) {
    window.history.scrollRestoration = pendingScroll.previousScrollRestoration
  }
}

function applyPendingScroll() {
  const pendingScroll = pending
  if (!pendingScroll || viewSignature() !== pendingScroll.signature) return
  pending = null
  scrollOwner(pendingScroll.anchorSelector).scrollTop = 0
  restoreNativeScroll(pendingScroll)
}

function intentForButton(button: HTMLButtonElement): ExplicitSwitchScrollTarget | null {
  if (button.matches('.switch-current-preview .switch-primary-action')) {
    return { signature: 'sku', anchorSelector: '.switch-step-main', historyTraversal: false }
  }
  if (button.matches('.switch-change-current')) {
    return { signature: 'current', anchorSelector: '.switch-find-stage', historyTraversal: false }
  }
  if (button.matches('.switch-session-bar > button')) {
    return { signature: 'change', anchorSelector: '.switch-step-main', historyTraversal: false }
  }
  if (button.matches('.switch-compare-dock > button')) {
    return { signature: 'compare', anchorSelector: '.compare-stage', historyTraversal: false }
  }
  if (!button.closest('.switch-step-actions')) return null

  const text = button.textContent?.trim() ?? ''
  const current = viewSignature()
  if (text === '사용 규격을 모르겠어요' || (text === '다음 →' && current === 'sku')) {
    return { signature: 'change', anchorSelector: '.switch-step-main', historyTraversal: false }
  }
  if (text === '다음 →' && current === 'change') {
    return { signature: 'keep', anchorSelector: '.switch-step-main', historyTraversal: false }
  }
  if (text === '후보 제품 보기 →' && current === 'keep') {
    return { signature: 'results', anchorSelector: '.switch-candidate-list', historyTraversal: false }
  }
  if (text === '← 사용 규격' && current === 'change') {
    return { signature: 'sku', anchorSelector: '.switch-step-main', historyTraversal: true }
  }
  if (text === '← 바꿀 것 수정' && current === 'keep') {
    return { signature: 'change', anchorSelector: '.switch-step-main', historyTraversal: true }
  }
  return null
}

function onDocumentClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return
  const button = target.closest<HTMLButtonElement>('button')
  if (!button || button.disabled) return
  const intent = intentForButton(button)
  if (!intent) return

  if (pending) restoreNativeScroll(pending)
  const previousScrollRestoration = intent.historyTraversal && 'scrollRestoration' in window.history
    ? window.history.scrollRestoration
    : null
  if (previousScrollRestoration !== null) window.history.scrollRestoration = 'manual'
  pending = { ...intent, previousScrollRestoration }
  queueMicrotask(applyPendingScroll)
}

export function installSwitchExplicitNavigationScroll() {
  if (installed) return
  installed = true
  document.addEventListener('click', onDocumentClick, true)
  observer = new MutationObserver(applyPendingScroll)
  observer.observe(document.getElementById('root') ?? document.body, { childList: true, subtree: true, characterData: true })
  window.addEventListener('pagehide', () => {
    if (pending) restoreNativeScroll(pending)
    pending = null
  })
}

export function uninstallSwitchExplicitNavigationScrollForTest() {
  if (!installed) return
  document.removeEventListener('click', onDocumentClick, true)
  observer?.disconnect()
  observer = null
  if (pending) restoreNativeScroll(pending)
  pending = null
  installed = false
}
