from pathlib import Path

path = Path('src/App.tsx')
text = path.read_text()

old = "  const switchSessionRef = useRef<SwitchSessionState>(initialSwitchSession)\n  const pendingSwitchPopPatch = useRef<Partial<SwitchSessionState> | null>(null)\n  const exploreRunId = useRef<string | null>(null)"
new = "  const switchSessionRef = useRef<SwitchSessionState>(initialSwitchSession)\n  const pendingSwitchPopPatch = useRef<Partial<SwitchSessionState> | null>(null)\n  const switchHistoryEntryRef = useRef<SwitchHistoryEntry | null>(\n    ((typeof window !== 'undefined' ? window.history.state : null) as HistoryPayload | null)?.catfoodSwitchEntry ?? null,\n  )\n  const exploreRunId = useRef<string | null>(null)"
if old not in text:
    raise SystemExit('history ref anchor missing')
text = text.replace(old, new, 1)

old = "    if (action === 'push') {\n      const payload: HistoryPayload = { catfoodSwitch: createSwitchSessionSnapshot(next) }\n      if (entry) payload.catfoodSwitchEntry = entry\n      window.history.pushState(payload, '', url)\n      return\n    }"
new = "    if (action === 'push') {\n      const payload: HistoryPayload = { catfoodSwitch: createSwitchSessionSnapshot(next) }\n      if (entry) payload.catfoodSwitchEntry = entry\n      switchHistoryEntryRef.current = entry ?? null\n      window.history.pushState(payload, '', url)\n      return\n    }"
if old not in text:
    raise SystemExit('push anchor missing')
text = text.replace(old, new, 1)

old = "    if (entry !== undefined) {\n      if (entry) payload.catfoodSwitchEntry = entry\n      else delete payload.catfoodSwitchEntry\n    }\n    window.history.replaceState(payload, '', url)"
new = "    if (entry !== undefined) {\n      if (entry) payload.catfoodSwitchEntry = entry\n      else delete payload.catfoodSwitchEntry\n      switchHistoryEntryRef.current = entry ?? null\n    }\n    window.history.replaceState(payload, '', url)"
if old not in text:
    raise SystemExit('replace marker anchor missing')
text = text.replace(old, new, 1)

old = "      const payload = (event.state ?? {}) as HistoryPayload\n      const restored = parseSwitchSessionSnapshot(payload.catfoodSwitch)\n      const patch = pendingSwitchPopPatch.current\n      pendingSwitchPopPatch.current = null\n      if (restored || patch) {"
new = "      const payload = (event.state ?? {}) as HistoryPayload\n      const restored = parseSwitchSessionSnapshot(payload.catfoodSwitch)\n      const previousSwitchEntry = switchHistoryEntryRef.current\n      const incomingSwitchEntry = payload.catfoodSwitchEntry ?? null\n      let patch = pendingSwitchPopPatch.current\n      pendingSwitchPopPatch.current = null\n      if (\n        !patch\n        && previousSwitchEntry === 'compare'\n        && incomingSwitchEntry !== 'detail'\n        && restored\n        && !restored.compareOpen\n      ) {\n        patch = { compareIds: switchSessionRef.current.compareIds }\n      }\n      if (restored || patch) {"
if old not in text:
    raise SystemExit('pop patch anchor missing')
text = text.replace(old, new, 1)

old = "        if (patch) {\n          window.history.replaceState({ ...payload, catfoodSwitch: createSwitchSessionSnapshot(next) }, '', window.location.href)\n        }\n      }\n      const restore = payload.catfoodList ?? null"
new = "        if (patch) {\n          window.history.replaceState({ ...payload, catfoodSwitch: createSwitchSessionSnapshot(next) }, '', window.location.href)\n        }\n      }\n      switchHistoryEntryRef.current = incomingSwitchEntry\n      const restore = payload.catfoodList ?? null"
if old not in text:
    raise SystemExit('pop ref anchor missing')
text = text.replace(old, new, 1)

path.write_text(text)
print('PR22_COMPARE_HISTORY_PATCHED')
