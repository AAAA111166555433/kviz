'use strict';
/*
 * DMSS kviz — server
 * Node.js >= 22.13 (koristi ugrađeni node:sqlite, bez npm zavisnosti)
 * Pokretanje:  node server.js     (ili: npm start)
 */
const VERSION = '1.3.0';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- config
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const PORT = Number(process.env.PORT || config.port || 3000);
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || config.adminPassword || '');
const SCORE_MAX = Number(config.scoring?.max ?? 1000);
const SCORE_MIN = Number(config.scoring?.min ?? 500);
const DEFAULT_LIMIT = Number(config.defaultTimeLimit || 20);
const ANIMALS = config.animals;
const ANIMAL_IDS = new Set(ANIMALS.map(a => a.id));
const GRACE_MS = 1500; // tolerancija mreže posle isteka vremena

if (!ADMIN_PASSWORD || ADMIN_PASSWORD === 'promeni-ovu-lozinku') {
  console.warn('\n  UPOZORENJE: promenite "adminPassword" u config.json pre konferencije!\n');
}

// ---------------------------------------------------------------- database
const db = new DatabaseSync(path.join(DATA_DIR, 'kviz.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY,
  animal TEXT NOT NULL,
  nickname TEXT NOT NULL,
  nick_key TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (animal, nick_key)
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  options TEXT NOT NULL,
  correct INTEGER NOT NULL,
  time_limit INTEGER NOT NULL DEFAULT 20
);
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL,
  choice INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  points INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (participant_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_answers_q ON answers(question_id);
CREATE INDEX IF NOT EXISTS idx_answers_s ON answers(session_id);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const nowIso = () => new Date().toISOString();

function seedQuestionsIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  if (n > 0) return;
  const file = path.join(ROOT, 'questions.json');
  if (!fs.existsSync(file)) return;
  try {
    importQuestions(JSON.parse(fs.readFileSync(file, 'utf8')));
    console.log('  Učitana pitanja iz questions.json');
  } catch (e) {
    console.error('  Greška u questions.json:', e.message);
  }
}

function letterToIndex(c, len) {
  if (typeof c === 'number') return c;
  const s = String(c || '').trim().toUpperCase();
  const i = 'ABCDEF'.indexOf(s);
  if (i < 0 || i >= len) throw new Error(`Neispravan tačan odgovor "${c}"`);
  return i;
}

function validateQuestion(q) {
  const text = String(q.text || '').trim();
  const options = (q.options || []).map(o => String(o).trim()).filter(Boolean);
  if (!text) throw new Error('Pitanje nema tekst');
  if (options.length < 2 || options.length > 4) throw new Error(`Pitanje "${text.slice(0, 40)}" mora imati 2-4 ponuđena odgovora`);
  const correct = letterToIndex(q.correct, options.length);
  if (correct < 0 || correct >= options.length) throw new Error(`Pitanje "${text.slice(0, 40)}": neispravan tačan odgovor`);
  const timeLimit = Math.max(5, Math.min(120, Number(q.timeLimit || q.time_limit || DEFAULT_LIMIT)));
  return { text, options, correct, timeLimit };
}

function importQuestions(data) {
  const sessions = data.sessions || [];
  // validacija pre bilo kakve izmene
  const clean = sessions.map((s, i) => ({
    name: String(s.name || `Sesija ${i + 1}`).trim(),
    questions: (s.questions || []).map(validateQuestion),
  }));
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM answers; DELETE FROM questions; DELETE FROM sessions;');
    const insS = db.prepare('INSERT INTO sessions (name, ord) VALUES (?, ?)');
    const insQ = db.prepare('INSERT INTO questions (session_id, ord, text, options, correct, time_limit) VALUES (?,?,?,?,?,?)');
    clean.forEach((s, i) => {
      const sid = insS.run(s.name, i + 1).lastInsertRowid;
      s.questions.forEach((q, j) => insQ.run(sid, j + 1, q.text, JSON.stringify(q.options), q.correct, q.timeLimit));
    });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  resetGame();
  bumpRank();
}

function exportQuestions() {
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY ord, id').all();
  return {
    sessions: sessions.map(s => ({
      name: s.name,
      questions: db.prepare('SELECT * FROM questions WHERE session_id = ? ORDER BY ord, id').all(s.id).map(q => ({
        text: q.text, options: JSON.parse(q.options), correct: 'ABCD'[q.correct], timeLimit: q.time_limit,
      })),
    })),
  };
}

// ---------------------------------------------------------------- helpers
function nickKey(s) {
  return String(s).toLowerCase().replace(/đ/g, 'dj').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim();
}
const NICK_RE = /^[\p{L}\p{N} ._\-]{2,20}$/u;
// asinhrono (thread pool), da 300 istovremenih prijava ne blokira server
const scryptAsync = require('util').promisify(crypto.scrypt);
async function hashPin(pin, salt) { return (await scryptAsync(String(pin), salt, 32, { N: 4096 })).toString('hex'); }
function newToken() { return crypto.randomBytes(24).toString('base64url'); }
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function animalOf(id) { return ANIMALS.find(a => a.id === id) || { id, name: id, emoji: '❔' }; }
function pub(p) { return { id: p.id, animal: p.animal, nickname: p.nickname }; }

// ---------------------------------------------------------------- game state
/*
 * phase: idle | lobby | question | closed | reveal | board | animals | stats
 * scope (board/animals/stats): 'session' | 'all'
 */
let game = loadGame();
let questionTimer = null;

function loadGame() {
  const row = db.prepare("SELECT value FROM kv WHERE key = 'game'").get();
  const g = row ? JSON.parse(row.value) : null;
  return g || { phase: 'idle', sessionId: null, questionId: null, startedAt: 0, endsAt: 0, scope: 'session', seq: 0 };
}
function saveGame() {
  db.prepare("INSERT INTO kv (key, value) VALUES ('game', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(game));
}
function resetGame() {
  clearTimeout(questionTimer);
  game = { phase: 'idle', sessionId: null, questionId: null, startedAt: 0, endsAt: 0, scope: 'session', seq: (game?.seq || 0) + 1 };
  saveGame();
  broadcastState();
}
function setPhase(patch) {
  game = { ...game, ...patch, seq: (game.seq || 0) + 1 };
  saveGame();
  broadcastState();
}
function armTimer() {
  clearTimeout(questionTimer);
  if (game.phase !== 'question') return;
  const wait = Math.max(0, game.endsAt - Date.now());
  const qid = game.questionId;
  questionTimer = setTimeout(() => {
    if (game.phase === 'question' && game.questionId === qid) setPhase({ phase: 'closed' });
  }, wait + 300);
}
// oporavak posle restarta servera
if (game.phase === 'question') {
  if (Date.now() > game.endsAt) { game.phase = 'closed'; saveGame(); } else armTimer();
}

const getQuestion = id => db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
const getSession = id => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);

function questionPublic(q, withCorrect) {
  if (!q) return null;
  const total = db.prepare('SELECT COUNT(*) AS n FROM questions WHERE session_id = ?').get(q.session_id).n;
  const index = db.prepare('SELECT COUNT(*) AS n FROM questions WHERE session_id = ? AND (ord < ? OR (ord = ? AND id <= ?))')
    .get(q.session_id, q.ord, q.ord, q.id).n;
  const o = { id: q.id, text: q.text, options: JSON.parse(q.options), timeLimit: q.time_limit, index, total };
  if (withCorrect) o.correct = q.correct;
  return o;
}

function answerCounts(qid, nOptions) {
  const counts = Array(nOptions).fill(0);
  for (const r of db.prepare('SELECT choice, COUNT(*) AS n FROM answers WHERE question_id = ? GROUP BY choice').all(qid)) {
    if (r.choice >= 0 && r.choice < nOptions) counts[r.choice] = r.n;
  }
  return counts;
}

// ---------------------------------------------------------------- rankings (keširano)
let rankVersion = 0;
const rankCache = new Map();
function bumpRank() { rankVersion++; rankCache.clear(); }

function ranking(scope, sessionId) {
  const key = `${scope}:${sessionId || 0}:${rankVersion}`;
  if (rankCache.has(key)) return rankCache.get(key);
  const where = scope === 'session' && sessionId ? 'AND a.session_id = ?' : '';
  const params = scope === 'session' && sessionId ? [sessionId] : [];
  const rows = db.prepare(`
    SELECT p.id, p.animal, p.nickname,
           COALESCE(SUM(a.points),0) AS points,
           COALESCE(SUM(a.correct),0) AS correct,
           COUNT(a.id) AS answered,
           COALESCE(SUM(CASE WHEN a.correct = 1 THEN a.ms ELSE 0 END),0) AS ms
    FROM participants p JOIN answers a ON a.participant_id = p.id ${where}
    WHERE p.disabled = 0
    GROUP BY p.id
    ORDER BY points DESC, correct DESC, ms ASC, p.id ASC`).all(...params);
  rows.forEach((r, i) => { r.rank = i + 1; });
  const byId = new Map(rows.map(r => [r.id, r]));
  const res = { rows, byId };
  rankCache.set(key, res);
  return res;
}

function animalRanking(scope, sessionId) {
  const where = scope === 'session' && sessionId ? 'AND a.session_id = ?' : '';
  const params = scope === 'session' && sessionId ? [sessionId] : [];
  const rows = db.prepare(`
    SELECT p.animal,
           COUNT(DISTINCT p.id) AS players,
           COUNT(a.id) AS answers,
           COALESCE(SUM(a.correct),0) AS correct,
           COALESCE(SUM(a.points),0) AS points
    FROM participants p JOIN answers a ON a.participant_id = p.id ${where}
    WHERE p.disabled = 0
    GROUP BY p.animal`).all(...params);
  const map = new Map(rows.map(r => [r.animal, r]));
  const out = ANIMALS.map(a => {
    const r = map.get(a.id) || { players: 0, answers: 0, correct: 0, points: 0 };
    return {
      animal: a.id, name: a.name, emoji: a.emoji,
      players: r.players, answers: r.answers, correct: r.correct, points: r.points,
      avgCorrect: r.players ? r.correct / r.players : 0,
      accuracy: r.answers ? r.correct / r.answers : 0,
    };
  });
  const by = config.animalRankBy === 'average' ? 'avgCorrect' : 'correct';
  out.sort((x, y) => (y[by] - x[by]) || (y.accuracy - x.accuracy) || (y.players - x.players));
  // isti rezultat = isto mesto (1, 2, 2, 4…)
  out.forEach((r, i) => { r.rank = i > 0 && r[by] === out[i - 1][by] ? out[i - 1].rank : i + 1; });
  return { rankBy: by, rows: out };
}

function statsSummary(scope, sessionId) {
  const where = scope === 'session' && sessionId ? 'WHERE a.session_id = ?' : '';
  const params = scope === 'session' && sessionId ? [sessionId] : [];
  const tot = db.prepare(`SELECT COUNT(*) AS answers, COALESCE(SUM(correct),0) AS correct,
      COUNT(DISTINCT participant_id) AS players FROM answers a ${where}`).get(...params);
  const perQ = db.prepare(`SELECT q.id, q.text, s.name AS session, COUNT(a.id) AS n, COALESCE(SUM(a.correct),0) AS c,
      AVG(CASE WHEN a.correct = 1 THEN a.ms END) AS avgMs
      FROM questions q JOIN sessions s ON s.id = q.session_id JOIN answers a ON a.question_id = q.id ${where}
      GROUP BY q.id HAVING n > 0`).all(...params)
    .map(r => ({ ...r, rate: r.c / r.n }));
  perQ.sort((a, b) => a.rate - b.rate);
  const fastest = db.prepare(`SELECT a.ms, p.animal, p.nickname, q.text FROM answers a
      JOIN participants p ON p.id = a.participant_id JOIN questions q ON q.id = a.question_id
      ${where ? where + ' AND' : 'WHERE'} a.correct = 1 AND p.disabled = 0 ORDER BY a.ms ASC LIMIT 1`).get(...params);
  const registered = db.prepare('SELECT COUNT(*) AS n FROM participants WHERE disabled = 0').get().n;
  const popular = db.prepare(`SELECT animal, COUNT(*) AS n FROM participants WHERE disabled = 0 GROUP BY animal ORDER BY n DESC LIMIT 1`).get();
  return {
    registered, players: tot.players, answers: tot.answers, correct: tot.correct,
    accuracy: tot.answers ? tot.correct / tot.answers : 0,
    hardest: perQ[0] || null,
    easiest: perQ.length > 1 ? perQ[perQ.length - 1] : null,
    fastest: fastest || null,
    popularAnimal: popular ? { ...animalOf(popular.animal), n: popular.n } : null,
  };
}

// ---------------------------------------------------------------- public state
function publicState() {
  const s = game.sessionId ? getSession(game.sessionId) : null;
  const st = {
    v: VERSION, seq: game.seq, phase: game.phase, scope: game.scope,
    serverNow: Date.now(),
    session: s ? { id: s.id, name: s.name } : null,
    registered: db.prepare('SELECT COUNT(*) AS n FROM participants WHERE disabled = 0').get().n,
  };
  if (game.questionId && ['question', 'closed', 'reveal'].includes(game.phase)) {
    const q = getQuestion(game.questionId);
    if (q) {
      st.question = questionPublic(q, game.phase === 'reveal');
      st.question.remainingMs = game.phase === 'question' ? Math.max(0, game.endsAt - Date.now()) : 0;
      st.answered = db.prepare('SELECT COUNT(*) AS n FROM answers WHERE question_id = ?').get(q.id).n;
      if (game.phase !== 'question') st.counts = answerCounts(q.id, st.question.options.length);
    }
  }
  if (game.phase === 'board') st.board = ranking(game.scope, game.sessionId).rows.slice(0, 10).map(r => ({ ...r }));
  if (game.phase === 'animals') st.animals = animalRanking(game.scope, game.sessionId);
  if (game.phase === 'stats') st.stats = statsSummary(game.scope, game.sessionId);
  if (game.phase === 'idle' || game.phase === 'lobby') {
    st.recent = db.prepare('SELECT animal, nickname FROM participants WHERE disabled = 0 ORDER BY id DESC LIMIT 12').all();
  }
  return st;
}

// ---------------------------------------------------------------- SSE
const clients = new Set();
let cachedStateJson = null;
function broadcastState() {
  cachedStateJson = JSON.stringify(publicState());
  const msg = `event: state\ndata: ${cachedStateJson}\n\n`;
  for (const c of clients) c.write(msg);
}
let stateTimer = null;
function scheduleStateBroadcast() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => { stateTimer = null; broadcastState(); }, 1000);
}
let countTimer = null;
function scheduleCountBroadcast() {
  if (countTimer) return;
  countTimer = setTimeout(() => {
    countTimer = null;
    if (game.phase !== 'question') return;
    const n = db.prepare('SELECT COUNT(*) AS n FROM answers WHERE question_id = ?').get(game.questionId).n;
    const msg = `event: count\ndata: ${JSON.stringify({ questionId: game.questionId, answered: n })}\n\n`;
    for (const c of clients) c.write(msg);
  }, 400);
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000).unref();

function handleStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

// ---------------------------------------------------------------- login rate limit
const failures = new Map(); // participantId -> { n, until }
function isLocked(pid) {
  const f = failures.get(pid);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function noteFailure(pid) {
  const f = failures.get(pid) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; }
  failures.set(pid, f);
}

// ---------------------------------------------------------------- HTTP utils
function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}
const fail = (res, code, msg, extra = {}) => send(res, code, { error: msg, ...extra });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 2_000_000) { reject(new Error('Prevelik zahtev')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Neispravan JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/ekran') pathname = '/screen.html';
  if (pathname === '/admin') pathname = '/admin.html';
  const file = path.normalize(path.join(PUBLIC, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC + path.sep)) return fail(res, 403, 'Zabranjeno');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, 'Nije pronađeno');
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function participantFromReq(req) {
  const t = req.headers['x-token'];
  if (!t) return null;
  return db.prepare('SELECT * FROM participants WHERE token = ?').get(String(t)) || null;
}

function joinUrl(req) {
  if (config.publicUrl) return config.publicUrl.replace(/\/?$/, '/');
  const host = String(req.headers.host || '');
  // ako je ekran otvoren preko localhost-a, QR mora da pokazuje adresu u lokalnoj mreži
  if (!host || /^(localhost|127\.|\[::1\])/.test(host)) return lanUrls()[0] || `http://localhost:${PORT}/`;
  return `http://${host}/`;
}

function csv(rows, cols) {
  const esc = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(';'), ...rows.map(r => cols.map(c => esc(r[c])).join(';'))].join('\r\n');
}

// ---------------------------------------------------------------- participant API
async function apiRegister(req, res) {
  const b = await readBody(req);
  const animal = String(b.animal || '');
  const nickname = String(b.nickname || '').replace(/\s+/g, ' ').trim();
  const pin = String(b.pin || '');
  if (!ANIMAL_IDS.has(animal)) return fail(res, 400, 'Izaberite životinju.');
  if (!NICK_RE.test(nickname)) return fail(res, 400, 'Nadimak mora imati 2-20 znakova (slova, brojevi, razmak, tačka, crtica).');
  if (!/^\d{4}$/.test(pin)) return fail(res, 400, 'PIN mora imati tačno 4 cifre.');
  const key = nickKey(nickname);
  if (db.prepare('SELECT 1 FROM participants WHERE animal = ? AND nick_key = ?').get(animal, key)) {
    return fail(res, 409, 'Ova kombinacija životinje i nadimka je zauzeta. Ako ste to vi, izaberite „Već imam nalog”.', { code: 'taken' });
  }
  const salt = crypto.randomBytes(12).toString('hex');
  const token = newToken();
  const pinHash = await hashPin(pin, salt);
  try {
    const id = db.prepare(`INSERT INTO participants (animal, nickname, nick_key, pin_salt, pin_hash, token, created_at)
      VALUES (?,?,?,?,?,?,?)`).run(animal, nickname, key, salt, pinHash, token, nowIso()).lastInsertRowid;
    send(res, 200, { token, participant: { id: Number(id), animal, nickname } });
    scheduleStateBroadcast();
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return fail(res, 409, 'Ova kombinacija je upravo zauzeta.', { code: 'taken' });
    throw e;
  }
}

async function apiLogin(req, res) {
  const b = await readBody(req);
  const animal = String(b.animal || '');
  const key = nickKey(String(b.nickname || ''));
  const pin = String(b.pin || '');
  const p = db.prepare('SELECT * FROM participants WHERE animal = ? AND nick_key = ?').get(animal, key);
  if (!p) return fail(res, 404, 'Ne postoji učesnik sa ovom životinjom i nadimkom.');
  const wait = isLocked(p.id);
  if (wait) return fail(res, 429, `Previše pokušaja. Sačekajte ${wait} s ili se obratite organizatoru.`);
  if (!safeEq(await hashPin(pin, p.pin_salt), p.pin_hash)) {
    noteFailure(p.id);
    return fail(res, 401, 'Pogrešan PIN.');
  }
  failures.delete(p.id);
  if (p.disabled) return fail(res, 403, 'Nalog je deaktiviran. Obratite se organizatoru.');
  send(res, 200, { token: p.token, participant: pub(p) });
}

function apiCheck(req, res, url) {
  const animal = url.searchParams.get('animal') || '';
  const key = nickKey(url.searchParams.get('nickname') || '');
  const taken = !!db.prepare('SELECT 1 FROM participants WHERE animal = ? AND nick_key = ?').get(animal, key);
  send(res, 200, { taken });
}

function apiMe(req, res) {
  const p = participantFromReq(req);
  if (!p) return fail(res, 401, 'Niste prijavljeni.');
  const all = ranking('all').byId.get(p.id);
  const ses = game.sessionId ? ranking('session', game.sessionId).byId.get(p.id) : null;
  const out = {
    participant: pub(p), disabled: !!p.disabled,
    total: all ? { points: all.points, correct: all.correct, answered: all.answered, rank: all.rank, of: ranking('all').rows.length } : null,
    session: ses ? { points: ses.points, correct: ses.correct, answered: ses.answered, rank: ses.rank, of: ranking('session', game.sessionId).rows.length } : null,
  };
  if (game.questionId) {
    const a = db.prepare('SELECT choice, correct, points, ms FROM answers WHERE participant_id = ? AND question_id = ?').get(p.id, game.questionId);
    out.current = { questionId: game.questionId, answer: a || null };
    if (a && game.phase !== 'reveal') { delete out.current.answer.correct; delete out.current.answer.points; }
  }
  send(res, 200, out);
}

async function apiAnswer(req, res) {
  const p = participantFromReq(req);
  if (!p) return fail(res, 401, 'Niste prijavljeni.');
  if (p.disabled) return fail(res, 403, 'Nalog je deaktiviran.');
  const b = await readBody(req);
  const now = Date.now();
  if (game.phase !== 'question' && !(game.phase === 'closed' && now <= game.endsAt + GRACE_MS)) {
    return fail(res, 409, 'Pitanje nije otvoreno.');
  }
  if (Number(b.questionId) !== game.questionId) return fail(res, 409, 'Ovo pitanje više nije aktivno.');
  if (now > game.endsAt + GRACE_MS) return fail(res, 409, 'Vreme je isteklo.');
  const q = getQuestion(game.questionId);
  const options = JSON.parse(q.options);
  const choice = Number(b.choice);
  if (!Number.isInteger(choice) || choice < 0 || choice >= options.length) return fail(res, 400, 'Neispravan odgovor.');
  const limitMs = q.time_limit * 1000;
  const ms = Math.max(0, Math.min(limitMs, now - game.startedAt));
  const correct = choice === q.correct ? 1 : 0;
  const points = correct ? Math.round(SCORE_MAX - (SCORE_MAX - SCORE_MIN) * (ms / limitMs)) : 0;
  try {
    db.prepare(`INSERT INTO answers (participant_id, question_id, session_id, choice, correct, points, ms, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(p.id, q.id, q.session_id, choice, correct, points, ms, nowIso());
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return fail(res, 409, 'Već ste odgovorili na ovo pitanje.', { code: 'already' });
    throw e;
  }
  bumpRank();
  scheduleCountBroadcast();
  send(res, 200, { ok: true, choice });
}

// ---------------------------------------------------------------- admin API
function isAdmin(req) {
  const k = req.headers['x-admin-key'];
  return !!k && safeEq(k, ADMIN_PASSWORD);
}

function adminData(req) {
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY ord, id').all().map(s => {
    const qs = db.prepare('SELECT * FROM questions WHERE session_id = ? ORDER BY ord, id').all(s.id).map(q => {
      const options = JSON.parse(q.options);
      const counts = answerCounts(q.id, options.length);
      const n = counts.reduce((a, b) => a + b, 0);
      return { id: q.id, ord: q.ord, text: q.text, options, correct: q.correct, timeLimit: q.time_limit, answers: n, correctAnswers: counts[q.correct] || 0 };
    });
    return { ...s, questions: qs };
  });
  return {
    version: VERSION,
    game, sessions,
    joinUrl: joinUrl(req),
    lanUrls: lanUrls(),
    registered: db.prepare('SELECT COUNT(*) AS n FROM participants').get().n,
    connected: clients.size,
    animals: ANIMALS,
  };
}

function nextQuestionId(sessionId, afterId) {
  const qs = db.prepare('SELECT id FROM questions WHERE session_id = ? ORDER BY ord, id').all(sessionId).map(r => r.id);
  if (!qs.length) return null;
  if (!afterId) {
    // prvo pitanje bez odgovora, inače prvo
    const unanswered = qs.find(id => !db.prepare('SELECT 1 FROM answers WHERE question_id = ? LIMIT 1').get(id));
    return unanswered ?? qs[0];
  }
  const i = qs.indexOf(afterId);
  return i >= 0 && i + 1 < qs.length ? qs[i + 1] : null;
}

async function apiAdminAction(req, res) {
  const b = await readBody(req);
  const a = b.action;
  switch (a) {
    case 'idle':
      clearTimeout(questionTimer);
      setPhase({ phase: 'idle', questionId: null });
      break;
    case 'openSession': {
      const s = getSession(Number(b.sessionId));
      if (!s) return fail(res, 404, 'Sesija ne postoji.');
      clearTimeout(questionTimer);
      db.prepare("UPDATE sessions SET status = 'active' WHERE id = ?").run(s.id);
      setPhase({ phase: 'lobby', sessionId: s.id, questionId: null, scope: 'session' });
      break;
    }
    case 'startQuestion': {
      if (!game.sessionId) return fail(res, 409, 'Prvo otvorite sesiju.');
      let qid = b.questionId ? Number(b.questionId) : nextQuestionId(game.sessionId, game.questionId);
      const q = qid && getQuestion(qid);
      if (!q || q.session_id !== game.sessionId) return fail(res, 409, 'Nema više pitanja u ovoj sesiji.');
      const hasAnswers = db.prepare('SELECT 1 FROM answers WHERE question_id = ? LIMIT 1').get(q.id);
      if (hasAnswers && !b.force) return fail(res, 409, 'Na ovo pitanje već postoje odgovori. Ponovo pokrenuti (stari odgovori se brišu)?', { code: 'hasAnswers', questionId: q.id });
      if (hasAnswers) { db.prepare('DELETE FROM answers WHERE question_id = ?').run(q.id); bumpRank(); }
      const now = Date.now();
      setPhase({ phase: 'question', questionId: q.id, startedAt: now, endsAt: now + q.time_limit * 1000 });
      armTimer();
      break;
    }
    case 'closeQuestion':
      if (game.phase !== 'question') return fail(res, 409, 'Nema otvorenog pitanja.');
      clearTimeout(questionTimer);
      setPhase({ phase: 'closed', endsAt: Math.min(game.endsAt, Date.now()) });
      break;
    case 'reveal':
      if (!game.questionId) return fail(res, 409, 'Nema aktivnog pitanja.');
      clearTimeout(questionTimer);
      // sačekaj da prođe tolerancija za zakasnele odgovore
      if (Date.now() < game.endsAt + GRACE_MS && game.phase === 'question') game.endsAt = Date.now();
      setPhase({ phase: 'reveal' });
      break;
    case 'board':
    case 'animals':
    case 'stats': {
      const scope = b.scope === 'all' ? 'all' : 'session';
      if (scope === 'session' && !game.sessionId) return fail(res, 409, 'Nema aktivne sesije.');
      clearTimeout(questionTimer);
      bumpRank();
      setPhase({ phase: a, scope });
      break;
    }
    case 'endSession':
      clearTimeout(questionTimer);
      if (game.sessionId) db.prepare("UPDATE sessions SET status = 'done' WHERE id = ?").run(game.sessionId);
      setPhase({ phase: 'idle', questionId: null, sessionId: null });
      break;
    default:
      return fail(res, 400, 'Nepoznata akcija.');
  }
  send(res, 200, { ok: true, game });
}

async function apiAdminSession(req, res) {
  const b = await readBody(req);
  if (b.delete) {
    if (game.sessionId === Number(b.id)) return fail(res, 409, 'Sesija je trenutno aktivna.');
    db.prepare('DELETE FROM answers WHERE session_id = ?').run(Number(b.id));
    db.prepare('DELETE FROM sessions WHERE id = ?').run(Number(b.id));
    bumpRank();
    return send(res, 200, { ok: true });
  }
  const name = String(b.name || '').trim();
  if (!name) return fail(res, 400, 'Unesite naziv sesije.');
  if (b.id) {
    db.prepare('UPDATE sessions SET name = ?, status = COALESCE(?, status) WHERE id = ?').run(name, b.status || null, Number(b.id));
  } else {
    const ord = db.prepare('SELECT COALESCE(MAX(ord),0)+1 AS o FROM sessions').get().o;
    db.prepare('INSERT INTO sessions (name, ord) VALUES (?, ?)').run(name, ord);
  }
  if (game.sessionId) broadcastState();
  send(res, 200, { ok: true });
}

async function apiAdminQuestion(req, res) {
  const b = await readBody(req);
  if (b.delete) {
    if (game.questionId === Number(b.id) && game.phase !== 'idle') return fail(res, 409, 'Pitanje je trenutno aktivno.');
    db.prepare('DELETE FROM questions WHERE id = ?').run(Number(b.id));
    bumpRank();
    return send(res, 200, { ok: true });
  }
  if (b.move) {
    const q = getQuestion(Number(b.id));
    if (!q) return fail(res, 404, 'Pitanje ne postoji.');
    const list = db.prepare('SELECT id FROM questions WHERE session_id = ? ORDER BY ord, id').all(q.session_id).map(r => r.id);
    const i = list.indexOf(q.id), j = i + (b.move < 0 ? -1 : 1);
    if (j >= 0 && j < list.length) { [list[i], list[j]] = [list[j], list[i]]; }
    const upd = db.prepare('UPDATE questions SET ord = ? WHERE id = ?');
    list.forEach((id, k) => upd.run(k + 1, id));
    return send(res, 200, { ok: true });
  }
  const q = validateQuestion(b);
  if (b.id) {
    if (game.questionId === Number(b.id) && ['question', 'closed'].includes(game.phase)) return fail(res, 409, 'Pitanje je trenutno aktivno.');
    db.prepare('UPDATE questions SET text = ?, options = ?, correct = ?, time_limit = ? WHERE id = ?')
      .run(q.text, JSON.stringify(q.options), q.correct, q.timeLimit, Number(b.id));
    // ako je promenjen tačan odgovor, preračunaj već date odgovore
    const qq = getQuestion(Number(b.id));
    const ans = db.prepare('SELECT id, choice, ms FROM answers WHERE question_id = ?').all(qq.id);
    const upd = db.prepare('UPDATE answers SET correct = ?, points = ? WHERE id = ?');
    for (const a of ans) {
      const c = a.choice === qq.correct ? 1 : 0;
      upd.run(c, c ? Math.round(SCORE_MAX - (SCORE_MAX - SCORE_MIN) * Math.min(1, a.ms / (qq.time_limit * 1000))) : 0, a.id);
    }
    bumpRank();
  } else {
    const sid = Number(b.sessionId);
    if (!getSession(sid)) return fail(res, 404, 'Sesija ne postoji.');
    const ord = db.prepare('SELECT COALESCE(MAX(ord),0)+1 AS o FROM questions WHERE session_id = ?').get(sid).o;
    db.prepare('INSERT INTO questions (session_id, ord, text, options, correct, time_limit) VALUES (?,?,?,?,?,?)')
      .run(sid, ord, q.text, JSON.stringify(q.options), q.correct, q.timeLimit);
  }
  send(res, 200, { ok: true });
}

function apiAdminParticipants(req, res, url) {
  const q = nickKey(url.searchParams.get('q') || '');
  const rows = db.prepare(`SELECT p.id, p.animal, p.nickname, p.disabled, p.created_at,
      (SELECT COALESCE(SUM(points),0) FROM answers WHERE participant_id = p.id) AS points,
      (SELECT COUNT(*) FROM answers WHERE participant_id = p.id) AS answered
      FROM participants p WHERE p.nick_key LIKE ? ORDER BY p.nick_key LIMIT 200`).all(`%${q}%`);
  send(res, 200, { rows });
}

async function apiAdminParticipant(req, res) {
  const b = await readBody(req);
  const p = db.prepare('SELECT * FROM participants WHERE id = ?').get(Number(b.id));
  if (!p) return fail(res, 404, 'Učesnik ne postoji.');
  switch (b.action) {
    case 'resetPin': {
      const pin = String(b.pin || '');
      if (!/^\d{4}$/.test(pin)) return fail(res, 400, 'PIN mora imati tačno 4 cifre.');
      const salt = crypto.randomBytes(12).toString('hex');
      db.prepare('UPDATE participants SET pin_salt = ?, pin_hash = ? WHERE id = ?').run(salt, await hashPin(pin, salt), p.id);
      failures.delete(p.id);
      break;
    }
    case 'rename': {
      const nickname = String(b.nickname || '').replace(/\s+/g, ' ').trim();
      if (!NICK_RE.test(nickname)) return fail(res, 400, 'Neispravan nadimak.');
      try {
        db.prepare('UPDATE participants SET nickname = ?, nick_key = ? WHERE id = ?').run(nickname, nickKey(nickname), p.id);
      } catch (e) { return fail(res, 409, 'Ta kombinacija je zauzeta.'); }
      break;
    }
    case 'disable': db.prepare('UPDATE participants SET disabled = 1 WHERE id = ?').run(p.id); break;
    case 'enable': db.prepare('UPDATE participants SET disabled = 0 WHERE id = ?').run(p.id); break;
    default: return fail(res, 400, 'Nepoznata akcija.');
  }
  bumpRank();
  if (['board', 'animals', 'stats'].includes(game.phase)) broadcastState();
  send(res, 200, { ok: true });
}

async function apiAdminReset(req, res) {
  const b = await readBody(req);
  if (!['OBRIŠI', 'OBRISI'].includes(String(b.confirm || '').trim().toUpperCase())) return fail(res, 400, 'Potvrda nije ispravna.');
  db.exec('BEGIN');
  if (b.what === 'all') db.exec('DELETE FROM answers; DELETE FROM participants;');
  else db.exec('DELETE FROM answers;');
  db.exec("UPDATE sessions SET status = 'pending'");
  db.exec('COMMIT');
  failures.clear();
  bumpRank();
  resetGame();
  send(res, 200, { ok: true });
}

function apiAdminExport(req, res, kind) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  if (kind === 'questions.json') {
    return send(res, 200, JSON.stringify(exportQuestions(), null, 2), {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="pitanja-${stamp}.json"`,
    });
  }
  if (kind === 'answers.csv') {
    const rows = db.prepare(`SELECT a.id, s.name AS sesija, q.ord AS pitanje_br, q.text AS pitanje, p.id AS ucesnik_id,
        p.animal AS zivotinja, p.nickname AS nadimak, a.choice, q.correct, a.correct AS tacno, a.points AS bodovi,
        a.ms AS vreme_ms, a.created_at AS vreme
        FROM answers a JOIN participants p ON p.id = a.participant_id JOIN questions q ON q.id = a.question_id
        JOIN sessions s ON s.id = q.session_id ORDER BY s.ord, q.ord, a.id`).all()
      .map(r => ({ ...r, odgovor: 'ABCD'[r.choice], tacan_odgovor: 'ABCD'[r.correct], zivotinja: animalOf(r.zivotinja).name }));
    return send(res, 200, csv(rows, ['id', 'sesija', 'pitanje_br', 'pitanje', 'ucesnik_id', 'zivotinja', 'nadimak', 'odgovor', 'tacan_odgovor', 'tacno', 'bodovi', 'vreme_ms', 'vreme']), {
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="odgovori-${stamp}.csv"`,
    });
  }
  if (kind === 'ranking.csv') {
    const rows = ranking('all').rows.map(r => ({ ...r, zivotinja: animalOf(r.animal).name, vreme_tacnih_s: (r.ms / 1000).toFixed(1) }));
    return send(res, 200, csv(rows, ['rank', 'zivotinja', 'nickname', 'points', 'correct', 'answered', 'vreme_tacnih_s']), {
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="rang-lista-${stamp}.csv"`,
    });
  }
  fail(res, 404, 'Nepoznat izvoz.');
}

function apiAdminStats(req, res, url) {
  const sid = Number(url.searchParams.get('sessionId')) || null;
  const scope = sid ? 'session' : 'all';
  send(res, 200, {
    summary: statsSummary(scope, sid),
    animals: animalRanking(scope, sid),
    top: ranking(scope, sid).rows.slice(0, 20),
  });
}

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}/`);
  }
  return out;
}

// ---------------------------------------------------------------- router
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Metod nije dozvoljen');
      return serveStatic(req, res, p);
    }
    if (p === '/api/stream') return handleStream(req, res);
    if (p === '/api/config' && req.method === 'GET') {
      return send(res, 200, { version: VERSION, title: config.title, subtitle: config.subtitle, scheduleNote: config.scheduleNote || '', animals: ANIMALS, joinUrl: joinUrl(req), animalRankBy: config.animalRankBy });
    }
    if (p === '/api/state') return send(res, 200, publicState());
    if (p === '/api/register' && req.method === 'POST') return await apiRegister(req, res);
    if (p === '/api/login' && req.method === 'POST') return await apiLogin(req, res);
    if (p === '/api/check') return apiCheck(req, res, url);
    if (p === '/api/me') return apiMe(req, res);
    if (p === '/api/answer' && req.method === 'POST') return await apiAnswer(req, res);

    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return fail(res, 401, 'Pogrešna administratorska lozinka.');
      if (p === '/api/admin/ping') return send(res, 200, { ok: true });
      if (p === '/api/admin/data') return send(res, 200, adminData(req));
      if (p === '/api/admin/action' && req.method === 'POST') return await apiAdminAction(req, res);
      if (p === '/api/admin/session' && req.method === 'POST') return await apiAdminSession(req, res);
      if (p === '/api/admin/question' && req.method === 'POST') return await apiAdminQuestion(req, res);
      if (p === '/api/admin/participants') return apiAdminParticipants(req, res, url);
      if (p === '/api/admin/participant' && req.method === 'POST') return await apiAdminParticipant(req, res);
      if (p === '/api/admin/reset' && req.method === 'POST') return await apiAdminReset(req, res);
      if (p === '/api/admin/stats') return apiAdminStats(req, res, url);
      if (p === '/api/admin/import' && req.method === 'POST') {
        if (game.phase !== 'idle') return fail(res, 409, 'Uvoz je moguć samo kad nijedna sesija nije aktivna.');
        importQuestions(await readBody(req));
        return send(res, 200, { ok: true });
      }
      const m = p.match(/^\/api\/admin\/export\/([\w.]+)$/);
      if (m) return apiAdminExport(req, res, m[1]);
    }
    fail(res, 404, 'Nepoznata putanja.');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) fail(res, 400, e.message || 'Greška');
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.maxConnections = 2000;

seedQuestionsIfEmpty();
server.listen(PORT, () => {
  console.log(`\n  DMSS kviz v${VERSION} radi na portu ${PORT}`);
  const urls = lanUrls();
  console.log('  Učesnici:     ' + (config.publicUrl || urls[0] || `http://localhost:${PORT}/`));
  for (const u of urls.slice(1)) console.log('                ' + u);
  console.log(`  Veliki ekran: http://localhost:${PORT}/ekran`);
  console.log(`  Voditelj:     http://localhost:${PORT}/admin\n`);
});

function shutdown() {
  console.log('\n  Gašenje...');
  for (const c of clients) c.end();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
