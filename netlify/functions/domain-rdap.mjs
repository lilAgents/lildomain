// Server-side RDAP lookup for lilDomain. The browser can't follow rdap.org's
// redirects to per-registry RDAP servers (cross-origin, often no CORS), so newer
// TLDs like .xyz would stall. Doing it here sidesteps CORS entirely and works for
// every TLD. Host is fixed to rdap.org and the domain is validated, so there is
// no SSRF surface.

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(obj),
});

export const handler = async (event) => {
  const domain = (event.queryStringParameters && event.queryStringParameters.domain || '').trim().toLowerCase();
  // Conservative label/TLD validation; blocks anything that is not a plain domain.
  if (!domain || domain.length > 253 || !/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
    return json(400, { available: null, error: 'Enter a valid domain.' });
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch('https://rdap.org/domain/' + encodeURIComponent(domain), {
      redirect: 'follow',
      signal: ac.signal,
      headers: { accept: 'application/rdap+json', 'user-agent': 'lilDomain/1.0 (+https://lilagents.com)' },
    });
    // 404 = no registration found (available); 200 = registered; anything else is inconclusive.
    const available = r.status === 404 ? true : r.status === 200 ? false : null;
    return json(200, { available, status: r.status });
  } catch (e) {
    // Timeout or network error: let the client fall back to its DNS signal.
    return json(200, { available: null, status: 0 });
  } finally {
    clearTimeout(timer);
  }
};
