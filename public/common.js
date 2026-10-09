/* DMSS kviz — zajedničke funkcije za sve ekrane */
'use strict';
const LETTERS = ['A', 'B', 'C', 'D'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store' });
  } catch (e) {
    const err = new Error('Nema veze sa serverom. Proverite Wi-Fi i pokušajte ponovo.');
    err.status = 0; throw err;
  }
  let data = null;
  try { data = await res.json(); } catch { /* prazno */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Greška ${res.status}`);
    err.status = res.status; err.data = data; throw err;
  }
  return data;
}

/** Povezivanje na tok događaja; EventSource se sam ponovo povezuje. */
function connectStream({ onState, onCount, onStatus }) {
  let es;
  function open() {
    es = new EventSource('/api/stream');
    es.addEventListener('state', e => { onStatus && onStatus(true); onState(JSON.parse(e.data), performance.now()); });
    es.addEventListener('count', e => onCount && onCount(JSON.parse(e.data)));
    es.onerror = () => { onStatus && onStatus(false); };
  }
  open();
  // ako je telefon bio zaključan, osveži odmah po povratku
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && es.readyState === EventSource.CLOSED) open();
  });
  return () => es.close();
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privatni režim */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* */ } },
};

function fmtPct(x) { return (x * 100).toFixed(0) + '%'; }
function fmtDec(x, d = 1) { return Number(x || 0).toLocaleString('sr-Latn-RS', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtNum(n) { return Number(n || 0).toLocaleString('sr-Latn-RS'); }
function shapeHtml(i) { return `<span class="shape shape-${'abcd'[i]}" aria-hidden="true"></span>`; }

/** Odbrojavanje: vraća funkciju koja daje preostale ms na osnovu remainingMs u trenutku prijema. */
function makeDeadline(remainingMs, receivedAt) {
  const end = receivedAt + remainingMs;
  return () => Math.max(0, end - performance.now());
}

function qrSvg(text, { margin = 2, dark = '#14213d', light = '#ffffff' } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), size = n + margin * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin},${r + margin}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR kod: ${esc(text)}"><rect width="100%" height="100%" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}
