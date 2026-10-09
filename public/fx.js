/* DMSS kviz — efekti: konfete, brojanje, pozadina (bez spoljnih biblioteka) */
'use strict';

function mountBackdrop() {
  if (document.querySelector('.aurora')) return;
  const a = document.createElement('div'); a.className = 'aurora'; a.innerHTML = '<i></i><i></i><i></i><i></i>';
  const g = document.createElement('div'); g.className = 'gridfx';
  document.body.prepend(g); document.body.prepend(a);
}

/** Broji od trenutne do ciljne vrednosti. */
function countUp(el, to, { duration = 1100, format = v => fmtNum(Math.round(v)), from = 0 } = {}) {
  if (!el) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || duration <= 0) { el.textContent = format(to); return; }
  const t0 = performance.now();
  const step = now => {
    const k = Math.min(1, (now - t0) / duration);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = format(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function countAll(root = document) {
  root.querySelectorAll('[data-count]').forEach(el => {
    const to = Number(el.dataset.count);
    const dec = Number(el.dataset.dec || 0);
    const suffix = el.dataset.suffix || '';
    const delay = Number(el.dataset.delay || 0);
    setTimeout(() => countUp(el, to, {
      duration: Number(el.dataset.dur || 1100),
      format: v => (dec ? fmtDec(v, dec) : fmtNum(Math.round(v))) + suffix,
    }), delay);
  });
}

/** Konfete — lagan canvas efekat. */
const Confetti = (() => {
  let canvas, ctx, parts = [], raf = 0;
  const COLORS = ['#fb7185', '#60a5fa', '#fbbf24', '#34d399', '#a78bfa', '#22d3ee', '#ffffff'];
  function ensure() {
    if (canvas) return;
    canvas = document.createElement('canvas'); canvas.className = 'confetti-canvas';
    document.body.appendChild(canvas); ctx = canvas.getContext('2d');
    const resize = () => { const d = Math.min(2, devicePixelRatio || 1); canvas.width = innerWidth * d; canvas.height = innerHeight * d; ctx.setTransform(d, 0, 0, d, 0, 0); };
    resize(); addEventListener('resize', resize);
  }
  function loop() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    parts = parts.filter(p => p.life > 0 && p.y < innerHeight + 40);
    for (const p of parts) {
      p.vx *= .985; p.vy = p.vy * .985 + .32; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life -= 1;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = Math.min(1, p.life / 40);
      ctx.fillStyle = p.c;
      if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.s / 2, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2 * (0.4 + Math.abs(Math.sin(p.rot * 2))));
      ctx.restore();
    }
    if (parts.length) raf = requestAnimationFrame(loop); else { raf = 0; ctx.clearRect(0, 0, innerWidth, innerHeight); }
  }
  function burst({ x = innerWidth / 2, y = innerHeight / 3, count = 140, spread = 1, power = 14 } = {}) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    ensure();
    for (let i = 0; i < count; i++) {
      const ang = -Math.PI / 2 + (Math.random() - .5) * Math.PI * spread;
      const v = power * (.45 + Math.random() * .75);
      parts.push({ x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, rot: Math.random() * 6, vr: (Math.random() - .5) * .35,
        s: 7 + Math.random() * 8, c: COLORS[(Math.random() * COLORS.length) | 0], life: 150 + Math.random() * 90, round: Math.random() < .25 });
    }
    if (!raf) raf = requestAnimationFrame(loop);
  }
  function fromElement(el, opts = {}) {
    if (!el) return burst(opts);
    const r = el.getBoundingClientRect();
    burst({ x: r.left + r.width / 2, y: r.top + r.height / 2, ...opts });
  }
  function rain(n = 3, gap = 260) {
    for (let i = 0; i < n; i++) setTimeout(() => burst({ x: innerWidth * (.2 + .6 * Math.random()), y: innerHeight * .25, count: 120, spread: 1.4 }), i * gap);
  }
  function clear() { parts = []; }
  return { burst, fromElement, rain, clear };
})();

/** Kružni tajmer (SVG) sa gradijentom. */
function ringSvg(id, R = 44) {
  const C = 2 * Math.PI * R;
  return `<svg viewBox="0 0 100 100" aria-hidden="true">
    <defs><linearGradient id="${id}-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset=".5" stop-color="#60a5fa"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
    <circle cx="50" cy="50" r="${R}" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="8"/>
    <circle class="arc" cx="50" cy="50" r="${R}" fill="none" stroke="url(#${id}-g)" stroke-width="8" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="0" data-c="${C}"/>
  </svg>`;
}
