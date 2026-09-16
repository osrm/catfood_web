import './mobile-switch-compare-picker.css'

type PickerState = {
  picker: HTMLElement
  list: HTMLElement
  toggle: HTMLButtonElement
  meta: HTMLSpanElement
  brand: HTMLSpanElement
  name: HTMLSpanElement
  onToggle: () => void
  onListClick: (event: Event) => void
}

const PICKER_SELECTOR = '.is-switch-overview .compare-switch-mobile-overview .compare-mobile-candidate-picker'
const states = new Map<HTMLElement, PickerState>()
let optionListId = 0
let syncing = false

function optionButtons(list: HTMLElement) {
  return [...list.querySelectorAll<HTMLButtonElement>('button[data-product-id]')]
}

function activeButton(buttons: HTMLButtonElement[]) {
  return buttons.find((button) => button.getAttribute('aria-pressed') === 'true' || button.classList.contains('is-active')) ?? buttons[0] ?? null
}

function identity(button: HTMLButtonElement | null) {
  if (!button) return { brand: '', name: '' }
  const text = button.textContent?.trim() ?? ''
  const separator = text.indexOf(' · ')
  if (separator < 0) return { brand: '', name: text }
  return { brand: text.slice(0, separator), name: text.slice(separator + 3) }
}

function setOpen(state: PickerState, open: boolean) {
  state.list.hidden = !open
  state.toggle.setAttribute('aria-expanded', String(open))
  state.picker.classList.toggle('is-open', open)
}

function refresh(state: PickerState) {
  const buttons = optionButtons(state.list)
  const active = activeButton(buttons)
  const index = active ? buttons.indexOf(active) : -1
  const current = identity(active)
  state.meta.textContent = `후보 ${buttons.length}개 · ${Math.max(index + 1, 1)}/${Math.max(buttons.length, 1)}`
  state.brand.textContent = current.brand
  state.name.textContent = current.name
}

function enhance(picker: HTMLElement) {
  if (states.has(picker)) return
  const list = picker.querySelector<HTMLElement>(':scope > div')
  if (!list || optionButtons(list).length < 2) return

  const id = list.id || `compare-mobile-candidate-options-${++optionListId}`
  list.id = id
  list.classList.add('compare-mobile-candidate-options')

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'compare-mobile-candidate-toggle'
  toggle.setAttribute('aria-expanded', 'false')
  toggle.setAttribute('aria-controls', id)
  toggle.innerHTML = '<span class="compare-mobile-candidate-meta"></span><span class="compare-mobile-candidate-current"><span class="compare-mobile-candidate-brand"></span><strong class="compare-mobile-candidate-name"></strong></span><span class="compare-mobile-candidate-chevron" aria-hidden="true">⌄</span>'

  const meta = toggle.querySelector<HTMLSpanElement>('.compare-mobile-candidate-meta')!
  const brand = toggle.querySelector<HTMLSpanElement>('.compare-mobile-candidate-brand')!
  const name = toggle.querySelector<HTMLSpanElement>('.compare-mobile-candidate-name')!

  const state: PickerState = {
    picker,
    list,
    toggle,
    meta,
    brand,
    name,
    onToggle: () => {},
    onListClick: () => {},
  }

  state.onToggle = () => setOpen(state, state.toggle.getAttribute('aria-expanded') !== 'true')
  state.onListClick = (event) => {
    const target = event.target
    if (!(target instanceof Element) || !target.closest('button[data-product-id]')) return
    requestAnimationFrame(() => {
      if (!document.contains(state.picker)) return
      refresh(state)
      setOpen(state, false)
      state.toggle.focus({ preventScroll: true })
    })
  }

  toggle.addEventListener('click', state.onToggle)
  list.addEventListener('click', state.onListClick)
  picker.insertBefore(toggle, list)
  picker.dataset.mobileDisclosure = 'true'
  states.set(picker, state)
  setOpen(state, false)
  refresh(state)
}

function unenhance(state: PickerState) {
  state.toggle.removeEventListener('click', state.onToggle)
  state.list.removeEventListener('click', state.onListClick)
  state.toggle.remove()
  state.list.hidden = false
  state.list.classList.remove('compare-mobile-candidate-options')
  state.picker.classList.remove('is-open')
  delete state.picker.dataset.mobileDisclosure
  states.delete(state.picker)
}

function sync() {
  syncing = false
  const mobile = window.matchMedia('(max-width: 760px)').matches

  for (const state of [...states.values()]) {
    if (!document.contains(state.picker) || !mobile) unenhance(state)
    else refresh(state)
  }

  if (!mobile) return
  document.querySelectorAll<HTMLElement>(PICKER_SELECTOR).forEach(enhance)
}

function scheduleSync() {
  if (syncing) return
  syncing = true
  queueMicrotask(sync)
}

export function installMobileSwitchComparePicker() {
  const media = window.matchMedia('(max-width: 760px)')
  const observer = new MutationObserver(scheduleSync)
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-pressed', 'class'] })
  media.addEventListener('change', scheduleSync)
  scheduleSync()
}
