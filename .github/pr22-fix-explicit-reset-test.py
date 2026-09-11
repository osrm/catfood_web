from pathlib import Path
path = Path('tests/switch-session-navigation.test.mjs')
text = path.read_text()
old = "  assert.doesNotMatch(dock, /전환 습식 A/)\n  assert.match(dock, /전환 습식 B/)\n\n  await click('현재 사료 다시 선택')\n  await waitForUi(() => document.body.textContent.includes('현재 먹이는 사료를 찾으세요'), 'explicit current-food reset')"
new = "  assert.doesNotMatch(dock, /전환 습식 A/)\n  assert.match(dock, /전환 습식 B/)\n\n  await click('조건 수정')\n  await waitForUi(() => document.body.textContent.includes('무엇을 바꾸고 싶나요?'), 'return to editable SWITCH conditions')\n  await click('현재 사료 다시 선택')\n  await waitForUi(() => document.body.textContent.includes('현재 먹이는 사료를 찾으세요'), 'explicit current-food reset')"
if old not in text:
    raise SystemExit('explicit reset test anchor missing')
path.write_text(text.replace(old, new, 1))
print('PR22_EXPLICIT_RESET_TEST_PATCHED')
