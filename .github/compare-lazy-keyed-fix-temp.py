from pathlib import Path
import re

p = Path('src/CompareView.tsx')
s = p.read_text()

if 'nutritionErrorKeyRef = useRef<string | null>(null)' not in s:
    old = """  const nutritionLoadedKeyRef = useRef<string | null>(null)
  const ingredientsLoadedKeyRef = useRef<string | null>(null)
  const variantsLoadedKeyRef = useRef<string | null>(null)
  const currentNutritionLoadedProductRef = useRef<string | null>(null)
  const currentVariantsLoadedProductRef = useRef<string | null>(null)
"""
    new = old + """  const nutritionErrorKeyRef = useRef<string | null>(null)
  const ingredientsErrorKeyRef = useRef<string | null>(null)
  const currentNutritionErrorProductRef = useRef<string | null>(null)
"""
    assert old in s
    s = s.replace(old, new, 1)

    replacements = {
        "nutritionLoadedKeyRef.current !== key && !nutritionError": "nutritionLoadedKeyRef.current !== key && nutritionErrorKeyRef.current !== key",
        "ingredientsLoadedKeyRef.current !== key && !ingredientsError": "ingredientsLoadedKeyRef.current !== key && ingredientsErrorKeyRef.current !== key",
        "currentNutritionLoadedProductRef.current !== currentProduct.product_id && !currentNutritionError": "currentNutritionLoadedProductRef.current !== currentProduct.product_id && currentNutritionErrorProductRef.current !== currentProduct.product_id",
        "nutritionLoadedKeyRef.current !== productKey && !nutritionError": "nutritionLoadedKeyRef.current !== productKey && nutritionErrorKeyRef.current !== productKey",
        "ingredientsLoadedKeyRef.current !== productKey && !ingredientsError": "ingredientsLoadedKeyRef.current !== productKey && ingredientsErrorKeyRef.current !== productKey",
        "currentNutritionLoadedProductRef.current !== productId && !currentNutritionError": "currentNutritionLoadedProductRef.current !== productId && currentNutritionErrorProductRef.current !== productId",
    }
    for old, new in replacements.items():
        assert old in s, old
        s = s.replace(old, new)

    old = """    nutritionLoadedKeyRef.current = null
    ingredientsLoadedKeyRef.current = null
    variantsLoadedKeyRef.current = null
    setNutrition([])
"""
    new = """    nutritionLoadedKeyRef.current = null
    ingredientsLoadedKeyRef.current = null
    variantsLoadedKeyRef.current = null
    nutritionErrorKeyRef.current = null
    ingredientsErrorKeyRef.current = null
    setNutrition([])
"""
    assert old in s
    s = s.replace(old, new, 1)

    old = """        setNutrition(rows)
        nutritionLoadedKeyRef.current = productKey
"""
    new = """        setNutrition(rows)
        nutritionLoadedKeyRef.current = productKey
        nutritionErrorKeyRef.current = null
        setNutritionError(null)
"""
    assert old in s
    s = s.replace(old, new, 1)

    old = """        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (active) setNutritionError('영양 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')
"""
    new = """        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (active) {
          nutritionErrorKeyRef.current = productKey
          setNutritionError('영양 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')
        }
"""
    assert old in s
    s = s.replace(old, new, 1)

    old = """        setIngredients(rows)
        ingredientsLoadedKeyRef.current = productKey
"""
    new = """        setIngredients(rows)
        ingredientsLoadedKeyRef.current = productKey
        ingredientsErrorKeyRef.current = null
        setIngredientsError(null)
"""
    assert old in s
    s = s.replace(old, new, 1)

    old = """        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (active) setIngredientsError('원재료 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')
"""
    new = """        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (active) {
          ingredientsErrorKeyRef.current = productKey
          setIngredientsError('원재료 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')
        }
"""
    assert old in s
    s = s.replace(old, new, 1)

    old = """    currentNutritionLoadedProductRef.current = null
    currentVariantsLoadedProductRef.current = null
    setCurrentNutrition(null)
"""
    new = """    currentNutritionLoadedProductRef.current = null
    currentVariantsLoadedProductRef.current = null
    currentNutritionErrorProductRef.current = null
    setCurrentNutrition(null)
"""
    assert old in s
    s = s.replace(old, new, 1)

    old = """        setCurrentNutrition(rows[0] ?? null)
        currentNutritionLoadedProductRef.current = productId
"""
    new = """        setCurrentNutrition(rows[0] ?? null)
        currentNutritionLoadedProductRef.current = productId
        currentNutritionErrorProductRef.current = null
        setCurrentNutritionError(null)
"""
    assert old in s
    s = s.replace(old, new, 1)

    old = """        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (active) setCurrentNutritionError('현재 사료 영양 정보를 불러오지 못했습니다.')
"""
    new = """        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (active) {
          currentNutritionErrorProductRef.current = productId
          setCurrentNutritionError('현재 사료 영양 정보를 불러오지 못했습니다.')
        }
"""
    assert old in s
    s = s.replace(old, new, 1)

    marker = "  if (detailItem) return <ProductDetail"
    assert marker in s
    active = """  const activeNutritionError = nutritionErrorKeyRef.current === productKey ? nutritionError : null
  const activeIngredientsError = ingredientsErrorKeyRef.current === productKey ? ingredientsError : null
  const activeCurrentNutritionError = currentProduct && currentNutritionErrorProductRef.current === currentProduct.product_id ? currentNutritionError : null

"""
    s = s.replace(marker, active + marker, 1)

    idx = s.index(marker)
    head, tail = s[:idx], s[idx:]
    tail = re.sub(r'\bcurrentNutritionError\b', 'activeCurrentNutritionError', tail)
    tail = re.sub(r'\bnutritionError\b', 'activeNutritionError', tail)
    tail = re.sub(r'\bingredientsError\b', 'activeIngredientsError', tail)
    s = head + tail

    old = "onClick={() => { nutritionLoadedKeyRef.current = null; setNutritionError(null); setNutritionLoading(true); setReload((value) => value + 1) }}>다시 시도</button>"
    new = "onClick={() => { nutritionLoadedKeyRef.current = null; nutritionErrorKeyRef.current = null; setNutritionError(null); setNutritionLoading(true); setReload((value) => value + 1) }}>다시 시도</button>"
    assert old in s
    s = s.replace(old, new, 1)

    old = "onClick={() => { ingredientsLoadedKeyRef.current = null; setIngredientsError(null); setIngredientsLoading(true); setReload((value) => value + 1) }}>다시 시도</button>"
    new = "onClick={() => { ingredientsLoadedKeyRef.current = null; ingredientsErrorKeyRef.current = null; setIngredientsError(null); setIngredientsLoading(true); setReload((value) => value + 1) }}>다시 시도</button>"
    assert old in s
    s = s.replace(old, new, 1)

    old = "onClick={() => { currentNutritionLoadedProductRef.current = null; setCurrentNutritionError(null); setCurrentNutritionLoading(true); setCurrentNutritionReload((value) => value + 1) }}>현재 사료 다시 시도</button>"
    new = "onClick={() => { currentNutritionLoadedProductRef.current = null; currentNutritionErrorProductRef.current = null; setCurrentNutritionError(null); setCurrentNutritionLoading(true); setCurrentNutritionReload((value) => value + 1) }}>현재 사료 다시 시도</button>"
    assert old in s
    s = s.replace(old, new, 1)

    old = "onClick={() => setReload((value) => value + 1)}>후보 다시 시도</button>"
    new = "onClick={() => { nutritionLoadedKeyRef.current = null; nutritionErrorKeyRef.current = null; setNutritionError(null); setNutritionLoading(true); setReload((value) => value + 1) }}>후보 다시 시도</button>"
    assert old in s
    s = s.replace(old, new, 1)

    p.write_text(s)


t = Path('tests/switch-compare-overview.test.mjs')
s = t.read_text()
if 'SWITCH candidate nutrition manual retry clears the failed request key' not in s:
    s += r'''

function nutritionFixture(productId, kcalPer100g = 422) {
  return {
    product_id: productId, variant_id: null, observation_scope: 'product', market_code: null, panel_type: null,
    protein_pct: null, protein_qualifier: null, fat_pct: null, fat_qualifier: null, fiber_pct: null, fiber_qualifier: null,
    moisture_pct: null, moisture_qualifier: null, ash_pct: null, ash_qualifier: null, kcal_per_kg: null,
    kcal_per_100g: kcalPer100g, energy_basis: null, is_korea_market_observation: false, is_current_resolved_formula: true,
    additional_nutrients: [], supplemental_nutrition_fields: [], basis_specific_nutrition_values: [],
  }
}

function ingredientFixture(productId) {
  return {
    product_id: productId, variant_id: null, observation_scope: 'product', market_code: null, declaration_scope: 'full',
    completeness_status: 'full', raw_text: '오리', ingredient_names: ['오리'], ingredient_count: 1,
    is_korea_market_observation: false, is_current_resolved_formula: true,
  }
}

test('SWITCH candidate nutrition manual retry clears the failed request key and reloads only candidate nutrition', async () => {
  let candidateAttempts = 0
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); requests.push(url)
    if (url.pathname.endsWith('/compare_product_nutrition')) {
      const filter = url.searchParams.get('product_id')
      if (filter === 'in.(product_candidate_a,product_candidate_b)') {
        candidateAttempts += 1
        if (candidateAttempts === 1) return new Response('candidate failed', { status: 503 })
        return Response.json([nutritionFixture(candidateA.product_id, 422), nutritionFixture(candidateB.product_id, 348)])
      }
      if (filter === 'in.(product_current)') return Response.json([nutritionFixture(current.product_id, 370)])
    }
    return Response.json([])
  }
  await renderCompare({ initialTab: 'nutrition' })
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition')).length, 2)
  const retry = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '후보 다시 시도')
  assert.ok(retry)
  await click(retry)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition')).length, 3)
  assert.match(document.body.textContent, /422 kcal\/100g/)
})

test('candidate nutrition failure belongs to the old product key and does not block a replacement product set', async () => {
  const replacement = product('product_replacement', '교체브랜드', '교체 후보')
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); requests.push(url)
    if (url.pathname.endsWith('/compare_product_nutrition')) {
      const filter = url.searchParams.get('product_id')
      if (filter === 'in.(product_candidate_a)') return new Response('old failed', { status: 503 })
      if (filter === 'in.(product_replacement)') return Response.json([nutritionFixture(replacement.product_id, 522)])
    }
    return Response.json([])
  }
  const { baseProps } = await renderCompare({ currentProduct: null, items: [items[0]], initialTab: 'nutrition' })
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition')).length, 1)
  await act(async () => root.render(createElement(app.CompareView, { ...baseProps, currentProduct: null, items: [{ product: replacement }], initialTab: 'nutrition' })))
  await settle()
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition')).length, 2)
  assert.match(document.body.textContent, /522 kcal\/100g/)
})

test('current nutrition failure belongs to the old current product and does not block a replacement current food', async () => {
  const replacementCurrent = product('product_current_replacement', '새현재브랜드', '새 현재 사료')
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); requests.push(url)
    if (url.pathname.endsWith('/compare_product_nutrition')) {
      const filter = url.searchParams.get('product_id')
      if (filter === 'in.(product_current)') return new Response('current failed', { status: 503 })
      if (filter === 'in.(product_current_replacement)') return Response.json([nutritionFixture(replacementCurrent.product_id, 401)])
      return Response.json([])
    }
    return Response.json([])
  }
  const { baseProps } = await renderCompare({ initialTab: 'nutrition' })
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition') && url.searchParams.get('product_id') === 'in.(product_current)').length, 1)
  await act(async () => root.render(createElement(app.CompareView, { ...baseProps, currentProduct: replacementCurrent, initialTab: 'nutrition' })))
  await settle()
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition') && url.searchParams.get('product_id') === 'in.(product_current_replacement)').length, 1)
  assert.match(document.body.textContent, /401 kcal\/100g/)
})

test('ingredients failure belongs to the old product key and does not block a replacement product set', async () => {
  const replacement = product('product_ingredient_replacement', '교체브랜드', '새 원재료 후보')
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); requests.push(url)
    if (url.pathname.endsWith('/compare_product_ingredients')) {
      const filter = url.searchParams.get('product_id')
      if (filter === 'in.(product_candidate_a)') return new Response('ingredient failed', { status: 503 })
      if (filter === 'in.(product_ingredient_replacement)') return Response.json([ingredientFixture(replacement.product_id)])
    }
    return Response.json([])
  }
  const { baseProps } = await renderCompare({ currentProduct: null, items: [items[0]], initialTab: 'ingredients' })
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_ingredients')).length, 1)
  await act(async () => root.render(createElement(app.CompareView, { ...baseProps, currentProduct: null, items: [{ product: replacement }], initialTab: 'ingredients' })))
  await settle()
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_ingredients')).length, 2)
  assert.match(document.body.textContent, /오리/)
})
'''
    t.write_text(s)
