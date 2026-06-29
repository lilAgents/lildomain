// lilDomain: generate candidate names and surface the ones that are
// genuinely unregistered right now. A DNS-over-HTTPS NS lookup rules out
// registered names cheaply, then an RDAP query (404 = available) confirms.
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

/* ---------- candidate generation ---------- */
const CONS = 'bcdfghjklmnprstvz'.split('');
const VOW = 'aeiou'.split('');
const PATTERNS = ['CVCV', 'CVCVC', 'CVVCV', 'CVCCV'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function coinWord() {
  const pat = pick(PATTERNS);
  let s = '';
  for (const c of pat) s += c === 'C' ? pick(CONS) : pick(VOW);
  return s;
}

const AFFIX = [
  (s) => s, (s) => 'get' + s, (s) => 'try' + s, (s) => 'use' + s, (s) => 'go' + s, (s) => 'my' + s,
  (s) => s + 'hq', (s) => s + 'app', (s) => s + 'ly', (s) => s + 'kit', (s) => s + 'hub',
  (s) => s + 'base', (s) => s + 'labs', (s) => s + 'flow', (s) => s + 'io', (s) => s + 'ify',
];

const sanitize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// build a batch of distinct base names that we have not tried yet
function generateBases(seed, style, seen, count) {
  const bases = [];
  let guard = 0;
  while (bases.length < count && guard++ < count * 20) {
    let name;
    if (style === 'mix' && seed) {
      name = sanitize(AFFIX[Math.floor(Math.random() * AFFIX.length)](seed));
    } else if (style === 'mix' && !seed) {
      name = coinWord() + pick(['', '', 'ly', 'hq', 'app']);
    } else {
      name = coinWord() + (Math.random() < 0.4 ? coinWord().slice(0, 2) : '');
    }
    if (name.length < 3 || name.length > 18) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    bases.push(name);
  }
  return bases;
}

/* ---------- availability checks ---------- */
// true = registered, false = no NS (likely free), null = unknown
async function nsTaken(domain) {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=NS`, {
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
    const r = await fetch('https://rdap.org/domain/' + encodeURIComponent(domain));
    if (r.status === 404) return true;
    if (r.status === 200) return false;
    return null;
  } catch (e) { return null; }
}

// returns 'available' | 'taken' | 'unknown'
async function checkDomain(domain) {
  const taken = await nsTaken(domain);
  if (taken === true) return 'taken';
  const avail = await rdapAvailable(domain);
  if (avail === true) return 'available';
  if (avail === false) return 'taken';
  // RDAP inconclusive: trust a clear NXDOMAIN as likely free, else unknown
  return taken === false ? 'likely' : 'unknown';
}

/* ---------- run a batch with a small concurrency pool ---------- */
const state = { style: 'mix', seen: new Set(), checked: 0, found: 0, running: false };

function selectedTlds() {
  const t = $$('#tlds input:checked').map((i) => i.value);
  return t.length ? t : ['.com'];
}

function registerLink(domain) {
  return `https://www.namecheap.com/domains/registration/results/?domain=${encodeURIComponent(domain)}`;
}

function addResult(domain, likely) {
  const list = $('#dom-list');
  const el = document.createElement('div');
  el.className = 'dom-row';
  el.innerHTML = `<span class="dom-name">${esc(domain)}</span>
    <span class="dom-tag${likely ? ' dom-tag--likely' : ''}">${likely ? 'likely free' : 'available'}</span>
    <a class="btn btn--sm dom-reg" href="${registerLink(domain)}" target="_blank">Register</a>`;
  list.appendChild(el);
}

function setStatus(msg) { $('#status-msg').textContent = msg; }

async function runBatch() {
  if (state.running) return;
  state.running = true;
  $('#find-btn').disabled = true;
  $('#more-btn').disabled = true;

  const seed = sanitize($('#f-seed').value);
  const tlds = selectedTlds();

  if (!$('#dom-list')) {
    $('#results').innerHTML = '<div class="dom-list" id="dom-list"></div>';
  }

  const bases = generateBases(seed, state.style, state.seen, 14);
  const domains = [];
  for (const b of bases) for (const t of tlds) domains.push(b + t);

  setStatus(`Checking ${domains.length} candidates…`);

  let i = 0;
  const POOL = 6;
  const worker = async () => {
    while (i < domains.length) {
      const d = domains[i++];
      const verdict = await checkDomain(d);
      state.checked++;
      if (verdict === 'available' || verdict === 'likely') {
        state.found++;
        addResult(d, verdict === 'likely');
      }
      setStatus(`Checked ${state.checked} · found ${state.found} open`);
    }
  };
  await Promise.all(Array.from({ length: POOL }, worker));

  if (!state.found) {
    setStatus(`Checked ${state.checked} · nothing open yet, try Find more`);
  } else {
    setStatus(`Found ${state.found} open name${state.found === 1 ? '' : 's'} from ${state.checked} checked`);
  }
  state.running = false;
  $('#find-btn').disabled = false;
  $('#more-btn').disabled = false;
}

/* ---------- wire-up ---------- */
function reset() {
  state.seen = new Set();
  state.checked = 0;
  state.found = 0;
  $('#results').innerHTML = '<div class="dom-list" id="dom-list"></div>';
}

function initDomain() {
  initTheme();

  $$('[data-style]').forEach((b) => b.addEventListener('click', () => {
    state.style = b.dataset.style;
    $$('[data-style]').forEach((x) => x.classList.toggle('is-active', x === b));
  }));

  $('#find-btn').addEventListener('click', () => { reset(); runBatch(); });
  $('#more-btn').addEventListener('click', runBatch);

  // let Enter in the keyword field start a search
  $('#f-seed').addEventListener('keydown', (e) => { if (e.key === 'Enter') { reset(); runBatch(); } });
}

export { initDomain };
