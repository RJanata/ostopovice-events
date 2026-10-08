const USER_AGENT = 'Mozilla/5.0 (compatible; ostopovice-events/0.1; +https://github.com/)';

// Menší hostingy (např. web Klubu seniorů) občas z GitHub Actions nepřijmou spojení,
// o chvíli později to projde → při chybě sítě zkusit znovu.
const RETRY_DELAYS_MS = [2000, 5000];

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Čitelná příčina chyby sítě (fetch hlásí jen „fetch failed“, podstatné je v cause). */
function describe(err) {
  const cause = err.cause;
  const detail = cause?.code || cause?.message;
  if (err.name === 'TimeoutError') return 'vypršel čas spojení';
  return detail ? `${err.message} (${detail})` : err.message;
}

/** Stáhne URL jako text; při chybě sítě to zkusí znovu, pak vyhodí výjimku s čitelnou zprávou. */
export async function fetchText(url, { timeoutMs = 30000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    let response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'cs,en;q=0.5' },
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
  throw new Error(`${lastError.message} (${RETRY_DELAYS_MS.length + 1} pokusy)`);
}
