// lilDomain: find domain names that are genuinely unregistered right now.
// A DNS-over-HTTPS NS lookup rules out registered names cheaply, then an
// RDAP query (404 = available) confirms. Only confirmed names are shown.
// All checks run in the browser.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------- theme (OS-aware, matches the family) ---------- */
const MOON_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';
const SUN_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4l1.4-1.4M18 6l1.4-1.4"/></g></svg>';

function setThemeIcon(btn, theme) {
  if (theme === 'dark') { btn.innerHTML = SUN_SVG; btn.setAttribute('aria-label', 'Switch to light mode'); }
  else { btn.innerHTML = MOON_SVG; btn.setAttribute('aria-label', 'Switch to dark mode'); }
}
function initTheme() {
  const btn = $('#ui-theme-btn');
  const current = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  setThemeIcon(btn, current());
  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('lildomain-theme', next); } catch (e) { /* storage may be unavailable; safe to ignore */ }
    setThemeIcon(btn, next);
  });
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- registrars ---------- */
const REGISTRARS = {
  cloudflare: (d) => `https://domains.cloudflare.com/?domain=${d}`,
  porkbun: (d) => `https://porkbun.com/checkout/search?q=${d}`,
  namecheap: (d) => `https://www.namecheap.com/domains/registration/results/?domain=${d}`,
  dynadot: (d) => `https://www.dynadot.com/domain/search?domain=${d}`,
  spaceship: (d) => `https://www.spaceship.com/domain-search/?query=${d}`,
  godaddy: (d) => `https://www.godaddy.com/domainsearch/find?domainToCheck=${d}`,
};
const registerLink = (d) => (REGISTRARS[state.registrar] || REGISTRARS.cloudflare)(encodeURIComponent(d));

/* ---------- modes ---------- */
const MODE_NOTE = {
  exact: 'Checks the exact word you type on each ending, available or taken.',
  variations: 'Adds prefixes and suffixes to your word, like get-, try-, and -app, -hq.',
  brandable: 'Invents short, pronounceable names. The keyword is ignored in this mode.',
};

/* ---------- candidate generation ---------- */
const CONS = 'bcdfghjklmnprstvz'.split('');
const VOW = 'aeiou'.split('');
const PATTERNS = ['CVCV', 'CVCVC', 'CVVCV', 'CVCCV'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sanitize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function coinWord() {
  let s = '';
  for (const c of pick(PATTERNS)) s += c === 'C' ? pick(CONS) : pick(VOW);
  return s;
}
const PREFIX = ['get', 'try', 'use', 'go', 'my', 'the'];
const SUFFIX = ['hq', 'app', 'ly', 'kit', 'hub', 'base', 'labs', 'flow', 'io', 'ify', 'now'];

function variationBases(seed, seen, count) {
  const out = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 25) {
    const name = Math.random() < 0.5 ? pick(PREFIX) + seed : seed + pick(SUFFIX);
    if (name.length < 3 || name.length > 18 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
function brandBases(seen, count) {
  const out = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 25) {
    const name = coinWord() + (Math.random() < 0.35 ? pick(['', '', 'ly', 'o', 'a']) : '');
    if (name.length < 4 || name.length > 12 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/* ---------- availability checks (timeouts + retries) ---------- */
async function fetchT(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms || 7000);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// 'taken' (has NS) | 'free' (NXDOMAIN, no such domain) | 'unknown'.
// DoH is fast and reliable, so retry it a couple times before giving up.
async function nsStatus(domain) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(250 * attempt);
    try {
      const r = await fetchT(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=NS`, {
        headers: { accept: 'application/dns-json' },
      }, 6000);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.Status === 3) return 'free'; // NXDOMAIN: the name does not exist
      if (j.Status === 0) return (j.Answer || []).some((a) => a.type === 2) ? 'taken' : 'unknown';
    } catch (e) { /* retry */ }
  }
  return 'unknown';
}
// true = available (404), false = registered (200), null = unknown
async function rdapOnce(domain) {
  try {
    // RDAP runs server-side (rdap.org redirects to per-registry hosts the browser
    // can't reach cross-origin), so newer TLDs like .xyz resolve fast.
    const r = await fetchT('/.netlify/functions/domain-rdap?domain=' + encodeURIComponent(domain), undefined, 9000);
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.available === 'boolean' ? j.available : null;
  } catch (e) { return null; }
}
// rdap.org redirects to per-registry servers that can be slow under load,
// so retry a few times with backoff before giving up.
async function rdapAvailable(domain) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(400 * attempt);
    const v = await rdapOnce(domain);
    if (v !== null) return v;
  }
  return null;
}

// 'available' | 'taken' | 'unknown'. RDAP is the authority when it answers,
// but it rate-limits and some registries' servers block cross-origin calls,
// so a clear NXDOMAIN from DNS is the fallback rather than giving up.
async function checkDomain(domain) {
  const ns = await nsStatus(domain);
  if (ns === 'taken') return 'taken';
  const avail = await rdapAvailable(domain);
  if (avail === true) return 'available';
  if (avail === false) return 'taken';
  // RDAP could not confirm: trust a definite "no such domain" from DNS
  if (ns === 'free') return 'available';
  return 'unknown';
}

/* ---------- state ---------- */
const state = { mode: 'exact', registrar: 'cloudflare', seen: new Set(), checked: 0, found: 0, running: false };

const selectedTlds = () => {
  const t = $$('#tlds input:checked').map((i) => i.value);
  return t.length ? t : ['.com'];
};
const setStatus = (msg) => { $('#status-msg').textContent = msg; };
const setBusy = (on) => { $('#busy').hidden = !on; };

/* ---------- rows ---------- */
const SPIN = '<span class="dom-spin" aria-hidden="true"></span>';

function rowMarkup(domain, status) {
  if (status === 'pending') {
    return `<span class="dom-name">${esc(domain)}</span><span class="dom-tag dom-tag--pending">${SPIN} checking</span>`;
  }
  if (status === 'available') {
    return `<span class="dom-name">${esc(domain)}</span>
      <span class="dom-tag">available</span>
      <a class="btn btn--sm dom-reg" data-domain="${esc(domain)}" href="${registerLink(domain)}" target="_blank">Register</a>`;
  }
  const tag = status === 'taken'
    ? '<span class="dom-tag dom-tag--taken">taken</span>'
    : '<span class="dom-tag dom-tag--unknown">could not check</span>';
  return `<span class="dom-name">${esc(domain)}</span>${tag}`;
}

function addRow(domain, status) {
  const list = $('#dom-list');
  const el = document.createElement('div');
  el.className = 'dom-row' + (status === 'available' ? '' : status === 'pending' ? ' dom-row--pending' : ' dom-row--muted');
  el.dataset.domain = domain;
  el.innerHTML = rowMarkup(domain, status);
  list.appendChild(el);
  return el;
}
function updateRow(el, domain, status) {
  el.className = 'dom-row' + (status === 'available' ? '' : ' dom-row--muted');
  el.innerHTML = rowMarkup(domain, status);
}

function updateRegLinks() {
  $$('.dom-reg[data-domain]').forEach((a) => { a.href = registerLink(a.dataset.domain); });
}

/* ---------- run a batch ---------- */
async function runBatch() {
  if (state.running) return;
  state.running = true;
  $('#find-btn').disabled = true;
  $('#more-btn').disabled = true;
  setBusy(true);

  try {
    const seed = sanitize($('#f-seed').value);
    const tlds = selectedTlds();
    const mode = state.mode;
    if (mode !== 'brandable' && !seed) { setStatus('Type a keyword first.'); return; }

    if (!$('#dom-list')) $('#results').innerHTML = '<div class="dom-list" id="dom-list"></div>';

    let bases;
    if (mode === 'exact') bases = [seed];
    else if (mode === 'variations') bases = variationBases(seed, state.seen, 12);
    else bases = brandBases(state.seen, 12);

    const domains = [];
    for (const bse of bases) for (const t of tlds) domains.push(bse + t);

    setStatus(`Checking ${domains.length} name${domains.length === 1 ? '' : 's'}`);

    // Exact mode shows a row per ending up front, each resolving in place.
    const pending = {};
    if (mode === 'exact') for (const d of domains) pending[d] = addRow(d, 'pending');

    let i = 0, foundThis = 0;
    const POOL = 4;
    const worker = async () => {
      while (i < domains.length) {
        const d = domains[i++];
        const verdict = await checkDomain(d);
        state.checked++;
        if (mode === 'exact') {
          updateRow(pending[d], d, verdict);
          if (verdict === 'available') foundThis++;
        } else if (verdict === 'available') {
          state.found++; foundThis++;
          addRow(d, 'available');
        }
        if (mode !== 'exact') setStatus(`Checked ${state.checked} · found ${state.found} open`);
      }
    };
    await Promise.all(Array.from({ length: POOL }, worker));

    if (mode === 'exact') {
      setStatus(`${foundThis} of ${domains.length} ending${domains.length === 1 ? '' : 's'} open for "${seed}"`);
    } else if (state.found) {
      setStatus(`Found ${state.found} open name${state.found === 1 ? '' : 's'} from ${state.checked} checked`);
    } else {
      setStatus('Nothing open in that batch, try Find more');
    }
  } finally {
    state.running = false;
    setBusy(false);
    updateControls();
  }
}

/* ---------- controls ---------- */
function reset() {
  state.seen = new Set();
  state.checked = 0;
  state.found = 0;
  $('#results').innerHTML = '<div class="dom-list" id="dom-list"></div>';
}

function updateControls() {
  const seed = sanitize($('#f-seed').value);
  const needSeed = state.mode !== 'brandable';
  $('#find-btn').disabled = state.running || (needSeed && !seed);
  $('#more-btn').disabled = state.running;
  $('#more-btn').hidden = state.mode === 'exact';
  $('#mode-note').textContent = MODE_NOTE[state.mode];
}

function initDomain() {
  initTheme();

  try {
    const r = localStorage.getItem('lildomain-registrar');
    if (r && REGISTRARS[r]) state.registrar = r;
  } catch (e) { /* storage may be unavailable; safe to ignore */ }
  $('#f-registrar').value = state.registrar;
  $('#f-registrar').addEventListener('change', (e) => {
    state.registrar = e.target.value;
    try { localStorage.setItem('lildomain-registrar', state.registrar); } catch (err) { /* storage may be unavailable; safe to ignore */ }
    updateRegLinks();
  });

  $$('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    $$('[data-mode]').forEach((x) => x.classList.toggle('is-active', x === b));
    updateControls();
  }));

  $('#f-seed').addEventListener('input', updateControls);
  $('#f-seed').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !$('#find-btn').disabled) { reset(); runBatch(); }
  });
  $('#find-btn').addEventListener('click', () => { reset(); runBatch(); });
  $('#more-btn').addEventListener('click', runBatch);

  updateControls();
}

export { initDomain };
