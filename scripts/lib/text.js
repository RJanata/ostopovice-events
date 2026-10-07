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
