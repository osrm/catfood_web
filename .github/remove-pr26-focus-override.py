from pathlib import Path

path = Path('src/switch-workflow.css')
text = path.read_text(encoding='utf-8')
block = '''.switch-workflow-shell .research-brand:focus-visible,
.switch-workflow-shell .mode-button:focus-visible {
  outline: 3px solid rgba(22, 61, 53, 0.28);
  outline-offset: 2px;
}

'''
assert text.count(block) == 1, f'focus override count: {text.count(block)}'
path.write_text(text.replace(block, ''), encoding='utf-8')
