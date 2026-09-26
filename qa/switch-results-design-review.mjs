import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'
const OUT=process.env.OUT_DIR||'switch-results-review-output'
await mkdir(OUT,{recursive:true})
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})
const report={prototypeSourceCommit:process.env.GITHUB_SHA,prototypeHtmlBlobSha:'6429d9ce9fa3d79183c028bd6f82b2913b539696',generatedAt:new Date().toISOString(),note:'Static prototype validation only; not product verification.',scenarios:{}}
const rect=e=>e?(()=>{const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}})():null
async function snapshot(page,key){
 return page.evaluate(()=>{
  const q=s=>document.querySelector(s), r=e=>{if(!e)return null;const x=e.getBoundingClientRect();return{top:x.top,bottom:x.bottom,left:x.left,right:x.right,width:x.width,height:x.height}},
  cs=e=>{if(!e)return null;const s=getComputedStyle(e);return{fontFamily:s.fontFamily,fontSize:s.fontSize,lineHeight:s.lineHeight,fontWeight:s.fontWeight,wordBreak:s.wordBreak,overflowWrap:s.overflowWrap,whiteSpace:s.whiteSpace}},
  visible=e=>!!e&&getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().height>0;
  const first=q('.panel:not(.split) .row'), ins=q('.ins'), close=q('.close'), actions=q('.actions'), decision=q('.decision'), facts=q('.facts');
  return {
   viewport:{width:innerWidth,height:innerHeight},
   document:{scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight},
   session:{box:r(q('.context')),typography:cs(q('.context .v'))},
   results:{heading:r(q('.panel:not(.split) .head')),firstCandidate:r(first),identityTypography:cs(first?.querySelector('.name')),relationTypography:cs(first?.querySelector('.rel strong'))},
   quickView:{box:r(ins),identity:r(q('.identity')),actions:r(actions),relations:r(decision),facts:r(facts),close:{box:r(close),typography:cs(close),visible:visible(close)},identityTypography:cs(q('.identity h1')),relationTypography:cs(q('.decision .rel strong')),factTypography:cs(q('.facts div')),actionButtons:[...document.querySelectorAll('.actions button')].map(b=>({text:b.textContent.trim(),box:r(b),typography:cs(b)}))},
   list:{box:r(q('.list')),selected:r(q('.list .selected')),unknown:r(q('.list .row:nth-of-type(3)')),selectedRelations:[...q('.list .selected')?.querySelectorAll('.rel')||[]].map(r),unknownRelations:[...q('.list .row:nth-of-type(3)')?.querySelectorAll('.rel')||[]].map(r)}
  }
 })
}
for(const [key,w,h] of [['mobile-390x844',390,844],['desktop-1440x900',1440,900]]){
 const context=await browser.newContext({viewport:{width:w,height:h}}), page=await context.newPage()
 await page.goto('file://'+process.env.GITHUB_WORKSPACE+'/qa/switch-results-design-prototype.html')
 await page.evaluate(()=>document.fonts.ready); await page.waitForTimeout(250)
 const results=await snapshot(page,key)
 await page.screenshot({path:OUT+'/'+key+'-prototype-results.png',fullPage:false})
 await page.evaluate(()=>{document.querySelectorAll('.panel')[0].style.display='none';document.querySelector('.split').style.marginTop='14px'})
 const quick=await snapshot(page,key)
 await page.screenshot({path:OUT+'/'+key+'-prototype-quick-view.png',fullPage:false})
 await page.locator('.close').focus()
 const focus=await page.evaluate(()=>{const e=document.activeElement,s=getComputedStyle(e),r=e.getBoundingClientRect();return{aria:e.getAttribute('aria-label'),outlineWidth:s.outlineWidth,outlineStyle:s.outlineStyle,box:{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}}})
 await page.locator('.close').click()
 const returned=await page.evaluate(()=>({listVisible:getComputedStyle(document.querySelector('.list')).display!=='none',inspectorVisible:getComputedStyle(document.querySelector('.ins')).display!=='none',focusedClass:document.activeElement?.className||'',focusedText:document.activeElement?.textContent?.replace(/\s+/g,' ').trim()||''}))
 assert.equal(results.document.scrollWidth,w); assert.equal(quick.document.scrollWidth,w)
 assert.ok(quick.quickView.close.box.width>=44&&quick.quickView.close.box.height>=44)
 assert.ok(parseFloat(focus.outlineWidth)>=2)
 if(w===390){assert.equal(returned.listVisible,true);assert.equal(returned.inspectorVisible,false);assert.match(returned.focusedClass,/selected/)}
 report.scenarios[key]={results,quickView:quick,closeFocus:focus,afterClose:returned,firstViewport:{height:h,identityBottom:quick.quickView.identity?.bottom,actionsBottom:quick.quickView.actions?.bottom,relationsBottom:quick.quickView.relations?.bottom,factsTop:quick.quickView.facts?.top,factsBottom:quick.quickView.facts?.bottom}}
 await context.close()
}
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
