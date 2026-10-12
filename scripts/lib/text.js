import * as cheerio from 'cheerio';

/** Malá písmena bez diakritiky — pro porovnávání a klíčová slova. */
export function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** HTML → prostý text (zachová odstavce jako nové řádky). */
export function htmlToText(html) {
  if (!html) return '';
  const $ = cheerio.load(`<div id="root">${html}</div>`);
  $('br').replaceWith('\n');
  $('p, div, li, h1, h2, h3, h4').each((_, el) => { $(el).append('\n'); });
  return $('#root').text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

// krátká slova, která ve VERZÁLKÁCH nejsou zkratky („DOŽÍNKY VE STODOLE“)
const SHORT_WORDS = new Set(['ve', 'na', 'do', 'za', 'po', 'od', 'ke', 'ze', 'se', 'či', 'pro', 'pod', 'nad', 'bez', 'při', 'aneb']);

/**
 * Úvodní slova psaná VERZÁLKAMI → běžný text: „PLES SENIORŮ“ → „Ples seniorů“,
 * „OSLAVA MDŽ S HUDBOU“ → „Oslava MDŽ s hudbou“ (krátké zkratky 2–3 písmena zůstávají).
 */
export function tidyTitle(text) {
  const title = text.replace(/^[-–]\s*/, '').replace(/[,;]\s*$/, '').trim();
  const words = title.split(/\s+/);
  let index = 0;
  const out = [];
  for (const word of words) {
    const letters = word.replace(/[^\p{L}]/gu, '');
    const isUpper = letters && letters === letters.toLocaleUpperCase('cs') && letters !== letters.toLocaleLowerCase('cs');
    if (!isUpper || index !== out.length) {
      out.push(word);
      continue;
    }
    index += 1;
    const keepAcronym = letters.length >= 2 && letters.length <= 3 && !SHORT_WORDS.has(letters.toLocaleLowerCase('cs'));
    out.push(keepAcronym ? word : word.toLocaleLowerCase('cs'));
  }
  const result = out.join(' ');
  return result.charAt(0).toLocaleUpperCase('cs') + result.slice(1);
}

/** Zkrátí text na rozumnou délku pro kartu akce. */
export function truncate(text, max = 600) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

/** Krátký stabilní hash pro ID akcí. */
export function shortHash(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
