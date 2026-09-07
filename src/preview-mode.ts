// Fixture data is available through the local dev server only.
export function isDemoPreview(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get('demo') === '1'
}

export function isRealVisualPreview(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get('realpreview') === '1'
}

export function isStressPreview(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get('stresspreview') === '1'
}

export function isPreviewDataEnabled(): boolean {
  return isDemoPreview() || isRealVisualPreview() || isStressPreview()
}
