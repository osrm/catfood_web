from pathlib import Path
path = Path('tests/switch-session-navigation.test.mjs')
text = path.read_text()
anchor = "const exactButton = (text) => all('button').find((node) => node.textContent.trim() === text)\nconst button = (text) => all('button').find((node) => node.textContent.includes(text))"
replacement = "const exactButton = (text) => all('button').find((node) => node.textContent.trim() === text)\nconst variantButton = (text) => all('button').find((node) => node.textContent.includes(text) && node.textContent.includes('단일 판매'))\nconst button = (text) => all('button').find((node) => node.textContent.includes(text))"
if anchor not in text:
    raise SystemExit('selector helper anchor missing')
text = text.replace(anchor, replacement, 1)
text = text.replace("exactButton('1 kg')", "variantButton('1 kg')")
path.write_text(text)
print('PR22_TEST_SELECTOR_PATCHED')
