import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import { renderEntryPages, entryApplicationUrls } from '../scripts/build-entry-pages.mjs'

const snapshot = JSON.parse(await fs.readFile(new URL('../data/entry-products.json', import.meta.url), 'utf8'))
test('public identity entries have unique crawlable product URLs, exact app identities and consistent canonical addresses', () => {
  const pages = renderEntryPages(snapshot)
  const base = 'https://osrm.github.io/catfood_web/'
  const index = new JSDOM(pages.get('foods/index.html'), { url: base + 'foods/' })
  assert.equal(index.window.document.querySelectorAll('.product-list a[href]').length, 3)
  for (const p of snapshot.products) {
    const doc = new JSDOM(pages.get(`foods/${p.slug}/index.html`), { url: base + `foods/${p.slug}/` }).window.document
    assert.equal(doc.querySelector('link[rel=canonical]').href, base + `foods/${p.slug}/`)
    assert.equal(doc.querySelector('meta[property="og:url"]').content, doc.querySelector('link[rel=canonical]').href)
    assert.ok(doc.title.includes(p.brand) && doc.title.includes(p.name))
    assert.equal(doc.querySelector('h1').textContent, p.name)
    const target = new URL(doc.querySelector('a.primary').href)
    assert.equal(target.pathname, '/catfood_web/')
    assert.equal(target.searchParams.get('detail'), p.productId)
    assert.equal(doc.querySelector('link[rel=stylesheet]').href, base + 'foods/entry-pages.css')
    assert.ok(pages.get('sitemap.xml').includes(base + `foods/${p.slug}/`))
    assert.equal(doc.querySelector('script'), null, 'identity content and links are available without JavaScript')
  }
})
test('entry HTML escapes catalog text and refuses ambiguous identity/canonical input', () => {
  const altered = structuredClone(snapshot)
  altered.products[0].name = '<script>alert(1)</script> & "long name"'
  const doc = new JSDOM(renderEntryPages(altered).get('foods/aatu-salmon/index.html')).window.document
  assert.equal(doc.querySelector('script'), null)
  assert.equal(doc.querySelector('h1').textContent, altered.products[0].name)
  altered.products[1].slug = altered.products[0].slug
  assert.throws(() => renderEntryPages(altered), /duplicate/)
  assert.throws(() => renderEntryPages(snapshot, 'https://example.test/?memo=private'), /site base/)
})

test('enhanced entry loads only built application assets at the project root and retains no-JS identity content', () => {
  const pages = renderEntryPages(snapshot, undefined, { script: './assets/index-example.js', stylesheet: './assets/index-example.css' })
  const doc = new JSDOM(pages.get('foods/aatu-salmon/index.html'), { url: 'https://osrm.github.io/catfood_web/foods/aatu-salmon/' }).window.document
  const assets = { script: './assets/index-example.js', stylesheet: './assets/index-example.css' }
  assert.deepEqual(entryApplicationUrls('https://osrm.github.io/catfood_web/foods/aatu-salmon/', assets, snapshot.products[0].productId), {
    script: 'https://osrm.github.io/catfood_web/assets/index-example.js',
    stylesheet: 'https://osrm.github.io/catfood_web/assets/index-example.css',
    location: 'https://osrm.github.io/catfood_web/?view=workspace&mode=lookup&detail=product_d99406c26240b263',
  })
  assert.equal(entryApplicationUrls('https://example.test/foods/aatu-salmon/', assets, snapshot.products[0].productId).script, 'https://example.test/assets/index-example.js')
  assert.equal(doc.querySelector('#root h1').textContent, snapshot.products[0].name)
  assert.match(doc.querySelector('script[type=module]').textContent, /history.replaceState/)
  assert.throws(() => renderEntryPages(snapshot, undefined, { script: 'https://untrusted.test/script.js', stylesheet: './assets/index-example.css' }), /built application assets/)
})
