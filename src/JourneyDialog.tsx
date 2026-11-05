import { useEffect, useRef, type ReactNode } from 'react'
import './journey-review.css'

export function JourneyDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    if (ref.current?.showModal) ref.current.showModal()
    else ref.current?.setAttribute('open', '')
    return () => { previous?.isConnected && previous.focus({ preventScroll: true }) }
  }, [])
  return <dialog className="journey-dialog" ref={ref} aria-label={title} onCancel={(event) => { event.preventDefault(); onClose() }}>
    <div className="journey-dialog-heading"><h2>{title}</h2><button type="button" onClick={onClose} aria-label="닫기">닫기 ×</button></div>{children}
  </dialog>
}
