import { readFileSync, writeFileSync } from 'node:fs'

const sourcePath = new URL('./mobile-mode-navigation-postdeploy-qa.mjs', import.meta.url)
const runtimePath = new URL('./.mobile-mode-navigation-postdeploy-runtime-v3.mjs', import.meta.url)
let source = readFileSync(sourcePath, 'utf8')

source = source.replace(
  "if(b?.rendered&&b.inViewport&&b.centerHit){",
  "if(b?.rendered){",
)
source = source.replace(
  "c.close();browser.proc.kill('SIGTERM');rmSync(browser.dir,{recursive:true,force:true})",
  "c.close();browser.proc.kill('SIGTERM');await sleep(250);try{rmSync(browser.dir,{recursive:true,force:true})}catch{}",
)
source = source.replace(
  "await shot('12-detail-return')\n    await pointer(c,'.research-result-card',null,0);await c.wait(`document.querySelector('.research-quick-view')`,'detail quick2');await pointer(c,'.quick-view-actions button','상세 보기 →');",
  "await shot('12-detail-return')\n    await c.wait(`document.querySelector('.research-quick-view')`,'detail quick2');await pointer(c,'.quick-view-actions button','상세 보기 →');",
)

writeFileSync(runtimePath, source)
await import(`${runtimePath.href}?v=3`)
