'use strict';
/* Test opterećenja: node test/load-test.js [broj_ucesnika] [adresa] [admin_lozinka]
 * PAŽNJA: briše sve odgovore i učesnike na serveru! Pokretati samo pre konferencije. */
const http = require('http');
const N = Number(process.argv[2] || 300);
const BASE = process.argv[3] || 'http://localhost:3000';
const ADMIN = process.argv[4] || 'promeni-ovu-lozinku';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function j(path, { method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  const d = await r.json().catch(() => null);
  return { status: r.status, d };
}
const adm = (path, body) => j(path, { method: body ? 'POST' : 'GET', body, headers: { 'x-admin-key': ADMIN } });
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
function assert(c, m) { if (!c) { console.error('  ✗ ' + m); process.exitCode = 1; } else console.log('  ✓ ' + m); }

function openStream(onState) {
  return new Promise(resolve => {
    const req = http.get(BASE + '/api/stream', res => {
      let buf = '';
      res.on('data', c => {
        buf += c;
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (block.match(/^event: (.*)$/m) || [])[1];
          const data = (block.match(/^data: (.*)$/m) || [])[1];
          if (ev === 'state') onState(JSON.parse(data));
        }
      });
      resolve(req);
    });
    req.on('error', e => console.error('stream', e.message));
  });
}

(async () => {
  console.log(`Test sa ${N} učesnika na ${BASE}`);
  let r = await adm('/api/admin/action', { action: 'idle' });
  r = await adm('/api/admin/reset', { what: 'all', confirm: 'OBRIŠI' });
  assert(r.status === 200, 'reset baze');
  const cfg = (await j('/api/config')).d;
  const animals = cfg.animals.map(a => a.id);

  // 1) istovremena registracija
  let t0 = Date.now();
  const lat = [];
  const players = await Promise.all(Array.from({ length: N }, async (_, i) => {
    const s = Date.now();
    const res = await j('/api/register', { method: 'POST', body: { animal: animals[i % animals.length], nickname: `Igrač ${i + 1}`, pin: String(1000 + i).slice(-4) } });
    lat.push(Date.now() - s);
    return { i, token: res.d && res.d.token, status: res.status };
  }));
  assert(players.every(p => p.status === 200 && p.token), `${N} istovremenih registracija (${Date.now() - t0} ms ukupno, p95 ${pct(lat, .95)} ms)`);

  // ivični slučajevi prijave
  r = await j('/api/register', { method: 'POST', body: { animal: animals[0], nickname: 'igrac 1', pin: '1234' } });
  assert(r.status === 409, 'zauzeta kombinacija (i bez razlike u velikim slovima/dijakriticima) odbijena: ' + r.d.error);
  r = await j('/api/register', { method: 'POST', body: { animal: animals[0], nickname: 'x', pin: '1234' } });
  assert(r.status === 400, 'prekratak nadimak odbijen');
  r = await j('/api/register', { method: 'POST', body: { animal: animals[0], nickname: 'Novi', pin: '12a4' } });
  assert(r.status === 400, 'neispravan PIN odbijen');
  r = await j('/api/login', { method: 'POST', body: { animal: animals[1], nickname: 'IGRAČ 2', pin: '1001' } });
  assert(r.status === 200 && r.d.token === players[1].token, 'ponovna prijava sa tačnim PIN-om vraća isti nalog');
  for (let k = 0; k < 5; k++) r = await j('/api/login', { method: 'POST', body: { animal: animals[2], nickname: 'Igrač 3', pin: '9999' } });
  r = await j('/api/login', { method: 'POST', body: { animal: animals[2], nickname: 'Igrač 3', pin: '1002' } });
  assert(r.status === 429, 'posle 5 pogrešnih PIN-ova nalog je privremeno zaključan');
  r = await j('/api/login', { method: 'POST', body: { animal: animals[3], nickname: 'Igrač 3', pin: '1002' } });
  assert(r.status === 404, 'pogrešna životinja za postojeći nadimak = ne postoji');

  // 2) 300 SSE veza
  const seen = new Map(); // seq -> broj klijenata koji su primili
  let lastState = null;
  const streams = await Promise.all(Array.from({ length: N }, () => openStream(s => { seen.set(s.phase + s.seq, (seen.get(s.phase + s.seq) || 0) + 1); lastState = s; })));
  await sleep(800);
  const data = (await adm('/api/admin/data')).d;
  assert(data.connected >= N, `${data.connected} otvorenih veza u realnom vremenu`);

  // 3) jedno pitanje, svi odgovaraju
  const ses = data.sessions[0];
  await adm('/api/admin/action', { action: 'openSession', sessionId: ses.id });
  await sleep(300);
  r = await adm('/api/admin/action', { action: 'startQuestion' });
  assert(r.status === 200, 'pokrenuto pitanje');
  await sleep(300);
  const q = lastState.question;
  assert(q && q.correct === undefined, 'tačan odgovor se NE šalje telefonima dok traje pitanje');
  const stQ = [...seen.entries()].find(([k]) => k.startsWith('question'));
  assert(stQ && stQ[1] === N, `svih ${N} klijenata je dobilo pitanje (${stQ && stQ[1]})`);
  const alat = [];
  t0 = Date.now();
  const results = await Promise.all(players.map(async p => {
    await sleep(300 + Math.random() * 6000);
    const s = Date.now();
    const res = await j('/api/answer', { method: 'POST', headers: { 'x-token': p.token }, body: { questionId: q.id, choice: Math.floor(Math.random() * q.options.length) } });
    alat.push(Date.now() - s);
    return res.status;
  }));
  assert(results.every(s => s === 200), `${N} odgovora primljeno (p50 ${pct(alat, .5)} ms, p95 ${pct(alat, .95)} ms, max ${Math.max(...alat)} ms)`);
  r = await j('/api/answer', { method: 'POST', headers: { 'x-token': players[0].token }, body: { questionId: q.id, choice: 0 } });
  assert(r.status === 409, 'drugi odgovor na isto pitanje odbijen');
  r = await j('/api/answer', { method: 'POST', body: { questionId: q.id, choice: 0 } });
  assert(r.status === 401, 'odgovor bez prijave odbijen');

  await adm('/api/admin/action', { action: 'closeQuestion' });
  await sleep(1700);
  r = await j('/api/answer', { method: 'POST', headers: { 'x-token': players[5].token }, body: { questionId: q.id, choice: 0 } });
  assert(r.status === 409, 'odgovor posle isteka vremena odbijen');
  await adm('/api/admin/action', { action: 'reveal' });
  await sleep(400);
  const sum = lastState.counts.reduce((a, b) => a + b, 0);
  assert(sum === N && lastState.question.correct !== undefined, `rešenje: raspodela ${lastState.counts.join('/')} = ${sum}`);

  // 4) svi telefoni traže lične rezultate
  t0 = Date.now();
  const mes = await Promise.all(players.map(p => j('/api/me', { headers: { 'x-token': p.token } })));
  assert(mes.every(m => m.status === 200 && m.d.current.answer && m.d.current.answer.correct !== undefined), `${N} ličnih rezultata za ${Date.now() - t0} ms`);
  const ok = mes.filter(m => m.d.current.answer.correct);
  assert(ok.every(m => m.d.current.answer.points >= 500 && m.d.current.answer.points <= 1000), 'bodovi za tačne odgovore u opsegu 500–1000');

  for (const a of ['board', 'animals', 'stats']) {
    r = await adm('/api/admin/action', { action: a, scope: 'session' });
    await sleep(300);
    assert(r.status === 200 && lastState.phase === a, `prikaz: ${a}`);
  }
  assert(lastState.stats.answers === N, 'statistika broji sve odgovore');
  await adm('/api/admin/action', { action: 'animals', scope: 'session' }); await sleep(300);
  const totalCorrect = lastState.animals.rows.reduce((a, b) => a + b.correct, 0);
  assert(totalCorrect === ok.length, `zbir tačnih po životinjama (${totalCorrect}) = broj tačnih odgovora (${ok.length})`);

  await adm('/api/admin/action', { action: 'endSession' });
  streams.forEach(s => s.destroy());
  const mem = process.memoryUsage().rss;
  console.log(process.exitCode ? '\nNEKI TESTOVI NISU PROŠLI' : '\nSvi testovi su prošli.');
  process.exit();
})();
