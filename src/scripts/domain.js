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
    try { localStorage.setItem('lildomain-theme', next); } catch (e) {}
    setThemeIcon(btn, next);
  });
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const useP = Math.random() < 0.5;
    const name = useP ? pick(PREFIX) + seed : seed + pick(SUFFIX);
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

/* ---------- availability checks (with timeouts) ---------- */
async function fetchT(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms || 8000);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// true = registered, false = no NS (likely free), null = unknown
async function nsTaken(domain) {
  try {
    const r = await fetchT(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=NS`, {
      headers: { accept: 'application/dns-json' },
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.Status === 3) return false; // NXDOMAIN
    if (j.Status !== 0) return null;
    return (j.Answer || []).some((a) => a.type === 2);
  } catch (e) { return null; }
}
// true = available (404), false = registered (200), null = unknown
async function rdapAvailable(domain) {
  try {
    const r = await fetchT('https://rdap.org/domain/' + encodeURIComponent(domain));
    if (r.status === 404) return true;
    if (r.status === 200) return false;
    return null;
  } catch (e) { return null; }
}

// 'available' | 'taken' | 'unknown' (RDAP is the authority; retry once if hazy)
async function checkDomain(domain) {
  const taken = await nsTaken(domain);
  if (taken === true) return 'taken';
  let avail = await rdapAvailable(domain);
  if (avail === null) { await sleep(350); avail = await rdapAvailable(domain); }
  if (avail === true) return 'available';
  if (avail === false) return 'taken';
  return 'unknown';
}

/* ---------- state + render ---------- */
const state = { mode: 'exact', seen: new Set(), checked: 0, found: 0, running: false };

const selectedTlds = () => {
  const t = $$('#tlds input:checked').map((i) => i.value);
  return t.length ? t : ['.com'];
};
const registerLink = (d) => `https://www.namecheap.com/domains/registration/results/?domain=${encodeURIComponent(d)}`;
const setStatus = (msg) => { $('#status-msg').textContent = msg; };

function addRow(domain, status) {
  const list = $('#dom-list');
  const el = document.createElement('div');
  if (status === 'available') {
    el.className = 'dom-row';
    el.innerHTML = `<span class="dom-name">${esc(domain)}</span>
      <span class="dom-tag">available</span>
      <a class="btn btn--sm dom-reg" href="${registerLink(domain)}" target="_blank">Register</a>`;
  } else {
    el.className = 'dom-row dom-row--muted';
    const tag = status === 'taken'
      ? '<span class="dom-tag dom-tag--taken">taken</span>'
      : '<span class="dom-tag dom-tag--unknown">could not check</span>';
    el.innerHTML = `<span class="dom-name">${esc(domain)}</span>${tag}`;
  }
  list.appendChild(el);
}

/* ---------- run a batch ---------- */
async function runBatch() {
  if (state.running) return;
  state.running = true;
  $('#find-btn').disabled = true;
  $('#more-btn').disabled = true;

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

    setStatus(`Checking ${domains.length} name${domains.length === 1 ? '' : 's'}…`);

    let i = 0, foundThis = 0;
    const POOL = 6;
    const worker = async () => {
      while (i < domains.length) {
        const d = domains[i++];
        const verdict = await checkDomain(d);
        state.checked++;
        if (mode === 'exact') {
          addRow(d, verdict);
          if (verdict === 'available') foundThis++;
          setStatus(`Checked ${state.checked} of ${domains.length}…`);
        } else if (verdict === 'available') {
          state.found++; foundThis++;
          addRow(d, 'available');
          setStatus(`Checked ${state.checked} · found ${state.found} open`);
        } else {
          setStatus(`Checked ${state.checked} · found ${state.found} open`);
        }
      }
    };
    await Promise.all(Array.from({ length: POOL }, worker));

    if (mode === 'exact') {
      setStatus(`${foundThis} of ${domains.length} ending${domains.length === 1 ? '' : 's'} open for "${seed}"`);
    } else if (state.found) {
      setStatus(`Found ${state.found} open name${state.found === 1 ? '' : 's'} from ${state.checked} checked`);
    } else {
      setStatus(`Nothing open in that batch, try Find more`);
    }
  } finally {
    state.running = false;
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
