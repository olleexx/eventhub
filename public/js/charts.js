// Tiny dependency-free SVG charts. All values come from API aggregates; text is set via textContent.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };
const niceMax = (m) => { if (m <= 0) return 1; const p = 10 ** Math.floor(Math.log10(m)); const f = m / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
const compact = (n) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

/** points: [{label, value}]. kind: 'line' | 'bar'. fmt formats the tooltip value. */
export function chart(points, { kind = 'line', color = 'var(--coral)', label = 'Chart', fmt = (v) => String(v), height = 220 } = {}) {
  const W = 640, H = height, m = { l: 48, r: 12, t: 12, b: 28 };
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label, class: 'chart', preserveAspectRatio: 'xMidYMid meet' });
  svg.style.width = '100%'; svg.style.height = 'auto'; svg.style.display = 'block';
  if (!points.length || points.every((p) => !p.value)) {
    svg.appendChild(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 14 }, 'No data in this period'));
    return svg;
  }
  const max = niceMax(Math.max(...points.map((p) => p.value)));
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = (i) => m.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v) => m.t + ih - (v / max) * ih;
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i; const yy = y(v);
    svg.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy, stroke: 'var(--line)', 'stroke-width': 1 }));
    svg.appendChild(s('text', { x: m.l - 6, y: yy + 4, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 11 }, compact(v)));
  }
  const step = Math.ceil(points.length / 7);
  points.forEach((p, i) => { if (i % step === 0 || i === points.length - 1) svg.appendChild(s('text', { x: kind === 'bar' ? m.l + (i + 0.5) * (iw / points.length) : x(i), y: H - 8, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 11 }, p.label.length > 6 ? p.label.slice(5) : p.label)); });
  if (kind === 'bar') {
    const bw = iw / points.length;
    points.forEach((p, i) => { const g = s('g'); g.appendChild(s('title', {}, `${p.label}: ${fmt(p.value)}`)); g.appendChild(s('rect', { x: m.l + i * bw + bw * 0.15, y: y(p.value), width: bw * 0.7, height: Math.max(0, m.t + ih - y(p.value)), rx: 3, fill: color })); svg.appendChild(g); });
  } else {
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    svg.appendChild(s('path', { d: `${d} L${x(points.length - 1)},${m.t + ih} L${x(0)},${m.t + ih} Z`, fill: color, opacity: 0.12 }));
    svg.appendChild(s('path', { d, fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    points.forEach((p, i) => { const g = s('g'); g.appendChild(s('title', {}, `${p.label}: ${fmt(p.value)}`)); g.appendChild(s('circle', { cx: x(i), cy: y(p.value), r: points.length > 40 ? 2 : 4, fill: 'var(--surface)', stroke: color, 'stroke-width': 2 })); svg.appendChild(g); });
  }
  return svg;
}

/** Fill every calendar day between first and last so gaps show as zeros. */
export function fillDays(rows, key, from, to) {
  const map = new Map(rows.map((r) => [r.day, Number(r[key])]));
  const out = []; const start = new Date(from); const end = new Date(to);
  start.setUTCHours(0, 0, 0, 0);
  for (let d = start; d <= end && out.length < 400; d = new Date(d.getTime() + 86_400_000)) { const k = d.toISOString().slice(0, 10); out.push({ label: k, value: map.get(k) ?? 0 }); }
  return out;
}
