import { normalize } from './text.js';

export const FALLBACK_CATEGORY = 'ostatni';

/** Připraví pravidla z config/categories.json (regexy jednou zkompilované). */
export function buildRules(categoriesConfig) {
  return categoriesConfig.categories
    .filter((c) => c.keywords?.length)
    .map((c) => ({ id: c.id, patterns: c.keywords.map((k) => new RegExp(k, 'i')) }));
}

/**
 * Kategorie akce:
 *   1. pevné kategorie zdroje (source.categories)
 *   1b. štítky v popisu akce (#deti…) — když jsou, pravidla se nepoužijí
 *   2. pravidla podle klíčových slov v názvu a popisu (pokud zdroj nemá skipRules)
 *   3. když nic nesedí: source.fallbackCategories, jinak „Ostatní“
 */
export function categorize(event, source, rules) {
  if (source.display === 'dayLabel') return []; // svátky nejsou akce, jen popisek dne
  const result = new Set(source.categories || []);
  // kategorie zapsané v popisu (#deti apod.) mají přednost před pravidly
  if (event.tagCategories?.length) return [...new Set([...result, ...event.tagCategories])];
  if (!source.skipRules) {
    const text = normalize(`${event.title}\n${event.description || ''}`);
    for (const rule of rules) {
      if (rule.patterns.some((p) => p.test(text))) result.add(rule.id);
    }
  }
  if (!result.size) for (const c of source.fallbackCategories || []) result.add(c);
  if (!result.size) result.add(FALLBACK_CATEGORY);
  return [...result];
}

const compact = (text) => normalize(text).replace(/[^a-z0-9]/g, '');

/** Mapa štítků → id kategorie: "#sport", "#deti", "#prodeti", "#pro-deti", "#Vzdělávání"… */
export function buildTagMap(categoriesConfig) {
  const map = new Map();
  for (const c of categoriesConfig.categories) {
    map.set(compact(c.id), c.id);
    map.set(compact(c.label), c.id);
    for (const alias of c.tags || []) map.set(compact(alias), c.id);
  }
  return map;
}

/**
 * Kategorie zapsané přímo v popisu akce — hlavně pro vlastní Google kalendáře
 * (iCal neumí přenést barvu ani štítky). Podporuje:
 *   #deti #kultura                  (kdekoliv v textu)
 *   Kategorie: Pro děti, Kultura    (samostatný řádek)
 * Rozpoznané štítky se z popisu odstraní, aby na webu nestrašily.
 */
export function extractTags(description, tagMap) {
  const found = new Set();
  let text = String(description || '');
  // [^\S\n] = jakákoli mezera kromě konce řádku (Google Kalendář vkládá i nezlomitelné mezery)
  text = text.replace(/^[^\S\n]*kategorie[^\S\n]*:[^\S\n]*(.+)$/gim, (line, list) => {
    const ids = list.split(/[,;]/).map((part) => tagMap.get(compact(part))).filter(Boolean);
    ids.forEach((id) => found.add(id));
    return ids.length ? '' : line;
  });
  // štítek může mít i dvě slova („#pro děti“) — nejdřív zkusit obě, pak jen první
  text = text.replace(/(^|\s)#([\p{L}\p{N}_-]+)(?:[^\S\n]+([\p{L}\p{N}_-]+))?/gu, (match, space, first, second) => {
    if (second && tagMap.has(compact(first + second))) {
      found.add(tagMap.get(compact(first + second)));
      return space;
    }
    const id = tagMap.get(compact(first));
    if (!id) return match;
    found.add(id);
    return second ? `${space}${match.slice(match.indexOf(second))}` : space;
  });
  return { categories: [...found], description: text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() };
}
