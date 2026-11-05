import { Component, type ReactNode } from 'react'

// Loading and API errors retain their own retry paths. This contains render failures.
export default class ApplicationBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidMount() { document.dispatchEvent(new window.Event('catfood:ready')) }
  render() {
    if (this.state.failed) return <main className="startup-panel" role="alert"><h1>CATFOOD</h1><p>화면을 표시하지 못했습니다. 다시 불러와 주세요.</p><a href="">다시 불러오기</a></main>
    return this.props.children
  }
}
