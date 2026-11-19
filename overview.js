// 總覽頁：重點句、數字卡、甜甜圈圖、長條圖、折線圖。全部手寫 SVG，不用外部程式庫。
// 配色：橘／藍／青綠三色（已用 dataviz 驗證工具在淺色 #faf9f5、深色 #262624 底上通過全部配對檢查），
// 第 4 類以後一律歸到灰色「其他」；超過 4 類的資料改用長條圖。

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pc = (x, d = 0) => (Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : '—');
const n0 = x => (Number.isFinite(x) ? x.toLocaleString('zh-TW') : '—');
const sum = o => Object.values(o || {}).reduce((a, x) => a + (Number(x) || 0), 0);

const WDL = [['win', 'Win', 'var(--c3)'], ['draw', 'Draw', 'var(--cn)'], ['loss', 'Loss', 'var(--c1)']];
const SLOT = ['var(--c1)', 'var(--c2)', 'var(--c3)'];

/* ---------- 小工具：固定配色的類別＋其他 ---------- */
// 顏色跟著類別走，不跟著排名走：同一種結束方式在「贏」和「輸」裡顏色一樣
const END_COLOR = { Checkmate: 'var(--c1)', Timeout: 'var(--c2)', Resignation: 'var(--c3)', Stalemate: 'var(--c1)', Repetition: 'var(--c2)', 'Insufficient material': 'var(--c3)' };
function top3(obj) {
  const arr = Object.entries(obj || {}).map(([k, v]) => [k, Number(v) || 0]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
  const head = arr.filter(([k]) => END_COLOR[k]).map(([k, v]) => ({ label: k, value: v, color: END_COLOR[k] }));
  const rest = arr.filter(([k]) => !END_COLOR[k]);
  if (rest.length) head.push({ label: rest.length === 1 ? rest[0][0] : 'Other', value: rest.reduce((a, x) => a + x[1], 0), color: 'var(--cn)', note: rest.length > 1 ? rest.map(x => `${x[0]} ${x[1]}`).join('、') : '' });
  return head;
}

/* ---------- 甜甜圈圖 ---------- */
function donut(parts, center, sub, label) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return '<p class="muted small">沒有資料。</p>';
  const R = 46, C = 2 * Math.PI * R, GAP = parts.filter(p => p.value).length > 1 ? 1.6 : 0;
  let off = 0;
  const segs = parts.map(p => {
    const len = p.value / total * C;
    const vis = Math.max(0, len - GAP);
    const s = `<circle class="seg" r="${R}" cx="60" cy="60" fill="none" stroke="${p.color}" stroke-width="15"
      stroke-dasharray="${vis.toFixed(2)} ${(C - vis).toFixed(2)}" stroke-dashoffset="${(-off - GAP / 2).toFixed(2)}"
      data-tip="${esc(p.label)}：${p.value} 局（${pc(p.value / total, 1)}）${p.note ? '｜' + esc(p.note) : ''}"/>`;
    off += len;
    return s;
  }).join('');
  const legend = parts.map(p => `<li><i style="background:${p.color}"></i><span>${esc(p.label)}</span><b>${p.value}</b><em>${pc(p.value / total)}</em></li>`).join('');
  return `<div class="donut">
    <svg viewBox="0 0 120 120" role="img" aria-label="${esc(label)}：${parts.map(p => `${p.label} ${p.value}`).join('，')}">
      <g transform="rotate(-90 60 60)">${segs}</g>
      <text x="60" y="58" text-anchor="middle" class="d-big">${esc(center)}</text>
      <text x="60" y="74" text-anchor="middle" class="d-sub">${esc(sub)}</text>
    </svg>
    <ul class="legend">${legend}</ul></div>`;
}

/* ---------- 百分比堆疊橫條（勝和負） ---------- */
function wdlRows(rows) {
  return `<div class="stack-list">${rows.map(([name, d]) => {
    const t = (d.win || 0) + (d.draw || 0) + (d.loss || 0);
    if (!t) return '';
    const segs = WDL.map(([k, zh, col]) => d[k] ? `<i style="flex:${d[k]};background:${col}" data-tip="${esc(name)}・${zh} ${d[k]} 局（${pc(d[k] / t, 1)}）"></i>` : '').join('');
    return `<div class="stack-row"><div class="sr-head"><span>${esc(name)}</span><span class="muted">${t} 局・Score <b>${pc((d.win + d.draw / 2) / t)}</b></span></div>
      <div class="stack">${segs}</div></div>`;
  }).join('')}
  <div class="key">${WDL.map(([, zh, col]) => `<span><i style="background:${col}"></i>${zh}</span>`).join('')}</div></div>`;
}

/* ---------- 單色橫條（排序） ---------- */
function hbars(items, fmt = v => v) {
  const max = Math.max(1, ...items.map(x => x.value));
  return `<div class="hbars">${items.map(x => `<div class="hb" data-tip="${esc(x.label)}：${esc(fmt(x.value))}${x.tip ? '｜' + esc(x.tip) : ''}">
    <span class="hb-l">${esc(x.label)}</span><div class="hb-t"><i style="width:${(x.value / max * 100).toFixed(1)}%"></i></div><b>${esc(fmt(x.value))}</b></div>`).join('')}</div>`;
}

/* ---------- 單色直條（有順序的類別） ---------- */
function columns(items, { fmt = v => v, max = null, ref = null, refLabel = '' } = {}) {
  const top = max ?? Math.max(1e-9, ...items.map(x => x.value ?? 0));
  const hi = items.reduce((b, x) => (x.value ?? -1) > (b?.value ?? -1) ? x : b, null);
  return `<div class="cols">
    ${ref != null ? `<div class="cols-ref" style="bottom:${(ref / top * 100).toFixed(1)}%"><span>${esc(refLabel)}</span></div>` : ''}
    ${items.map(x => {
      const h = x.value == null ? 0 : x.value / top * 100;
      return `<div class="col" data-tip="${esc(x.label)}：${esc(x.value == null ? '—' : fmt(x.value))}${x.tip ? '｜' + esc(x.tip) : ''}">
        <div class="col-bar"><i style="height:${h.toFixed(1)}%">${x === hi ? `<span class="col-v">${esc(fmt(x.value))}</span>` : ''}</i></div>
        <div class="col-l">${esc(x.label)}</div>${x.sub ? `<div class="col-s">${esc(x.sub)}</div>` : ''}</div>`;
    }).join('')}</div>`;
}

/* ---------- 折線圖（含十字線） ---------- */
let lineSeq = 0;
function lineChart(series, { yFmt = v => v, label = '' } = {}) {
  const all = series.flatMap(s => s.points);
  if (all.length < 2) return '<p class="muted small">資料不足。</p>';
  const id = 'lc' + (++lineSeq);
  const W = 640, H = 220, L = 40, R = 14, T = 12, B = 26;
  const ts = all.map(p => p.t), vs = all.map(p => p.v);
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  let v0 = Math.min(...vs), v1 = Math.max(...vs);
  const pad = (v1 - v0) * 0.08 || 10; v0 -= pad; v1 += pad;
  const X = t => L + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - L - R);
  const Y = v => T + (1 - (v - v0) / (v1 - v0)) * (H - T - B);
  const ticks = [0, 0.5, 1].map(f => v0 + pad + f * (v1 - v0 - 2 * pad));
  const grid = ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="grid"/>
    <text x="${L - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" class="ax">${esc(yFmt(Math.round(v)))}</text>`).join('');
  const d0 = new Date(t0), d1 = new Date(t1);
  const fmtD = d => `${d.getFullYear()}/${d.getMonth() + 1}`;
  const paths = series.map(s => {
    if (s.points.length < 2) return '';
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
    const lp = s.points[s.points.length - 1];
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${X(lp.t).toFixed(1)}" cy="${Y(lp.v).toFixed(1)}" r="4" fill="${s.color}" class="ring"/>`;
  }).join('');
  const key = series.length > 1 ? `<div class="key">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)} ${esc(yFmt(s.points.at(-1)?.v))}</span>`).join('')}</div>` : '';
  lineData.set(id, { series, X, Y, t0, t1, W, H, L, R, T, B, yFmt });
  return `<div class="linewrap" id="${id}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
      ${grid}
      <line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="base"/>
      <text x="${L}" y="${H - 6}" class="ax">${fmtD(d0)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end" class="ax">${fmtD(d1)}</text>
      ${paths}
      <g class="xh" style="display:none"><line class="xh-l" y1="${T}" y2="${H - B}"/>${series.map(s => `<circle r="4" fill="${s.color}" class="ring"/>`).join('')}</g>
      <rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
    </svg>${key}</div>`;
}
const lineData = new Map();

function wireLines(root) {
  for (const [id, m] of lineData) {
    const wrap = root.querySelector('#' + id);
    if (!wrap) continue;
    const svg = wrap.querySelector('svg'), hit = wrap.querySelector('.hit'), xh = wrap.querySelector('.xh');
    const line = xh.querySelector('.xh-l'), dots = [...xh.querySelectorAll('circle')];
    const show = e => {
      const r = svg.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width * m.W;
      const t = m.t0 + Math.max(0, Math.min(1, (x - m.L) / (m.W - m.L - m.R))) * (m.t1 - m.t0);
      const rows = [];
      m.series.forEach((s, i) => {
        let p = null;
        for (const q of s.points) { if (q.t <= t) p = q; else break; }
        if (!p) { dots[i].style.display = 'none'; return; }
        dots[i].style.display = '';
        dots[i].setAttribute('cx', m.X(p.t)); dots[i].setAttribute('cy', m.Y(p.v));
        rows.push(`${s.name} ${m.yFmt(p.v)}`);
      });
      const xx = m.X(t);
      line.setAttribute('x1', xx); line.setAttribute('x2', xx);
      xh.style.display = '';
      const d = new Date(t);
      tip(`${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}｜${rows.join('，')}`, e.clientX, e.clientY);
    };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', () => { xh.style.display = 'none'; hideTip(); });
  }
  lineData.clear();
}

/* ---------- 提示框（滑鼠移上去、手指點一下） ---------- */
let tipEl = null;
function tip(text, x, y) {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'ov-tip'; document.body.appendChild(tipEl); }
  tipEl.textContent = text;
  tipEl.style.display = 'block';
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  tipEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2)) + 'px';
  tipEl.style.top = Math.max(8, y - h - 14) + 'px';
}
function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

function wireTips(root) {
  root.addEventListener('pointerover', e => { const t = e.target.closest('[data-tip]'); if (t) tip(t.dataset.tip, e.clientX, e.clientY); });
  root.addEventListener('pointermove', e => { const t = e.target.closest('[data-tip]'); if (t) tip(t.dataset.tip, e.clientX, e.clientY); });
  root.addEventListener('pointerout', e => { if (e.target.closest('[data-tip]')) hideTip(); });
  root.addEventListener('pointerdown', e => { const t = e.target.closest('[data-tip]'); if (t) tip(t.dataset.tip, e.clientX, e.clientY); else if (!e.target.closest('.hit')) hideTip(); });
}

/* ---------- 版面 ---------- */
const section = (eyebrow, title, body, note = '') => `<section class="ov-sec">
  <div class="eyebrow">${esc(eyebrow)}</div><h2>${esc(title)}</h2>${body}${note ? `<p class="ov-note">${note}</p>` : ''}</section>`;
const card = (title, body, foot = '') => `<div class="ov-card">${title ? `<h3>${esc(title)}</h3>` : ''}${body}${foot ? `<p class="ov-foot">${foot}</p>` : ''}</div>`;
const tile = (value, label, sub = '') => `<div class="tile"><b>${value}</b><span>${esc(label)}</span>${sub ? `<em>${sub}</em>` : ''}</div>`;
const delta = d => Number.isFinite(d) ? `<span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d)}</span>（30d）` : '';

export function renderOverview(view, { report, stats, due, CAT, PHASE, fmtDate }) {
  const st = stats || {};
  const tot = st.totals || report?.totals || {};
  const G = (tot.win || 0) + (tot.draw || 0) + (tot.loss || 0);
  const score = G ? (tot.win + tot.draw / 2) / G : NaN;
  const bl = report?.blunders || {};
  const cats = bl.by_category || {};
  const totalB = sum(cats);
  const adv = st.big_advantage, dis = st.big_disadvantage;
  const lossN = sum(st.loss_how), lossMate = st.loss_how?.Checkmate || 0, lossTime = st.loss_how?.Timeout || 0;
  const br = st.blunder_rate_by_move || [];
  const peak = br.reduce((b, x) => (x.per100 ?? -1) > (b?.per100 ?? -1) ? x : b, null);
  const rt = st.rating || {};

  // 重點句：資料自己說話
  const facts = [];
  if (adv?.games) facts.push(`Winning position（≥ ${st.params?.big_adv ?? 80}%）<b>${adv.games}</b> 局：輸 <b>${adv.loss}</b>（${pc(adv.loss / adv.games)}）、和 ${adv.draw}。`);
  if (lossN) facts.push(`Losses：Checkmate <b>${pc(lossMate / lossN)}</b>、Timeout ${pc(lossTime / lossN)}。`);
  if (st.low_clock?.games) facts.push(`Time trouble（< 10%）${st.low_clock.games} 局：Score <b>${pc(st.low_clock.score)}</b>。`);
  if (peak) facts.push(`Blunder 高峰：第 <b>${peak.bucket}</b> 手，${peak.per100} / 100 手。`);

  const lead = `<header class="ov-hero">
    <div class="eyebrow">LHTN27 ・ ${n0(G)} games</div>
    <h1>Game Report</h1>
    ${facts.length ? `<ul class="facts">${facts.map(f => `<li>${f}</li>`).join('')}</ul>` : ''}
    <a class="ov-cta" href="#/practice">今日 ${due} 題 <span aria-hidden="true">→</span></a>
  </header>`;

  const tiles = `<div class="tiles">
    ${tile(n0(G), 'Games', `Blitz ${n0((st.by_time_class?.blitz?.win || 0) + (st.by_time_class?.blitz?.draw || 0) + (st.by_time_class?.blitz?.loss || 0))}・Rapid ${n0((st.by_time_class?.rapid?.win || 0) + (st.by_time_class?.rapid?.draw || 0) + (st.by_time_class?.rapid?.loss || 0))}`)}
    ${tile(pc(score, 1), 'Score', 'W 1・D ½')}
    ${tile(st.accuracy?.mean ?? '—', 'Accuracy', `Blitz ${st.accuracy?.blitz ?? '—'}・Rapid ${st.accuracy?.rapid ?? '—'}`)}
    ${tile(rt.blitz?.now ?? '—', 'Blitz rating', delta(rt.blitz?.change_30d))}
    ${tile(rt.rapid?.now ?? '—', 'Rapid rating', delta(rt.rapid?.change_30d))}
    ${tile(st.avg_moves ?? '—', 'Avg. moves', `Win streak ${st.streak?.win ?? '—'}・Loss streak ${st.streak?.loss ?? '—'}`)}
  </div>`;

  // 1. 勝負
  const s1 = section('01', 'Results', `<div class="ov-grid">
    ${card('Overall', donut(WDL.map(([k, zh, col]) => ({ label: zh, value: tot[k] || 0, color: col })), pc(score), 'Score', 'Overall'))}
    ${card('By color & time control', wdlRows([['White', st.by_color?.white || {}], ['Black', st.by_color?.black || {}], ['Blitz', st.by_time_class?.blitz || {}], ['Rapid', st.by_time_class?.rapid || {}]]))}
  </div>`);

  // 2. 對局怎麼結束
  const s2 = section('02', 'Termination', `<div class="ov-grid three">
    ${card('Wins', donut(top3(st.win_how), n0(sum(st.win_how)), 'wins', 'Wins'))}
    ${card('Losses', donut(top3(st.loss_how), n0(lossN), 'losses', 'Losses'))}
    ${card('Draws', donut(top3(st.draw_how), n0(sum(st.draw_how)), 'draws', 'Draws'))}
  </div>`, st.draw_how?.Stalemate ? `Stalemate ${st.draw_how.Stalemate} 局，占和局 ${pc(st.draw_how.Stalemate / sum(st.draw_how))}。` : '');

  // 3. 優勢與逆轉
  const s3 = section('03', 'Conversion', `<div class="ov-grid">
    ${card(`Winning position ≥ ${st.params?.big_adv ?? 80}%・${adv?.games ?? 0} 局`, adv ? donut(WDL.map(([k, zh, col]) => ({ label: zh, value: adv[k] || 0, color: col })), pc(adv.games ? adv.win / adv.games : NaN), 'converted', 'Winning positions') : '', '不計前 3 回合。')}
    ${card(`Losing position ≤ ${st.params?.big_dis ?? 20}%・${dis?.games ?? 0} 局`, dis ? donut(WDL.map(([k, zh, col]) => ({ label: zh, value: dis[k] || 0, color: col })), pc(dis.games ? dis.win / dis.games : NaN), 'comeback', 'Losing positions') : '', '不計前 3 回合。')}
  </div>`);

  // 4. 漏著
  const catItems = Object.keys(CAT).map(k => ({ label: CAT[k], value: Number(cats[k]) || 0 })).sort((a, b) => b.value - a.value)
    .map(x => ({ ...x, tip: totalB ? `占 ${pc(x.value / totalB, 1)}` : '' }));
  const ph = bl.by_phase || {};
  const s4 = section('04', 'Blunders', `<div class="ov-grid">
    ${card(`Type・${n0(totalB)}`, hbars(catItems, v => n0(v)))}
    ${card('Phase', donut(Object.keys(PHASE).map((k, i) => ({ label: PHASE[k], value: Number(ph[k]) || 0, color: SLOT[i] })), (bl.per_game ?? 0).toFixed(2), 'per game', 'Phase'))}
  </div>
  ${card('Blunders per 100 moves・by move number', columns(br.map(x => ({ label: x.bucket, value: x.per100, sub: `${n0(x.moves)} 手`, tip: `${x.blunders} blunders / ${n0(x.moves)} 手` })), { fmt: v => v.toFixed(1) }))}`);

  // 5. 時間與心態
  const hours = st.by_hour || {};
  const diff = st.by_rating_diff || {};
  const after = st.after_result || {};
  const s5 = section('05', 'Time & Tilt', `<div class="ov-grid">
    ${card('Score by time of day（UTC+8）', columns(Object.entries(hours).map(([k, v]) => ({ label: k, value: v.score, sub: `${v.games} 局` })), { fmt: v => pc(v), max: 1, ref: 0.5, refLabel: '50%' }))}
    ${card('Score by rating gap（opponent − you）', columns(Object.entries(diff).map(([k, v]) => ({ label: k, value: v.score, sub: `${v.games} 局` })), { fmt: v => pc(v), max: 1, ref: 0.5, refLabel: '50%' }))}
  </div>
  <div class="tiles">
    ${tile(pc(after.win?.score), 'After a win', `${n0(after.win?.games)} 局`)}
    ${tile(pc(after.loss?.score), 'After a loss', `${n0(after.loss?.games)} 局`)}
    ${tile(pc(st.low_clock?.score), 'Time trouble < 10%', `${n0(st.low_clock?.games)} 局`)}
  </div>`, `After a win / loss：前局結束後 ${st.params?.session_gap_min ?? 45} 分鐘內的下一局。數值皆為 Score。`);

  // 6. 走勢
  const hist = (report?.rating_history || []).filter(h => h && Number.isFinite(h.rating) && h.date);
  const ser = [['blitz', 'Blitz', 'var(--c2)'], ['rapid', 'Rapid', 'var(--c1)']].map(([k, name, color]) => ({
    name, color, points: hist.filter(h => h.time_class === k).map(h => ({ t: new Date(h.date).getTime(), v: h.rating })).sort((a, b) => a.t - b.t),
  })).filter(s => s.points.length > 1);
  const acc = (st.accuracy?.by_month || []).filter(m => m.mean != null && m.games >= 5);
  const s6 = section('06', 'Progress', `
    ${card('Rating', lineChart(ser, { label: 'Rating' }))}
    ${acc.length > 1 ? card('Accuracy by month', lineChart([{ name: 'Accuracy', color: 'var(--c2)', points: acc.map(m => ({ t: new Date(m.month + '-15').getTime(), v: m.mean })) }], { label: 'Accuracy by month', yFmt: v => Number(v).toFixed ? Number(v).toFixed(0) : v }), '≥ 5 局的月份；Lichess accuracy 公式。') : ''}`);

  view.innerHTML = `<div class="ov">${lead}${tiles}${s1}${s2}${s3}${s4}${s5}${s6}
    <p class="ov-gen">Updated ${esc(fmtDate(st.generated || report?.generated))}</p></div>`;
  const root = view.querySelector('.ov');
  wireTips(root);
  wireLines(root);
}

export function cleanupOverview() { hideTip(); }
