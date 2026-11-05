import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
function startup() {
  const timers = new Map()
  const dom = new JSDOM(html, { url: 'https://catfood.test/catfood_web/?view=workspace&mode=switch', runScripts: 'dangerously', beforeParse(window) {
    window.setTimeout = callback => { timers.set(1, callback); return 1 }
    window.clearTimeout = id => timers.delete(id)
  } })
  return { dom, window: dom.window, document: dom.window.document, timers }
}

test('entry has readable startup and reload navigation before the application or stylesheet loads', () => {
  const { dom, document } = startup()
  try {
    assert.match(document.querySelector('#root').textContent, /CATFOOD.*화면을 여는 중/s)
    const retry = new URL(document.querySelector('#startup-panel a').href)
    assert.equal(retry.pathname, '/catfood_web/')
    assert.equal(retry.search, '?view=workspace&mode=switch')
    assert.match(document.querySelector('noscript').textContent, /JavaScript/)
    assert.equal(document.querySelector('#startup-retry').hidden,true)
  } finally { dom.window.close() }
})

test('failed module reports recovery, while image failures and an already-ready app do not overwrite the screen', () => {
  const { dom, window, document, timers } = startup()
  try {
    const image = document.createElement('img');document.body.append(image)
    image.dispatchEvent(new window.Event('error'))
    assert.equal(document.querySelector('#startup-panel').getAttribute('role'), 'status')
    document.querySelector('script[type="module"]').dispatchEvent(new window.Event('error'))
    assert.match(document.querySelector('#startup-message').textContent, /화면을 불러오지 못했습니다/)
    assert.equal(document.querySelector('#startup-panel').getAttribute('role'), 'alert')
    assert.equal(timers.size, 0)
    assert.equal(document.querySelector('#startup-retry').hidden,false)
  } finally { dom.window.close() }
})

test('module retry preserves the document, URL, history and local work while making only one fresh attempt at a time',()=>{
  const {dom,window,document,timers}=startup()
  try {
    const original=document.querySelector('script[type="module"]'),panel=document.getElementById('startup-panel'),retry=document.getElementById('startup-retry')
    window.history.replaceState({selection:'kept'},'',window.location.href)
    window.sessionStorage.setItem('catfood.switch-session.v1','saved work')
    const url=window.location.href,historyLength=window.history.length
    const style=document.createElement('link');style.rel='stylesheet';style.href='/catfood_web/assets/style.css';document.head.append(style)
    original.dispatchEvent(new window.Event('error'))
    retry.click()
    const first=document.querySelector('script[type="module"][src*="_catfood_retry"]')
    assert.equal(new URL(first.src).pathname,new URL(original.src).pathname)
    assert.ok(new URL(first.src).searchParams.has('_catfood_retry'))
    assert.equal(retry.disabled,true)
    retry.click()
    assert.equal(document.querySelectorAll('script[type="module"]').length,2,'no second request while the first one is pending')
    first.dispatchEvent(new window.Event('error'))
    assert.equal(retry.disabled,false)
    retry.click()
    const second=document.querySelectorAll('script[type="module"][src*="_catfood_retry"]')[1]
    assert.notEqual(second.src,first.src,'the module map must not reuse the failed URL')
    assert.equal(document.querySelectorAll('[data-startup-retry-style]').length,1,'pending stylesheet retries do not multiply')
    assert.equal(window.location.href,url)
    assert.equal(window.history.length,historyLength)
    assert.deepEqual(window.history.state,{selection:'kept'})
    assert.equal(window.sessionStorage.getItem('catfood.switch-session.v1'),'saved work')
    assert.equal(panel,document.getElementById('startup-panel'))
    timers.get(1)()
    assert.equal(retry.hidden,true,'a hanging module is not evaluated again without a new load failure')
  } finally {dom.window.close()}
})

test('an execution failure offers a document reload without evaluating the entry module twice',()=>{
  const {dom,window,document}=startup()
  try {
    window.dispatchEvent(new window.ErrorEvent('error',{message:'execution failed'}))
    assert.equal(document.querySelector('#startup-retry').hidden,true)
    assert.equal(document.querySelector('#startup-panel').getAttribute('role'),'alert')
    assert.equal(document.querySelectorAll('script[type="module"]').length,1)
    assert.equal(new URL(document.querySelector('#startup-panel a').href).search,window.location.search)
  } finally {dom.window.close()}
})

test('slow start keeps a retry and readiness cancels startup guards without clearing stored work', () => {
  const { dom, window, document, timers } = startup()
  try {
    window.sessionStorage.setItem('catfood.switch-session.v1', 'existing work')
    timers.get(1)()
    assert.match(document.querySelector('#startup-message').textContent, /시간이 걸리고/)
    document.dispatchEvent(new window.Event('catfood:ready'))
    assert.equal(timers.size, 0)
    document.querySelector('script[type="module"]').dispatchEvent(new window.Event('error'))
    assert.equal(document.querySelector('#startup-panel').getAttribute('role'), 'status')
    assert.equal(window.sessionStorage.getItem('catfood.switch-session.v1'), 'existing work')
  } finally { dom.window.close() }
})

test('a render failure leaves a reload screen and preserves navigation and saved work', async () => {
  const { build } = await import('vite')
  const { mkdir, mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { resolve } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { act, createElement } = await import('react')
  const { dom, window, document, timers } = startup()
  globalThis.window=window;globalThis.document=document;globalThis.IS_REACT_ACT_ENVIRONMENT=true
  const { createRoot } = await import('react-dom/client')
  await mkdir('node_modules/.cache',{recursive:true})
  const temp=await mkdtemp(resolve('node_modules/.cache/startup-'))
  const root=createRoot(document.getElementById('root')), nativeError=console.error
  try {
    const result=await build({configFile:false,logLevel:'silent',build:{ssr:'src/ApplicationBoundary.tsx',write:false,minify:false}})
    const file=resolve(temp,'boundary.mjs');await writeFile(file,result.output.find(item=>item.type==='chunk'&&item.isEntry).code)
    const { default: Boundary }=await import(pathToFileURL(file).href)
    window.sessionStorage.setItem('catfood.switch-session.v1','saved selection')
    console.error=()=>{}
    function BrokenScreen(){throw new Error('internal diagnostic text')}
    await act(async()=>root.render(createElement(Boundary,null,createElement(BrokenScreen))))
    assert.match(document.querySelector('[role="alert"]').textContent,/화면을 표시하지 못했습니다/)
    assert.doesNotMatch(document.body.textContent,/internal diagnostic text/)
    assert.equal(new URL(document.querySelector('a').href).search,'?view=workspace&mode=switch')
    assert.equal(window.sessionStorage.getItem('catfood.switch-session.v1'),'saved selection')
    assert.equal(timers.size,0)
  } finally { console.error=nativeError;await act(async()=>root.unmount());dom.window.close();await rm(temp,{recursive:true}) }
})
