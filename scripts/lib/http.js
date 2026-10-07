const USER_AGENT = 'Mozilla/5.0 (compatible; ostopovice-events/0.1; +https://github.com/)';

/** Stáhne URL jako text; při chybě vyhodí výjimku s čitelnou zprávou. */
export async function fetchText(url, { timeoutMs = 30000 } = {}) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'cs,en;q=0.5' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} pro ${url}`);
  return response.text();
}
