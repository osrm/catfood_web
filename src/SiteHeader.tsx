import type { ReactNode, Ref } from 'react'
import './catalog-design-refresh.css'

export type BrowseMode = 'explore' | 'lookup' | 'switch'

export default function SiteHeader({ onHome, onModeChange, active, status, children, className = '', headerRef }: {
  onHome?: () => void
  onModeChange?: (mode: BrowseMode) => void
  active?: BrowseMode
  status?: ReactNode
  children?: ReactNode
  className?: string
  headerRef?: Ref<HTMLElement>
}) {
  return <header className={`site-header ${className}`} ref={headerRef}>
    {onHome ? <button className="site-wordmark research-brand" type="button" aria-label="CATFOOD 홈으로 이동" onClick={onHome}>CATFOOD</button> : <strong className="site-wordmark">CATFOOD</strong>}
    {onModeChange ? <nav className="site-nav mode-nav" aria-label="탐색 모드">
      {([['lookup', '제품 찾기'], ['explore', '조건으로 찾기'], ['switch', '현재 사료']] as const).map(([mode, label]) => <button className={active === mode ? 'mode-button is-active' : 'mode-button'} type="button" key={mode} aria-current={active === mode ? 'page' : undefined} onClick={() => onModeChange(mode)}>{label}</button>)}
    </nav> : null}
    {children ? <div className="site-header-actions">{children}</div> : null}
    {status ? <div className="site-status research-status">{status}</div> : null}
  </header>
}
