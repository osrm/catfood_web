from pathlib import Path

app = Path('src/App.tsx')
text = app.read_text(encoding='utf-8')
old = '<button className="research-brand" type="button" onClick={goHome}>FELINE ARCHIVE</button>'
new = '<button className="research-brand" type="button" aria-label="CATFOOD 홈으로 이동" onClick={goHome}>FELINE ARCHIVE</button>'
assert text.count(old) == 1, f'App brand match count: {text.count(old)}'
app.write_text(text.replace(old, new), encoding='utf-8')

switch = Path('src/SwitchFlow.tsx')
text = switch.read_text(encoding='utf-8')
old_brand = '<button className="research-brand" type="button" onClick={onHome}>FELINE ARCHIVE</button>'
new_brand = '<button className="research-brand" type="button" aria-label="CATFOOD 홈으로 이동" onClick={onHome}>FELINE ARCHIVE</button>'
old_current = '<button className="mode-button is-active" type="button">현재 사료</button>'
new_current = '<button className="mode-button is-active" type="button" aria-current="page">현재 사료</button>'
assert text.count(old_brand) == 1, f'SWITCH brand match count: {text.count(old_brand)}'
assert text.count(old_current) == 1, f'current mode match count: {text.count(old_current)}'
text = text.replace(old_brand, new_brand).replace(old_current, new_current)
switch.write_text(text, encoding='utf-8')

css = Path('src/switch-workflow.css')
text = css.read_text(encoding='utf-8')
anchor = '''.switch-workflow-shell .mode-button {
  font-size: 13px;
}
'''
focus = '''.switch-workflow-shell .mode-button {
  font-size: 13px;
}

.switch-workflow-shell .research-brand:focus-visible,
.switch-workflow-shell .mode-button:focus-visible {
  outline: 3px solid rgba(22, 61, 53, 0.28);
  outline-offset: 2px;
}
'''
assert text.count(anchor) == 1, f'focus anchor count: {text.count(anchor)}'
text = text.replace(anchor, focus)
old_mobile = '''@media (max-width: 760px) {
  .switch-workflow-shell {
    min-height: 100vh;
    height: auto;
  }

  .switch-workflow-shell .research-topbar {
    grid-template-columns: 1fr auto;
    padding: 0 18px;
  }

  .switch-workflow-shell .mode-nav {
    display: none;
  }
'''
new_mobile = '''@media (max-width: 760px) {
  .research-shell.switch-workflow-shell {
    min-height: 100vh;
    height: auto;
    grid-template-rows: 104px minmax(0, 1fr);
  }

  .switch-workflow-shell .research-topbar {
    min-height: 104px;
    grid-template-columns: 1fr auto;
    grid-template-rows: 56px 48px;
    gap: 0;
    padding: 0 18px;
  }

  .research-shell.switch-workflow-shell .research-brand {
    grid-column: 1;
    grid-row: 1;
  }

  .research-shell.switch-workflow-shell .mode-nav {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    grid-column: 1 / -1;
    grid-row: 2;
    align-self: stretch;
    gap: 0;
    min-width: 0;
    overflow: visible;
    border-top: 1px solid var(--research-line);
  }

  .research-shell.switch-workflow-shell .mode-button {
    min-width: 0;
    height: 48px;
    padding: 0 6px;
    white-space: nowrap;
  }
'''
assert text.count(old_mobile) == 1, f'mobile block match count: {text.count(old_mobile)}'
css.write_text(text.replace(old_mobile, new_mobile), encoding='utf-8')
