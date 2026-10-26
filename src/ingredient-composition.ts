import type { CompareIngredients } from './api'

// A reading aid for the selected source, not a recipe claim or an absence test.
const ANIMALS: Array<[string, RegExp]> = [
  ['닭', /닭|치킨|鶏肉|鶏脂|鶏ささみ|\bchicken\b|\bpoulet\b/i], ['오리', /오리(?!지[날널]|젠)|\bduck\b/i],
  ['칠면조', /칠면조|\bturkey\b/i], ['소', /소고기|쇠고기|牛肉|\bbeef\b/i],
  ['돼지', /(?<!멧)돼지|\bpork\b/i], ['멧돼지', /멧돼지|\bwild boar\b/i],
  ['양', /양고기|\blamb\b(?!['’]s?\s*quarter)|\bmutton\b/i], ['토끼', /토끼|\brabbit\b/i],
  ['연어', /연어|\bsalmon\b/i], ['참치', /참치|マグロ|\btuna\b/i], ['가다랑어', /가다랑어|カツオ|\bskipjack\b|\bbonito\b/i],
  ['청어', /청어|\bherring\b/i], ['고등어', /고등어|\bmackerel\b/i], ['정어리', /정어리|\bsardines?\b|\bpilchards?\b/i],
  ['대구', /대구|\bcod\b/i], ['폴락', /명태|\bpollock\b/i], ['송어', /송어|\btrout\b/i],
  ['흰살생선', /흰살생선|白身魚|\bwhitefish\b|\bwhite fish\b/i], ['호키', /호키|\bhoki\b/i],
  ['가자미류', /\bsole\b|가자미/i], ['볼락류', /\brockfish\b/i], ['새우', /새우|\bshrimp\b/i],
  ['농어', /농어|\bsea bass\b/i], ['우럭', /우럭/i], ['멘헤이든', /\bmenhaden\b/i],
  ['녹줄매가리', /녹줄매가리/i], ['남방대구', /남방대구/i], ['청대구', /청대구/i], ['청보리멸', /청보리멸/i],
  ['가리비', /가리비|\bscallop/i], ['홍합', /홍합|\bmussel/i], ['오징어', /오징어|\bsquid\b/i],
  ['가금류', /가금(?:류|육)?|禽肉|\bpoultry\b/i], ['육류', /육류|肉類|\bmeat(?:s)?\b/i],
  ['생선', /생선|어류|어육|어분|어유|피쉬|魚介類|魚類|\bfish\b/i],
]
export type IngredientComposition = { protein: string[]; fats: string[]; eggsDairy: string[]; flavor: string[] }

export function splitIngredientText(text: string): string[] {
  const parts: string[] = []; let depth = 0, start = 0
  for (let i = 0; i < text.length; i++) {
    if ('(（['.includes(text[i])) depth++
    else if (')）]'.includes(text[i])) depth = Math.max(0, depth - 1)
    else if (depth === 0 && ',;\n、'.includes(text[i])) { parts.push(text.slice(start, i).trim()); start = i + 1 }
  }
  parts.push(text.slice(start).trim())
  return parts.filter(Boolean)
}
export function ingredientComposition(row: CompareIngredients | null | undefined): IngredientComposition {
  const result: IngredientComposition = { protein: [], fats: [], eggsDairy: [], flavor: [] }
  // Never union a different supplemental Formula into the selected primary source.
  const names = row?.ingredient_names?.length ? row.ingredient_names : splitIngredientText(row?.raw_text ?? '')
  for (const raw of names) {
    let animals = ANIMALS.filter(([,pattern]) => pattern.test(raw)).map(([name]) => name)
    const birds = ['닭','오리','칠면조']
    animals = animals.filter(name => !(name==='육류' && animals.some(x=>x!=='육류')) && !(name==='가금류' && /(가금(?:류|육)?|poultry)\s*[（(]/i.test(raw) && animals.some(x=>birds.includes(x))) && !(name==='생선' && /white\s*fish|흰살\s*생선/i.test(raw)) && !(name==='대구' && /남방대구|청대구/.test(raw)))
    // An animal word in an ingredient's origin note does not establish animal flesh.
    if (/グルテン|gluten|글루텐|lamb['’]s?\s*quarter|may contain|혼입될 수/i.test(raw)) continue
    const flavor = /flavou?r|aroma|향미|천연향|인공향|향료|香料/i.test(raw)
    const fat = /\bfat\b|\boils?\b|지방|오일|어유|기름|鶏脂|油脂|魚油|동물성유|명태유|연어유|치킨유|유지(?:류)?\s*\(/i.test(raw)
    const egg = /\b(?:eggs?|eggshells?)\b|전란|난백|난황|계란|달걀|난각|全卵|卵黄|卵白|卵殻/i.test(raw)
    const dairy = /\bmilk\b(?!\s*thistle)|\bcheese\b|\bwhey\b|우유|치즈|유청/i.test(raw)
    if (flavor) { result.flavor.push(...animals); continue }
    if (egg) { result.eggsDairy.push(/shell|난각|껍질|껍데기|卵殻/i.test(raw) ? '계란 껍데기' : '계란'); continue }
    if (dairy) { result.eggsDairy.push(/cheese|치즈/i.test(raw) ? '치즈' : /whey|유청/i.test(raw) ? '유청' : '우유'); continue }
    if (fat) {
      if (animals.length) result.fats.push(...animals)
      else if (/animal|동물성/i.test(raw)) result.fats.push('동물성 지방')
      continue
    }
    // Fish/poultry/meat remain generic unless a species is actually spelled out.
    if (animals.length) result.protein.push(...animals)
    else if (/동물성\s*(유도)?단백질|\banimal proteins?\b/i.test(raw)) result.protein.push('동물성 단백질')
  }
  for (const key of Object.keys(result) as Array<keyof IngredientComposition>) result[key] = [...new Set(result[key])]
  return result
}
