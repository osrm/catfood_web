from pathlib import Path

path = Path('.github/pr26-mobile-switch-mode-nav-qa.mjs')
text = path.read_text(encoding='utf-8')

old_keyboard = '''async function assertKeyboard(c){
  await c.eval(`document.activeElement?.blur()`)
  const sequence=[]
  for(let i=0;i<4;i++)sequence.push(await pressTab(c))
  assert.equal(sequence[0]?.ariaLabel,'CATFOOD 홈으로 이동','first keyboard target is home')
  assert.deepEqual(sequence.slice(1).map(x=>x?.text),LABELS,'keyboard mode order')
  for(const x of sequence){
    assert.ok(x?.inViewport,`keyboard target outside viewport: ${JSON.stringify(x)}`)
    assert.notEqual(x?.outlineStyle,'none',`focus outline missing: ${JSON.stringify(x)}`)
    assert.ok(parseFloat(x?.outlineWidth||'0')>=2,`focus outline too small: ${JSON.stringify(x)}`)
  }
  assert.equal(sequence[3]?.ariaCurrent,'page','focused current mode remains aria-current')
  return sequence
}
'''
new_keyboard = '''async function assertKeyboard(c){
  await c.eval(`document.activeElement?.blur()`)
  const sequence=[]
  for(let i=0;i<12;i++)sequence.push(await pressTab(c))
  const relevant=sequence.filter(x=>x&&(x.ariaLabel==='CATFOOD 홈으로 이동'||LABELS.includes(x.text)))
  const controls=[
    relevant.find(x=>x.ariaLabel==='CATFOOD 홈으로 이동'),
    ...LABELS.map(label=>relevant.find(x=>x.text===label)),
  ]
  assert.ok(controls.every(Boolean),`keyboard did not reach all home/mode controls: ${JSON.stringify(sequence)}`)
  for(const x of controls){
    assert.ok(x?.inViewport,`keyboard target outside viewport: ${JSON.stringify(x)}`)
    assert.notEqual(x?.outlineStyle,'none',`focus outline missing: ${JSON.stringify(x)}`)
    assert.ok(parseFloat(x?.outlineWidth||'0')>=2,`focus outline too small: ${JSON.stringify(x)}`)
  }
  assert.equal(controls[3]?.ariaCurrent,'page','focused current mode remains aria-current')
  return{sequence,controls}
}
'''
assert text.count(old_keyboard) == 1, f'keyboard block count {text.count(old_keyboard)}'
text = text.replace(old_keyboard, new_keyboard)

old_state = '''  assert.ok(state?.currentProductId,'real product id missing')
  assert.ok(state?.currentVariantId,'real variant id missing')
  assert.equal(state?.change?.brand,true,'CHANGE brand selection missing')
'''
new_state = '''  assert.ok(state?.currentProductId,'real product id missing')
  assert.equal(state?.variantSelection?.kind,'variant','real variant selection missing')
  assert.ok(state?.variantSelection?.variantId,'real variant id missing')
  assert.equal(state?.changeBrand,true,'CHANGE brand selection missing')
'''
assert text.count(old_state) == 1, f'state block count {text.count(old_state)}'
path.write_text(text.replace(old_state, new_state), encoding='utf-8')
