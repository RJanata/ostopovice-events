const USER_AGENT = 'Mozilla/5.0 (compatible; ostopovice-events/0.1; +https://github.com/)';
// Některé weby (Canva) robotům vrátí jen „Unsupported client“ → tam se posílá UA prohlížeče
export const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// Menší hostingy (např. web Klubu seniorů) občas z GitHub Actions nepřijmou spojení
// (z českých adres jde vše hned) a projde to až po chvíli → při chybě sítě zkusit
// znovu, s rostoucí pauzou (celkem až ~50 s navíc, jen když zdroj zlobí).
const RETRY_DELAYS_MS = [5000, 15000, 30000];

// Některé weby ale z GitHubu nepustí ani po minutě (obec 21. 10. 2026 celý den) → nakonec
// se stránka stáhne přes náš server na NASu (česká adresa). Ten stahuje jen weby uvedené
// v config/sources.json. FETCH_RELAY=off zálohu vypne (např. při vývoji).
const RELAY_URL = process.env.FETCH_RELAY ?? 'https://api.craz.cz/ostopovice-events/fetch';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Čitelná příčina chyby sítě (fetch hlásí jen „fetch failed“, podstatné je v cause). */
function describe(err) {
  const cause = err.cause;
  const detail = cause?.code || cause?.message;
  if (err.name === 'TimeoutError') return 'vypršel čas spojení';
  return detail ? `${err.message} (${detail})` : err.message;
}

/** Stažení přes NAS; vrací text, nebo vyhodí výjimku se zprávou (bez opakování, to už proběhlo). */
async function fetchViaRelay(url, timeoutMs) {
  let response;
  try {
    response = await fetch(`${RELAY_URL}?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(timeoutMs * 2) });
  } catch (err) {
    throw new Error(`NAS nedostupný: ${describe(err)}`);
  }
  if (!response.headers.has('x-relay-status')) {
    const detail = await response.json().then((b) => b.error).catch(() => `HTTP ${response.status}`);
    throw new Error(`NAS: ${detail}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} pro ${url} (přes NAS)`);
  return response.text();
}

/**
 * Stáhne URL jako text; při chybě sítě to zkusí znovu, pak přes NAS a teprve potom
 * vyhodí výjimku s čitelnou zprávou.
 */
export async function fetchText(url, { timeoutMs = 30000, userAgent = USER_AGENT } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    let response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': userAgent, 'Accept-Language': 'cs,en;q=0.5' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
    } catch (err) {
      lastError = new Error(`${describe(err)} – ${url}`);
      continue; // chyba sítě → zkusit znovu
    }
    // 5xx = dočasná chyba serveru → zkusit znovu; 4xx (např. 404) je trvalá
    if (response.status >= 500) {
      lastError = new Error(`HTTP ${response.status} pro ${url}`);
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} pro ${url}`);
    return response.text();
  }
  const direct = `${lastError.message} (${RETRY_DELAYS_MS.length + 1} pokusy)`;
  if (!RELAY_URL || RELAY_URL === 'off') throw new Error(direct);
  try {
    const text = await fetchViaRelay(url, timeoutMs);
    console.log(`  ↪ ${new URL(url).hostname}: přímo nešlo, staženo přes NAS`);
    return text;
  } catch (err) {
    throw new Error(`${direct}; ${err.message}`);
  }
}
