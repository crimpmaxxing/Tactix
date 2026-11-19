import { Chess } from './vendor/chess.js';
import * as store from './store.js';
import { Board, renderBoard } from './board.js';
import * as audio from './audio.js';
import * as T from './trainer.js';
import * as engine from './engine.js';
import * as L from './learn.js';
import { renderOverview, cleanupOverview } from './overview.js';

export const APP_VERSION = '2.5.1'; // 與 sw.js 的 VERSION 一起改

// ?mock=1：改讀 data/mock/ 的測試資料，進度另存，不動真正的進度。
const MOCK = (() => { try { return new URLSearchParams(location.search).get('mock') === '1'; } catch (e) { return false; } })();
const DATA_DIR = MOCK ? 'data/mock/' : 'data/';
if (MOCK) store.setNamespace('mock');

const CAT = {
  hanging: '掉子',
  missed_threat: '漏看威脅',
  missed_tactic: '錯失戰術',
  endgame: '殘局技術',
  other: '其他',
};
const PHASE = { opening: '開局', middlegame: '中局', endgame: '殘局' };
const TAG = { time_pressure: '時間壓力', opening: '開局階段' };

const ZH_OPENING = {
  'Sicilian Defense': '西西里防禦',
  'French Defense': '法蘭西防禦',
  'Caro Kann Defense': '卡羅卡恩防禦',
  'Scandinavian Defense': '斯堪的納維亞防禦',
  'Italian Game': '義大利開局',
  'London System': '倫敦體系',
  'Scotch Game': '蘇格蘭開局',
  'Kings Gambit': '國王棄兵',
  'Queens Gambit Declined': '后翼棄兵（拒絕）',
  'Queens Gambit': '后翼棄兵',
  'Queens Pawn Opening': '后兵開局',
  'Kings Pawn Opening': '王兵開局',
  'Ruy Lopez': '西班牙開局',
  'English Opening': '英國式開局',
  'Pirc Defense': '皮爾茲防禦',
  'Petrovs Defense': '彼得羅夫防禦',
  'Vienna Game': '維也納開局',
  'Four Knights Game': '四騎士開局',
  'Philidor Defense': '菲利多爾防禦',
  'Alekhine Defense': '阿廖欣防禦',
  'Modern Defense': '現代防禦',
  'Slav Defense': '斯拉夫防禦',
  'Kings Indian Defense': '古印度防禦',
  'Dutch Defense': '荷蘭防禦',
  'Bishops Opening': '主教開局',
};

const $view = document.getElementById('view');
const $title = document.getElementById('page-title');

const state = {
  report: null,
  puzzles: [],
  skipped: 0,
  reportError: false,
  puzzlesError: false,
  openings: null,   // openings.json 的 repertoires 陣列；讀不到是 null
  learnData: null,  // learn.json（學習模式的章節）；讀不到是 null
  learn: null,      // 學習模式目前的工作階段
  tmos: [],         // 排程中的延遲動作
  drill: null,      // 「從頭練」目前的練習
  filter: { category: '', opening: '', openingOnly: false, motif: '' },
  forced: [],      // 從開局頁指定要練的題目
  extra: false,    // 今天到期的都做完後，是否繼續練未到期的
  cur: null,       // 目前這一題的狀態
  lastId: null,
  timer: null,
  board: null,
};

/* ---------- 小工具 ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pct(x, d = 0) { return Number.isFinite(x) ? x.toFixed(d) + '%' : '—'; }
function norm(san) { return String(san).replace(/[+#!?]/g, ''); }
function zhOpening(name) {
  const n = String(name || '').replace(/-/g, ' ').replace(/'/g, '');
  let best = '';
  for (const k of Object.keys(ZH_OPENING)) if (n.startsWith(k) && k.length > best.length) best = k;
  return best ? ZH_OPENING[best] : '';
}
function stopTimer() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  for (const t of state.tmos) clearTimeout(t);
  state.tmos = [];
}
function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso || '—') : d.toLocaleString('zh-TW', { hour12: false });
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// 把題目轉成「步驟」。有 steps 用 steps；沒有（舊資料）就用 v1 欄位當單步題。
function buildSteps(p) {
  if (Array.isArray(p.steps) && p.steps.length) {
    try {
      const out = [];
      for (const s of p.steps) {
        if (!s || !s.fen || !s.best) throw new Error('步驟缺欄位');
        new Chess(s.fen).move(s.best);   // 最佳著必須合法，否則丟例外
        let accept = Array.isArray(s.accept) && s.accept.length ? s.accept.slice() : [s.best];
        if (!accept.some(a => norm(a) === norm(s.best))) accept.unshift(s.best);
        out.push({
          fen: s.fen, best: s.best, accept,
          moves: s.moves && typeof s.moves === 'object' ? s.moves : {},
          why: s.why && typeof s.why === 'object' ? s.why : {},
          whyReply: s.why_reply && typeof s.why_reply === 'object' ? s.why_reply : {},
          hint: typeof s.hint === 'string' ? s.hint : '',
          reply: typeof s.reply === 'string' && s.reply ? s.reply : null,
        });
      }
      return { steps: out, legacy: false };
    } catch (e) { /* 步驟壞掉就退回舊格式 */ }
  }
  return {
    steps: [{ fen: p.fen, best: p.best_san, accept: p.accept_san.slice(), moves: {}, why: {}, whyReply: {}, hint: '', reply: null }],
    legacy: true,
  };
}

// 驗證並補齊一題；格式不對丟例外。
function prepPuzzle(p) {
  if (!p || !p.id || !p.fen || !p.best_san) throw new Error('缺欄位');
  new Chess(p.fen);
  p.accept_san = Array.isArray(p.accept_san) && p.accept_san.length ? p.accept_san : [p.best_san];
  p.best_line_san = Array.isArray(p.best_line_san) && p.best_line_san.length ? p.best_line_san : [p.best_san];
  p.tags = Array.isArray(p.tags) ? p.tags : [];
  p.motifs = Array.isArray(p.motifs) ? p.motifs : [];
  p.allowed = Array.isArray(p.allowed) ? p.allowed : [];
  if (Array.isArray(p.line_san) && p.line_san.length) p.best_line_san = p.line_san;
  // 對手上一步（題目開始時先播一次，並一直標示）
  p._prev = null;
  if (p.prev_fen && p.prev_san) {
    try {
      const g = new Chess(p.prev_fen);
      const m = g.move(p.prev_san);
      if (T.fen4(g.fen()) === T.fen4(p.fen)) p._prev = { fen: p.prev_fen, last: { from: m.from, to: m.to }, cap: !!m.captured };
    } catch (e) { p._prev = null; }
  }
  const b = buildSteps(p);
  p._steps = b.steps;
  p._legacy = b.legacy;
  return p;
}

function prepRepertoire(r) {
  if (!r || !r.id || !r.name || !r.nodes || typeof r.nodes !== 'object') throw new Error('缺欄位');
  r.color = r.color === 'black' ? 'black' : 'white';
  return r;
}

async function loadData() {
  try {
    const r = await getJson('data/report.json');
    state.report = r && typeof r === 'object' ? r : null;
    state.reportError = !state.report;
  } catch (e) { state.report = null; state.reportError = true; }
  try {
    const st = await getJson('data/stats.json');
    state.stats = st && typeof st === 'object' && st.totals ? st : null;
  } catch (e) { state.stats = null; }
  try {
    const arr = await getJson(DATA_DIR + 'puzzles.json');
    const ok = [];
    let bad = 0;
    for (const p of Array.isArray(arr) ? arr : []) {
      try { ok.push(prepPuzzle(p)); } catch (e) { bad++; }
    }
    state.puzzles = ok;
    state.skipped = bad;
    state.puzzlesError = false;
  } catch (e) { state.puzzles = []; state.puzzlesError = true; }
  try {
    const o = await getJson(DATA_DIR + 'openings.json');
    const reps = [];
    for (const r of Array.isArray(o?.repertoires) ? o.repertoires : []) {
      try { reps.push(prepRepertoire(r)); } catch (e) { /* 單套壞掉就略過 */ }
    }
    state.openings = reps.length ? reps : null;
  } catch (e) { state.openings = null; }
  try {
    const lj = await getJson(DATA_DIR + 'learn.json');
    state.learnData = lj && Array.isArray(lj.levels) && lj.levels.length && lj.repertoires && typeof lj.repertoires === 'object' ? lj : null;
  } catch (e) { state.learnData = null; }
}

const SVG = (d, extra = '') => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${extra}>${d}</svg>`;
const ICON = {
  filter: SVG('<path d="M4 6h16"/><path d="M7 12h10"/><path d="M10 18h4"/>'),
  close: SVG('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
  first: SVG('<path d="M6 5v14"/><path d="M18 6l-7 6 7 6"/>'),
  prev: SVG('<path d="M15 6l-6 6 6 6"/>'),
  next: SVG('<path d="M9 6l6 6-6 6"/>'),
  play: SVG('<path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none"/>'),
};

// 「你執白／你執黑」標籤
function sideChip(color) {
  const b = color === 'black';
  return `<span class="side ${b ? 'b' : 'w'}"><img src="vendor/pieces/${b ? 'b' : 'w'}K.svg" alt="">你執${b ? '黑' : '白'}</span>`;
}

// 棋盤＋左側評估條
function boardRowHtml() {
  const bar = store.getSettings().evalbar
    ? '<div class="evalbar pending" id="evalbar" aria-label="局面評估"><div class="fill"></div><span class="ev"></span></div>' : '';
  return `<div class="bwrap">${bar}<div id="board" class="board-wrap"></div></div>`;
}

// right：標題列右邊的額外內容（HTML）
function setTitle(text, back, right = '') {
  $title.innerHTML = (back ? `<a class="back" href="${esc(back)}" aria-label="返回">‹</a>` : '') + esc(text) + (MOCK ? ' <small>（測試資料）</small>' : '')
    + (right ? `<span class="tright">${right}</span>` : '');
}

function dueCount() {
  const now = Date.now();
  return state.puzzles.filter(p => store.isDue(p.id, now)).length;
}

/* ---------- 路由 ---------- */

// 手機上的棋盤頁不捲動：量出頂列與分頁列之間的高度給 CSS 用
function updateFitH() {
  const top = document.querySelector('.topbar');
  const tab = document.querySelector('.tabbar');
  const h = window.innerHeight - (top ? top.offsetHeight : 0) - (tab ? tab.offsetHeight : 0);
  document.documentElement.style.setProperty('--fit-h', Math.max(300, h) + 'px');
}
window.addEventListener('resize', updateFitH);
window.addEventListener('orientationchange', () => setTimeout(updateFitH, 200));

function route() {
  stopTimer();
  closeSheet();
  engine.stop();
  cleanupOverview();
  state.evalFen = null;
  state.learn = null;
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const page = parts[0] || 'overview';
  document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('on', a.dataset.tab === (page === 'learn' ? 'openings' : page)));
  window.scrollTo(0, 0);
  const isDrill = page === 'openings' && parts[1] === 'drill';
  if (!isDrill || parts[2] === undefined) state.drill = null;
  const isLearn = page === 'learn';
  const learnBoard = isLearn && parts[1] !== undefined &&
    ((parts[2] === 'review' && parts[3] === undefined) || ['new', 'review', 'browse', 'from'].includes(parts[3]));
  const boardPage = page === 'practice' || (isDrill && parts[2] !== undefined) || learnBoard;
  $view.classList.toggle('wide', boardPage);
  $view.classList.toggle('ovpage', page === 'overview' || page === '');
  document.body.classList.toggle('fit', boardPage);
  updateFitH();
  try {
    if (isLearn) {
      const rid = parts[1] !== undefined ? decodeURIComponent(parts[1]) : null;
      if (rid === null) pageLearnList();
      else if (parts[2] === undefined) pageLearnRep(rid);
      else if (parts[2] === 'review' && parts[3] === undefined) learnSession(rid, null, 'review');
      else if (parts[3] === undefined) pageLearnChapter(rid, decodeURIComponent(parts[2]));
      else if (learnBoard) learnSession(rid, decodeURIComponent(parts[2]), parts[3], parts[4] !== undefined ? decodeURIComponent(parts[4]) : '');
      else pageLearnList();
    }
    else if (isDrill && parts[2] !== undefined) pageDrill(decodeURIComponent(parts[2]));
    else if (isDrill) pageDrillList();
    else if (page === 'openings' && parts[1] !== undefined) pageOpeningDetail(Number(parts[1]));
    else if (page === 'openings') pageOpenings();
    else if (page === 'practice') pagePractice();
    else if (page === 'settings') pageSettings();
    else pageOverview();
  } catch (e) {
    setTitle('Tactix');
    $view.innerHTML = `<div class="card"><p>頁面出了問題，請回到總覽再試一次。</p><a class="btn" href="#/overview">回總覽</a></div>`;
    console.error(e);
  }
}

/* ---------- 總覽 ---------- */

function noData(what) {
  return `<div class="card empty"><p>讀不到${esc(what)}。</p><p class="muted small">請先在電腦執行 analyze.py，或連上網路後重新開啟。</p></div>`;
}

function pageOverview() {
  setTitle('Tactix');
  const r = state.report;
  if (!r && !state.stats) { $view.innerHTML = noData('分析報告'); return; }
  const missed = new Map(), allowed = new Map();
  for (const p of state.puzzles) {
    for (const m of p.motifs) missed.set(m, (missed.get(m) || 0) + 1);
    for (const m of p.allowed) allowed.set(m, (allowed.get(m) || 0) + 1);
  }
  renderOverview($view, { report: r, stats: state.stats, due: dueCount(), CAT, PHASE, fmtDate, motifs: { missed, allowed, total: state.puzzles.length } });
}

/* ---------- 開局 ---------- */

function openingRow(o, idx) {
  const zh = zhOpening(o.family || o.name);
  return `<a class="row chev" href="#/openings/${idx}">
    <div class="l"><div>${esc(o.name)}</div>${zh ? `<div class="small muted">${esc(zh)}</div>` : ''}</div>
    <div class="r"><b>得分率 ${pct((Number(o.score) || 0) * 100)}</b><div>${Number(o.games) || 0} 局 · 第10回合勝率 ${o.avg_wp_after_move10 == null ? '—' : pct(Number(o.avg_wp_after_move10))}</div></div></a>`;
}

function colorSection(title, list) {
  const big = list.filter(x => (Number(x.o.games) || 0) >= 3).sort((a, b) => b.o.games - a.o.games);
  const small = list.filter(x => (Number(x.o.games) || 0) < 3).sort((a, b) => b.o.games - a.o.games);
  let h = `<h2>${esc(title)}</h2>`;
  if (!list.length) return h + '<p class="muted">沒有資料。</p>';
  h += big.map(x => openingRow(x.o, x.i)).join('');
  if (small.length) {
    const g = small.reduce((a, x) => a + x.o.games, 0);
    const sc = small.reduce((a, x) => a + (Number(x.o.score) || 0) * x.o.games, 0) / g;
    h += `<details class="other"><summary><span>其他（${small.length} 種，不足 3 局）</span><span class="small muted">${g} 局 · 得分率 ${pct(sc * 100)}</span></summary>
      ${small.map(x => openingRow(x.o, x.i)).join('')}</details>`;
  }
  return h;
}

function pageOpenings() {
  setTitle('開局');
  const r = state.report;
  let learnEntry = '';
  if (state.openings && state.learnData) {
    const n = learnDueTotal();
    learnEntry = `<a class="row chev" href="#/learn">
    <div class="l"><div>學習模式</div><div class="small muted">分章學習常見分支，逐級加深</div></div>${n ? `<div class="r"><b>${n}</b><div>到期</div></div>` : ''}</a>`;
  }
  const entry = learnEntry + `<a class="row chev" href="#/openings/drill">
    <div class="l"><div>從頭練</div><div class="small muted">從第一步開始，練一整套開局</div></div></a>`;
  if (!r || !Array.isArray(r.openings)) { $view.innerHTML = entry + noData('開局資料'); return; }
  const all = r.openings.map((o, i) => ({ o, i }));
  $view.innerHTML = entry + colorSection('執白', all.filter(x => x.o.color === 'white')) +
    colorSection('執黑', all.filter(x => x.o.color === 'black'));
}

function mistakePuzzle(o, m) {
  const g = new Chess(m.fen);
  const key = String(m.fen).split(' ').slice(0, 4).join(' ');
  return prepPuzzle({
    id: `om:${key}|${m.better_san}`,
    fen: m.fen,
    color: g.turn() === 'w' ? 'white' : 'black',
    played_san: m.san,
    best_san: m.better_san,
    best_line_san: [m.better_san],
    accept_san: [m.better_san],
    category: null,
    tags: [],
    explanation: `你在第 ${m.move_no} 手常走 ${m.san}，已出現 ${m.count} 次。更好的是 ${m.better_san}。`,
    move_no: m.move_no,
    opening: o.name,
  });
}

function pageOpeningDetail(idx) {
  const o = state.report?.openings?.[idx];
  if (!o) { setTitle('開局', '#/openings'); $view.innerHTML = noData('這個開局'); return; }
  setTitle('開局', '#/openings');
  const g = Number(o.games) || 0, w = Number(o.win) || 0, d = Number(o.draw) || 0, l = Number(o.loss) || 0;
  const related = state.puzzles.filter(p => p.opening === o.name).length;
  const zh = zhOpening(o.family || o.name);
  const ms = Array.isArray(o.common_mistakes) ? o.common_mistakes : [];
  $view.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">${esc(o.name)}</h3>
      <div class="small muted">${zh ? esc(zh) + '　' : ''}${o.color === 'white' ? '執白' : '執黑'}</div>
      <div class="grid3" style="margin-top:8px">
        <div class="stat"><b>${g}</b><span>局數</span></div>
        <div class="stat"><b>${pct((Number(o.score) || 0) * 100)}</b><span>得分率</span></div>
        <div class="stat"><b>${o.avg_wp_after_move10 == null ? '—' : pct(Number(o.avg_wp_after_move10))}</b><span>第10回合勝率</span></div>
      </div>
      <div class="wdl"><i class="w" style="width:${g ? w / g * 100 : 0}%"></i><i class="d" style="width:${g ? d / g * 100 : 0}%"></i><i class="l" style="width:${g ? l / g * 100 : 0}%"></i></div>
      <div class="small muted">勝 ${w}　和 ${d}　負 ${l}${o.first_blunder_move_avg ? `　｜　第一個漏著平均在第 ${Number(o.first_blunder_move_avg).toFixed(1)} 手` : ''}</div>
      ${related ? `<div class="btns"><button class="btn primary grow" id="pr-all">練習這個開局的 ${related} 題</button></div>` : ''}
    </div>
    <h2>常犯錯誤</h2>
    ${ms.length ? '' : '<p class="muted">還沒有重複出現的錯誤。</p>'}
    <div id="ms"></div>`;
  const box = document.getElementById('ms');
  ms.forEach((m, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="board-slot"></div>
      <p>第 ${Number(m.move_no)} 手，你常走 <b>${esc(m.san)}</b>，更好的是 <b>${esc(m.better_san)}</b>。<br><span class="small muted">共出現 ${Number(m.count)} 次</span></p>
      <div class="btns"><button class="btn primary grow">練習這一題</button></div>`;
    box.appendChild(card);
    try {
      renderBoard(card.querySelector('.board-slot'), { fen: m.fen, orientation: o.color, mini: true });
    } catch (e) { /* 單張圖失敗不影響整頁 */ }
    card.querySelector('button').addEventListener('click', () => {
      try {
        state.forced = [mistakePuzzle(o, m)];
        location.hash = '#/practice';
      } catch (e) { alert('這個局面讀不出來。'); }
    });
  });
  const all = document.getElementById('pr-all');
  if (all) all.addEventListener('click', () => {
    state.filter = { category: '', opening: o.name, openingOnly: false, motif: '' };
    state.extra = false;
    state.forced = [];
    state.cur = null;
    location.hash = '#/practice';
  });
}

/* ---------- 練習 ---------- */

function filtered() {
  const f = state.filter;
  return state.puzzles.filter(p =>
    (!f.category || p.category === f.category) &&
    (!f.motif || p.motifs.includes(f.motif)) &&
    (!f.opening || p.opening === f.opening) &&
    (!f.openingOnly || p.tags.includes('opening') || Number(p.move_no) <= 10));
}

function pickNext() {
  if (state.forced.length) return state.forced.shift();
  const now = Date.now();
  const pool = filtered();
  const rank = p => store.get(p.id)?.due ?? 0;
  let cand = pool.filter(p => store.isDue(p.id, now));
  if (!cand.length && state.extra) cand = pool.slice();
  if (!cand.length) return null;
  const rnd = new Map(cand.map(p => [p.id, Math.random()]));
  // 已練過且到期的先出，再來沒做過的；同樣的隨機
  cand.sort((a, b) => {
    const sa = store.get(a.id) ? 0 : 1, sb = store.get(b.id) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    if (sa === 0 && rank(a) !== rank(b)) return rank(a) - rank(b);
    return rnd.get(a.id) - rnd.get(b.id);
  });
  return cand.find(p => p.id !== state.lastId) || cand[0];
}

function nextDueText() {
  const pool = filtered();
  const ts = pool.map(p => store.get(p.id)?.due).filter(x => x > Date.now());
  if (!ts.length) return '';
  const days = Math.max(1, Math.ceil((Math.min(...ts) - Date.now()) / 86400000));
  return `下一題最快 ${days} 天後到期。`;
}

function motifCounts() {
  const c = new Map();
  for (const p of state.puzzles) for (const m of p.motifs) c.set(m, (c.get(m) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]);
}

function filterOn() {
  const f = state.filter;
  return !!(f.category || f.opening || f.openingOnly || f.motif);
}

function closeSheet() {
  document.querySelectorAll('.sheet-scrim').forEach(x => x.remove());
}

// 篩選面板：從底部滑出，點背景、×、完成都會關
function openFilter() {
  closeSheet();
  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim';
  scrim.innerHTML = `<div class="sheet" role="dialog" aria-label="篩選">
    <div class="sheet-head"><b>篩選</b><button class="iconbtn" id="f-x" aria-label="關閉">${ICON.close}</button></div>
    ${filterBlock()}
    <div class="btns"><button class="btn grow" id="f-reset">重設</button><button class="btn primary grow" id="f-done">完成</button></div>
  </div>`;
  document.body.appendChild(scrim);
  const cat = scrim.querySelector('#f-cat'), op = scrim.querySelector('#f-op'), oo = scrim.querySelector('#f-open'), mo = scrim.querySelector('#f-mot');
  scrim.addEventListener('click', e => { if (e.target === scrim) closeSheet(); });
  scrim.querySelector('#f-x').addEventListener('click', closeSheet);
  scrim.querySelector('#f-reset').addEventListener('click', () => { cat.value = ''; op.value = ''; mo.value = ''; oo.checked = false; });
  scrim.querySelector('#f-done').addEventListener('click', () => {
    const nf = { category: cat.value, opening: op.value, openingOnly: oo.checked, motif: mo.value };
    const f = state.filter;
    closeSheet();
    if (nf.category === f.category && nf.opening === f.opening && nf.openingOnly === !!f.openingOnly && nf.motif === (f.motif || '')) return;
    state.filter = nf;
    state.extra = false;
    state.cur = null;
    state.forced = [];
    pagePractice();
  });
}

function practiceTitle() {
  const n = dueCount();
  setTitle('練習', null, `<span class="due">今天 ${n} 題${state.forced.length ? '＋指定' : ''}</span>`
    + `<button class="iconbtn" id="fbtn" aria-label="篩選">${ICON.filter}${filterOn() ? '<i class="badge"></i>' : ''}</button>`);
  const b = document.getElementById('fbtn');
  if (b) b.addEventListener('click', openFilter);
}

function filterBlock() {
  const ops = [...new Set(state.puzzles.map(p => p.opening).filter(Boolean))].sort();
  const f = state.filter;
  return `<div class="filters">
    <label for="f-cat">漏著類型</label>
    <select id="f-cat"><option value="">全部</option>${Object.entries(CAT).map(([k, v]) => `<option value="${k}"${f.category === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
    <label for="f-mot">戰術</label>
    <select id="f-mot"><option value="">全部</option>${motifCounts().map(([m, n]) => `<option value="${esc(m)}"${f.motif === m ? ' selected' : ''}>${esc(m)}（${n}）</option>`).join('')}</select>
    <label for="f-op">開局</label>
    <select id="f-op"><option value="">全部</option>${ops.map(o => `<option value="${esc(o)}"${f.opening === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>
    <label class="check"><input type="checkbox" id="f-open"${f.openingOnly ? ' checked' : ''}> 只看開局階段（前 10 手）</label>
  </div>`;
}

function pagePractice() {
  setTitle('練習');
  if (state.puzzlesError) { $view.innerHTML = noData('題目'); return; }
  if (!state.puzzles.length && !state.forced.length) {
    $view.innerHTML = noData('題目（目前沒有題目）');
    return;
  }
  const c = state.cur;
  if (c && !c.done && !state.forced.length) {
    // 回到練習頁時沿用同一題；若剛好在動畫中被打斷，退回這一步的起點
    if (c.busy) { rewind(c); c.busy = false; c.status = ''; c.msg = null; c.hl = hintSquares(c); }
  } else {
    state.cur = null;
  }
  $view.innerHTML = `<div class="split" id="split">
    <div class="split-board" id="bcol"></div>
    <div class="split-info"><div id="pz"></div></div></div>`;
  practiceTitle();
  if (!state.cur) nextPuzzle(); else drawPuzzle();
}

function nextPuzzle() {
  stopTimer();
  const p = pickNext();
  const host = document.getElementById('pz');
  const split = document.getElementById('split');
  if (!p) {
    state.cur = null;
    state.board = null;
    document.getElementById('bcol').innerHTML = '';
    split.classList.add('solo');
    const total = filtered().length;
    host.innerHTML = `<div class="card empty">
      <h3>${total ? '今日題目已完成' : '無符合條件的題目'}</h3>
      <p class="muted">${total ? esc(nextDueText()) : '請放寬篩選條件。'}</p>
      ${total ? '<div class="btns" style="justify-content:center"><button class="btn primary" id="more">加練</button></div>' : ''}</div>`;
    const more = document.getElementById('more');
    if (more) more.addEventListener('click', () => { state.extra = true; nextPuzzle(); });
    return;
  }
  split.classList.remove('solo');
  state.lastId = p.id;
  const qs = p._steps;
  state.cur = {
    kind: 'puzzle',
    puzzle: p,
    qs,
    idx: 0,
    q: qs[0],
    legacy: p._legacy,
    orientation: p.color === 'black' ? 'black' : 'white',
    game: new Chess(qs[0].fen),
    base: 0,
    last: p._prev ? p._prev.last : null,
    baseLast: p._prev ? p._prev.last : null,   // 這一步開始時要標示的「對手上一步」
    intro: !!p._prev,  // 還沒播過對手上一步
    hl: [],
    errs: 0,           // 這一步答錯幾次
    revealed: false,   // 這一步答案是否已經顯示
    busy: false,       // 動畫進行中，不能走子
    done: false,
    status: '',
    failed: false,     // 整題有沒有答錯／看答案（影響間隔重複）
    msg: null,
    rec: null,
    retried: false,
    lineIdx: null,
    lineFens: null,
    afterRight: puzzleRight,
  };
  drawPuzzle();
}

function lineFens(p) {
  const g = new Chess(p.fen);
  const arr = [{ fen: g.fen(), last: p._prev ? p._prev.last : null }];
  for (const s of p.best_line_san) {
    try {
      const m = g.move(s);
      arr.push({ fen: g.fen(), last: { from: m.from, to: m.to } });
    } catch (e) { break; }
  }
  return arr;
}

function fmtLine(p, cur) {
  const parts = p.fen.split(' ');
  let turn = parts[1];
  let n = parseInt(parts[5], 10) || 1;
  const out = [];
  p.best_line_san.forEach((s, i) => {
    let t;
    if (turn === 'w') t = `${n}.${s}`;
    else t = i === 0 ? `${n}…${s}` : s;
    out.push(`<span class="${cur === i ? 'cur' : ''}">${esc(t)}</span>`);
    if (turn === 'b') n++;
    turn = turn === 'w' ? 'b' : 'w';
  });
  return out.join(' ');
}

function moveLabel(p, san) {
  const n = Number(p.move_no) || 1;
  return p.color === 'black' ? `${n}…${san}` : `${n}.${san}`;
}

function drawPuzzle() {
  const c = state.cur;
  const p = c.puzzle;
  document.getElementById('split').classList.remove('solo');
  document.getElementById('bcol').innerHTML = `
    <div class="turn">${sideChip(p.color)}<span>找出最佳著</span></div>
    ${boardRowHtml()}`;
  state.evalFen = null;
  if (store.getSettings().evalbar) engine.warm();
  document.getElementById('pz').innerHTML = `<div id="panel"></div>`;
  practiceTitle();
  state.board = new Board(document.getElementById('board'));
  if (c.intro && c.idx === 0 && !c.done) {
    // 先擺出對手走之前的局面，再把對手那一步滑過去
    c.intro = false;
    c.game = new Chess(p._prev.fen);
    c.last = null;
    c.busy = true;
    updateBoard(c);
    updatePanel(c);
    later(c, 450, () => {
      c.game = new Chess(c.q.fen);
      c.last = c.baseLast;
      c.busy = false;
      updateBoard(c, { animate: true });
      audio.play(p._prev.cap ? 'capture' : 'move');
      updatePanel(c);
    });
    return;
  }
  updateBoard(c);
  updatePanel(c);
}

/* ---------- 出題共用流程（練習題與「從頭練」都用）----------
   s 是一場練習，必備欄位：
   kind, q（目前的問題）, game, base（這題起點的步數）, last, hl, errs, revealed,
   busy, done, status, failed, msg, orientation, afterRight(s, mv, kind) */

const DEFAULT_HINT = '先看看對方有什麼威脅，再找有沒有吃子或將軍的機會。';

function alive(s) {
  return (state.cur === s || state.drill === s || state.learn === s) && !!state.board && document.body.contains(state.board.host);
}

// 排程一個動作；離開頁面時 stopTimer 會全部取消
function later(s, ms, fn) {
  state.tmos.push(setTimeout(() => { if (alive(s)) fn(); }, ms));
}

function kingSquare(g, color) {
  for (const row of g.board()) {
    for (const x of row) if (x && x.type === 'k' && x.color === color) return x.square;
  }
  return null;
}

// o.animate：這次更新要不要讓棋子滑過去
function updateBoard(s, o = {}) {
  if (!s || !state.board) return;
  const ex = s.explore;
  let fen = ex ? ex.game.fen() : s.game.fen(), last = ex ? ex.last : s.last;
  if (!ex && s.lineIdx != null && s.lineFens) {
    const x = s.lineFens[s.lineIdx];
    fen = x.fen; last = x.last;
  }
  let check = null;
  try {
    const g = new Chess(fen);
    if (g.inCheck()) check = kingSquare(g, g.turn());
  } catch (e) { check = null; }
  state.board.set({
    fen,
    orientation: s.orientation,
    last,
    check,
    hl: ex ? ex.hl : s.hl,
    status: ex ? '' : s.status,
    interactive: ex ? !ex.game.isGameOver() : (!!s.q && !s.busy && !s.done),
    turn: (ex ? ex.game : s.game).turn(),
    legal: sq => (ex ? ex.game : s.game).moves({ square: sq, verbose: true }),
    onMove: ex ? (from, to, promo) => exploreMove(s, from, to, promo)
      : s.onMove ? (from, to, promo) => s.onMove(s, from, to, promo)
      : (from, to, promo) => onUserMove(s, from, to, promo),
    arrows: ex ? null : (s.arrows || null),
    animate: !!o.animate,
  });
  refreshEval(s, fen);
}

/* ---------- 評估條 ---------- */

const evalCache = new Map();   // fen -> 引擎算完的結果

function cpFromWp(wp) {
  const w = Math.max(0.5, Math.min(99.5, wp));
  return -Math.log(100 / w - 1) / 0.00368208;
}

// 事先算好的評估（題目各步、開局我方節點）：回傳白方勝率，沒有就回 null
function precomputedWp(s, fen) {
  const k = T.fen4(fen);
  const white = fen.split(' ')[1] === 'w';
  const best = map => {
    const v = Object.values(map || {}).map(Number).filter(Number.isFinite);
    return v.length ? Math.max(...v) : null;
  };
  let b = null;
  if (s.kind === 'puzzle') {
    for (const q of s.qs || []) if (T.fen4(q.fen) === k) { b = best(q.moves); break; }
  } else if (s.rep) {
    const node = s.rep.nodes[k];
    if (node && node.me) b = best(node.accept);
  }
  return b == null ? null : (white ? b : 100 - b);
}

function paintEval(s, r) {
  const bar = document.getElementById('evalbar');
  if (!bar) return;
  bar.classList.remove('pending');
  bar.classList.toggle('flip', s.orientation === 'black');
  const w = Math.max(0, Math.min(100, r.wpWhite));
  bar.querySelector('.fill').style.height = w + '%';
  let txt, whiteAhead;
  if (r.mate != null) {
    txt = r.mate === 0 ? '#' : 'M' + Math.abs(r.mate);
    whiteAhead = r.mate === 0 ? w > 50 : r.mate > 0;
  } else {
    const p = Math.abs(r.cp) / 100;
    txt = p >= 10 ? String(Math.round(p)) : p.toFixed(1);
    whiteAhead = r.cp >= 0;
  }
  const lab = bar.querySelector('.ev');
  lab.textContent = txt;
  lab.className = 'ev ' + (whiteAhead ? 'w' : 'b');
  bar.setAttribute('aria-label', `局面評估：${whiteAhead ? '白方' : '黑方'}優 ${txt}`);
}

function refreshEval(s, fen) {
  if (!document.getElementById('evalbar')) return;
  if (state.evalFen === fen) return;
  state.evalFen = fen;
  state.evalBest = null;
  let g;
  try { g = new Chess(fen); } catch (e) { return; }
  if (g.isCheckmate()) { paintEval(s, { wpWhite: g.turn() === 'w' ? 0 : 100, mate: 0 }); return; }
  if (g.isDraw()) { paintEval(s, { wpWhite: 50, cp: 0 }); return; }
  const hit = evalCache.get(fen);
  if (hit) {
    paintEval(s, hit);
    state.evalBest = { fen, best: hit.best };
    maybeShowBest(s);
    return;
  }
  const pre = precomputedWp(s, fen);
  if (pre != null) paintEval(s, { wpWhite: pre, cp: cpFromWp(pre) });
  else document.getElementById('evalbar').classList.add('pending');
  if (!engine.available()) return;
  engine.analyze(fen, r => {
    if (state.evalFen !== fen) return;
    if (r.best) state.evalBest = { fen, best: r.best };
    if (r.depth >= 6 || r.done) paintEval(s, r);
    if (r.done) evalCache.set(fen, r);
    maybeShowBest(s);
  });
}

/* ---------- 自己推演 ---------- */

function startExplore(s) {
  stopTimer();
  const fromLine = !!(s.lineIdx != null && s.lineFens);
  const fen = fromLine ? s.lineFens[s.lineIdx].fen : s.game.fen();
  const last = fromLine ? s.lineFens[s.lineIdx].last : s.last;
  s.explore = { game: new Chess(fen), last, hl: [], startFen: fen, startLast: last, wantBest: false };
  engine.warm();
  updateBoard(s);
  updatePanel(s);
}

function exploreMove(s, from, to, promo) {
  const ex = s.explore;
  if (!ex) return;
  let mv;
  try { mv = ex.game.move({ from, to, promotion: promo || 'q' }); } catch (e) { return; }
  ex.last = { from: mv.from, to: mv.to };
  ex.hl = [];
  ex.wantBest = false;
  audio.play(mv.captured ? 'capture' : 'move');
  updateBoard(s, { animate: true });
  updatePanel(s);
}

// 使用者按了「最佳著」：引擎有結果就標出來
function maybeShowBest(s) {
  const ex = s && s.explore;
  if (!ex || !ex.wantBest) return;
  const b = state.evalBest;
  if (!b || b.fen !== ex.game.fen() || !b.best || b.best === '(none)') return;
  ex.hl = [b.best.slice(0, 2), b.best.slice(2, 4)];
  ex.wantBest = false;
  if (state.board) updateBoard(s);
  updatePanel(s);
}

function fmtMoves(startFen, sans) {
  const parts = startFen.split(' ');
  let white = parts[1] === 'w';
  let n = parseInt(parts[5], 10) || 1;
  const out = [];
  sans.forEach((m, i) => {
    if (white) out.push(`${n}.${m}`);
    else { out.push(i === 0 ? `${n}…${m}` : m); n++; }
    white = !white;
  });
  return out.join(' ');
}

function explorePanel(s) {
  const el = document.getElementById('panel');
  if (!el) return;
  const ex = s.explore;
  const hist = ex.game.history();
  const noEngine = !engine.available();
  const g = ex.game;
  const end = g.isCheckmate() ? '將死' : g.isStalemate() ? '逼和' : g.isDraw() ? '和棋' : '';
  el.innerHTML = `
    <div class="result info"><h3>分析</h3>
      <p>雙方皆可走子。${end ? `<b>${end}</b>` : ''}</p>
      ${noEngine ? '<p class="small muted">引擎未載入，無評估。</p>' : ''}</div>
    <div class="line small movelist">${hist.length ? esc(fmtMoves(ex.startFen, hist)) : '—'}</div>
    <div class="actions">
      <div class="btns">
        <button class="btn icon" id="x-reset" aria-label="回到起點"${hist.length ? '' : ' disabled'}>${ICON.first}</button>
        <button class="btn icon" id="x-undo" aria-label="上一步"${hist.length ? '' : ' disabled'}>${ICON.prev}</button>
        <button class="btn grow" id="x-best"${noEngine || end ? ' disabled' : ''}>${ex.wantBest ? '計算中…' : '最佳著'}</button>
      </div>
      <div class="btns"><button class="btn primary grow" id="x-end">結束</button></div>
    </div>`;
  document.getElementById('x-reset').addEventListener('click', () => {
    ex.game = new Chess(ex.startFen); ex.last = ex.startLast; ex.hl = []; ex.wantBest = false;
    updateBoard(s); updatePanel(s);
  });
  document.getElementById('x-undo').addEventListener('click', () => {
    ex.game.undo();
    const h = ex.game.history({ verbose: true });
    ex.last = h.length ? { from: h[h.length - 1].from, to: h[h.length - 1].to } : ex.startLast;
    ex.hl = []; ex.wantBest = false;
    updateBoard(s); updatePanel(s);
  });
  document.getElementById('x-best').addEventListener('click', () => {
    ex.wantBest = true;
    updatePanel(s);
    maybeShowBest(s);
  });
  document.getElementById('x-end').addEventListener('click', () => {
    s.explore = null;
    updateBoard(s);
    updatePanel(s);
  });
}

function playMove(s, san) {
  try {
    const r = s.game.move(san);
    s.last = { from: r.from, to: r.to };
    audio.play(r.captured ? 'capture' : 'move');
  } catch (e) { return false; }
  updateBoard(s, { animate: true });
  if (s.kind === 'drill' || s.kind === 'learn') updatePanel(s);   // 走法記錄要跟著更新
  return true;
}

// 退回這一題的起點（把這一題之後走的著都收回）
function rewind(s) {
  while (s.game.history().length > s.base) s.game.undo();
  s.last = s.baseLast || null;
}

function recId(s) { return s.kind === 'puzzle' ? s.puzzle.id : s.nodeId; }

// 第一次失誤（答錯、看答案）時，把這題打回第 1 盒
function markFailed(s) {
  if (s.failed) return;
  s.failed = true;
  if (!s.retried) s.rec = store.record(recId(s), false);
}

function hintSquares(s) {
  if (!s.q) return [];
  const sq = T.bestSquares(s.q);
  if (!sq) return [];
  if (s.revealed) return [sq.from, sq.to];
  if (s.errs >= 2) return [sq.from];
  return [];
}

function onUserMove(s, from, to, promo) {
  if (!s || s.busy || s.done || !s.q) return;
  let mv;
  try { mv = s.game.move({ from, to, promotion: promo || 'q' }); } catch (e) { return; }
  s.last = { from: mv.from, to: mv.to };
  s.hl = [];
  audio.play(mv.captured ? 'capture' : 'move');
  const kind = T.classify(s.q, mv.san);
  if (kind === 'wrong') wrongMove(s, mv);
  else rightMove(s, mv, kind);
}

// 答錯：先讓使用者的棋子走過去，再走出對方的應著，顯示講解，0.8 秒後退回。
function wrongMove(s, mv) {
  const q = s.q;
  s.errs++;
  markFailed(s);
  s.busy = true;
  s.status = 'bad';
  if (s.errs >= 3) s.revealed = true;     // 第 3 次錯：顯示答案
  const offBook = s.kind === 'drill' && (q.okAlts || []).some(a => norm(a) === norm(mv.san));
  let why = s.legacy || offBook ? '' : T.whyText(q, mv.san);
  if (!why && s.kind === 'drill') why = '這不是這套開局要練的走法。';
  s.msg = offBook
    ? { kind: 'bad', title: `${mv.san}：非主線`, text: '可下，但不在本套開局。' }
    : { kind: 'bad', title: `${mv.san}?`, text: why };
  const reply = s.legacy || offBook ? null : T.pickReply(q, mv.san, s.game.fen());
  updateBoard(s, { animate: true });
  updatePanel(s, true);
  let t = 800;
  if (reply) {
    later(s, 550, () => playMove(s, reply));
    t = 550 + 800;
  }
  later(s, t, () => {
    rewind(s);
    s.busy = false;
    s.status = '';
    s.hl = hintSquares(s);
    updateBoard(s);
    updatePanel(s);
  });
}

function rightMove(s, mv, kind) {
  s.busy = true;
  s.status = 'ok';
  s.hl = [];
  s.msg = kind === 'best'
    ? { kind: 'ok', title: '正確', text: '' }
    : { kind: 'ok', title: '可行', text: `最佳著：${s.q.best}` };
  s.afterRight(s, mv, kind);
}

function giveUp(s) {
  if (s.busy || s.done || !s.q || s.revealed) return;
  markFailed(s);
  s.revealed = true;
  s.hl = hintSquares(s);
  s.msg = { kind: 'info', title: '解答', text: `${s.q.best}，請走一次。` };
  updateBoard(s);
  updatePanel(s, true);
}

function msgHtml(m) {
  if (!m) return '';
  return `<div class="result ${m.kind}"><h3>${esc(m.title)}</h3>${m.text ? `<p>${esc(m.text)}</p>` : ''}</div>`;
}

// 提示階梯：錯 1 次→文字提示；錯 2 次→標出要動的棋子；錯 3 次或看答案→顯示答案
function hintHtml(s) {
  if (!s.q || s.done) return '';
  const q = s.q;
  const parts = [];
  if (s.errs >= 1) parts.push(`<div>提示：${esc(q.hint || DEFAULT_HINT)}</div>`);
  if (s.revealed) parts.push(`<div>藍框是起點和終點。答案：<b>${esc(q.best)}</b></div>`);
  else if (s.errs >= 2) parts.push('<div>藍框是要動的那顆棋子。</div>');
  return parts.length ? `<div class="hintbox">${parts.join('')}</div>` : '';
}

function recText(rec) {
  if (!rec) return '';
  let t;
  if (rec.box > rec.from) t = `第 ${rec.box} 盒・${rec.days} 天後複習`;
  else if (rec.box === rec.from && rec.box === 5) t = `第 5 盒・${rec.days} 天後複習`;
  else t = '第 1 盒・稍後再出';
  if (!rec.saved) t += '（進度未儲存）';
  return t;
}

function updatePanel(s, scroll = false) {
  if (s.explore) explorePanel(s);
  else if (s.kind === 'puzzle') puzzlePanel(s);
  else if (s.kind === 'learn') learnPanel(s);
  else drillPanel(s);
}

/* ---------- 練習題（多步）---------- */

function puzzleRight(c, mv, kind) {
  const q = c.q;
  const next = c.qs[c.idx + 1];
  if (!next) { finishPuzzle(c); return; }
  updateBoard(c, { animate: true });
  updatePanel(c, true);
  let t = 650;
  if (kind === 'alt') {
    // 走的不是最佳著：先讓使用者看清楚自己的走法，再把棋子滑回去、改走最佳著，後面的局面才對得上
    c.msg = { kind: 'ok', title: '可行', text: `最佳著：${q.best}，以此續行。` };
    updatePanel(c);
    t = 1400;
    later(c, t, () => {
      rewind(c);
      c.last = { from: mv.to, to: mv.from };
      updateBoard(c, { animate: true });
    });
    later(c, t + 450, () => playMove(c, q.best));
    t += 450 + 750;
  }
  if (q.reply) later(c, t, () => playMove(c, q.reply));
  later(c, t + 700, () => startStep(c, c.idx + 1));
}

function startStep(c, i) {
  c.idx = i;
  c.q = c.qs[i];
  c.game = new Chess(c.q.fen);   // 局面與剛才相同，只是換成新的起點
  c.base = 0;
  c.baseLast = i === 0 ? (c.puzzle._prev ? c.puzzle._prev.last : null) : c.last;
  c.last = c.baseLast;
  c.errs = 0;
  c.revealed = false;
  c.busy = false;
  c.status = '';
  c.hl = [];
  c.msg = i === 0 ? null : { kind: 'info', title: `第 ${i + 1} 步`, text: '' };
  updateBoard(c);
  updatePanel(c, true);
}

function finishPuzzle(c) {
  c.done = true;
  c.busy = false;
  c.hl = [];
  c.status = c.failed ? '' : 'ok';
  if (!c.failed && !c.retried) c.rec = store.record(c.puzzle.id, true);
  c.lineFens = lineFens(c.puzzle);
  c.lineIdx = null;
  updateBoard(c, { animate: true });
  updatePanel(c, true);
}

function puzzlePanel(c) {
  const p = c.puzzle;
  const el = document.getElementById('panel');
  if (!el) return;
  if (!c.done) {
    const total = c.qs.length;
    el.innerHTML = `
      ${total > 1 ? `<div class="stepbar">第 ${c.idx + 1} / ${total} 步</div>` : ''}
      ${msgHtml(c.msg)}
      ${hintHtml(c)}
      <div class="btns actions"><button class="btn grow" id="giveup"${c.busy || c.revealed ? ' disabled' : ''}>解答</button></div>`;
    document.getElementById('giveup').addEventListener('click', () => giveUp(c));
    return;
  }
  const ok = !c.failed;
  const tags = p.tags.map(t => `<span class="pill">${esc(TAG[t] || t)}</span>`).join('');
  const meta = `${p.motifs.map(m => `<span class="pill motif">${esc(m)}</span>`).join('')}${p.allowed.filter(m => !p.motifs.includes(m)).map(m => `<span class="pill motif opp">對手 ${esc(m)}</span>`).join('')}${p.category ? `<span class="pill">${esc(CAT[p.category] || p.category)}</span>` : ''}${tags}${p.opening ? `<span class="pill">${esc(p.opening)}</span>` : ''}`;
  const hasLine = c.lineFens && c.lineFens.length > 1;
  const idx = c.lineIdx;
  const link = typeof p.url === 'string' && /^https:\/\//.test(p.url) ? `<a class="small" href="${esc(p.url)}" target="_blank" rel="noopener">chess.com 原局</a>` : '';
  const title = ok ? '正確' : '完成';
  el.innerHTML = `
    <div class="result ${ok ? 'ok' : 'info'}">
      <h3>${title}</h3>
      ${c.msg && c.msg.title === '可行' ? `<div><b>可行</b>　${esc(c.msg.text)}</div>` : ''}
      ${!ok ? '<div>有錯誤或看過解答，之後會再出題。</div>' : ''}
      ${p.played_san ? `<div>實戰：<b>${esc(moveLabel(p, p.played_san))}</b></div>` : ''}
      <div>最佳著：<b>${esc(p.best_san)}</b>${p.accept_san.length > 1 ? `（亦可：${esc(p.accept_san.filter(x => norm(x) !== norm(p.best_san)).join('、'))}）` : ''}</div>
      ${p.explanation ? `<p>${esc(p.explanation)}</p>` : ''}
      <div>${meta}</div>
      <div class="small muted" style="margin-top:6px">${esc(recText(c.rec))}${c.retried ? '（重試不計分）' : ''}</div>
      ${link}
    </div>
    ${hasLine ? `<div class="card"><b>最佳變化</b>
      <div class="line">${fmtLine(p, idx)}</div></div>` : ''}
    <div class="actions">
      ${hasLine ? `<div class="btns">
        <button class="btn icon" id="l-first" aria-label="回到題目局面">${ICON.first}</button>
        <button class="btn icon" id="l-prev" aria-label="上一步">${ICON.prev}</button>
        <button class="btn icon" id="l-next" aria-label="下一步">${ICON.next}</button>
        <button class="btn grow" id="l-play">${ICON.play}播放</button>
      </div>` : ''}
      <div class="btns">
        <button class="btn grow" id="explore">分析</button>
        ${!ok ? '<button class="btn grow" id="retry">重試</button>' : ''}
        <button class="btn primary grow" id="next">下一題</button>
      </div>
    </div>`;
  document.getElementById('explore').addEventListener('click', () => startExplore(c));
  const max = hasLine ? c.lineFens.length - 1 : 0;
  const go = i => {
    const prev = c.lineIdx;
    c.lineIdx = Math.max(0, Math.min(max, i));
    const fwd = prev != null && c.lineIdx === prev + 1;
    updateBoard(c, { animate: fwd });
    if (fwd) audio.play(/x/.test(p.best_line_san[c.lineIdx - 1] || '') ? 'capture' : 'move');
    updatePanel(c);
  };
  if (hasLine) {
    document.getElementById('l-first').addEventListener('click', () => { stopTimer(); go(0); });
    document.getElementById('l-prev').addEventListener('click', () => { stopTimer(); go((c.lineIdx ?? 0) - 1); });
    document.getElementById('l-next').addEventListener('click', () => { stopTimer(); go(c.lineIdx == null ? 0 : c.lineIdx + 1); });
    document.getElementById('l-play').addEventListener('click', () => {
      stopTimer();
      const i = (c.lineIdx === null || c.lineIdx >= max) ? 0 : c.lineIdx;
      go(i);
      state.timer = setInterval(() => {
        if (state.cur !== c || (c.lineIdx ?? 0) >= max) { stopTimer(); return; }
        go((c.lineIdx ?? 0) + 1);
      }, 900);
    });
  }
  const retry = document.getElementById('retry');
  if (retry) retry.addEventListener('click', () => {
    stopTimer();
    c.retried = true;
    c.done = false;
    c.failed = false;
    c.lineIdx = null; c.lineFens = null; c.last = null;
    startStep(c, 0);
  });
  document.getElementById('next').addEventListener('click', nextPuzzle);
}

/* ---------- 從頭練 ---------- */

const NO_OPENINGS = `<div class="card empty"><p>開局資料還沒產生。</p><p class="muted small">請先在電腦執行 build_openings.py。</p></div>`;

function nodeId(rep, key) { return L.nodeId(rep, key); }

function countDue(rep) {
  let n = 0;
  for (const [key, node] of Object.entries(rep.nodes)) if (node && node.me && store.isDue(nodeId(rep, key))) n++;
  return n;
}

function pageDrillList() {
  setTitle('從頭練', '#/openings');
  if (!state.openings) { $view.innerHTML = NO_OPENINGS; return; }
  $view.innerHTML = `<p class="muted small">選一套開局，從第一步開始練。對方會照真實比例出招，你走錯會有提示。</p>` +
    state.openings.map(r => {
      const due = countDue(r);
      return `<a class="row chev" href="#/openings/drill/${encodeURIComponent(r.id)}">
        <div class="l"><div>${esc(r.name)}</div><div class="small muted">${esc(r.summary || '')}</div></div>
        <div class="r"><b>${r.color === 'black' ? '執黑' : '執白'}</b><div>${due} 個局面待複習</div></div></a>`;
    }).join('');
}

function pageDrill(id) {
  setTitle('從頭練', '#/openings/drill');
  const rep = state.openings && state.openings.find(r => r.id === id);
  if (!state.openings) { $view.innerHTML = NO_OPENINGS; return; }
  if (!rep) { $view.innerHTML = `<div class="card empty"><p>找不到這套開局。</p><a class="btn" href="#/openings/drill">回清單</a></div>`; return; }
  stopTimer();
  const s = state.drill = {
    kind: 'drill',
    rep,
    orientation: rep.color,
    game: new Chess(),
    base: 0,
    last: null,
    hl: [],
    errs: 0,
    revealed: false,
    busy: true,
    done: false,
    status: '',
    failed: false,
    q: null,
    nodeId: null,
    msg: null,
    rec: null,
    stats: { me: 0, clean: 0 },
    afterRight: drillRight,
  };
  $view.innerHTML = `<div class="split" id="split">
    <div class="split-board" id="bcol">
      <div class="turn">${sideChip(rep.color)}<span>${esc(rep.name)}</span></div>
      ${boardRowHtml()}
    </div>
    <div class="split-info"><div id="panel"></div></div></div>`;
  state.board = new Board(document.getElementById('board'));
  state.evalFen = null;
  if (store.getSettings().evalbar) engine.warm();
  updateBoard(s);
  updatePanel(s);
  later(s, 500, () => drillAdvance(s));
}

// 這個局面（含）之後的「我方節點」：回傳 [今天到期的個數, 總個數]。用來讓抽線偏向要複習的分支。
function dueBelow(rep, fen, memo, stack) {
  const key = T.fen4(fen);
  if (memo.has(key)) return memo.get(key);
  if (stack.has(key)) return [0, 0];
  const node = rep.nodes[key];
  let due = 0, total = 0;
  const add = r => { due += r[0]; total += r[1]; };
  if (node) {
    stack.add(key);
    try {
      if (node.me) {
        total++;
        if (store.isDue(nodeId(rep, key))) due++;
        const g = new Chess(fen);
        g.move(node.best);
        add(dueBelow(rep, g.fen(), memo, stack));
      } else {
        for (const r of node.replies || []) {
          try {
            const g = new Chess(fen);
            g.move(r[0]);
            add(dueBelow(rep, g.fen(), memo, stack));
          } catch (e) { /* 不合法的著法略過 */ }
        }
      }
    } catch (e) { /* 資料有問題的節點當作沒有 */ }
    stack.delete(key);
  }
  const res = [due, total];
  memo.set(key, res);
  return res;
}

function drillQuestion(node, fen) {
  try {
    new Chess(fen).move(node.best);
  } catch (e) { return null; }
  // 開局練習只認主線；引擎也認可的其他著法放 okAlts，答錯時給不同說明
  const okAlts = Object.keys(node.accept && typeof node.accept === 'object' ? node.accept : {})
    .filter(a => norm(a) !== norm(node.best));
  return {
    fen, best: node.best, accept: [node.best], okAlts,
    moves: node.accept || {},
    why: node.why && typeof node.why === 'object' ? node.why : {},
    whyReply: node.why_reply && typeof node.why_reply === 'object' ? node.why_reply : {},
    hint: typeof node.hint === 'string' ? node.hint : '',
    idea: typeof node.idea === 'string' ? node.idea : '',
    reply: null,
  };
}

// 目前局面該誰決定：輪到我方 → 等使用者；輪到對方 → 依機率出招；沒有節點 → 這條線結束。
function drillAdvance(s) {
  const fen = s.game.fen();
  const key = T.fen4(fen);
  const node = s.rep.nodes[key];
  if (!node || s.game.isGameOver()) { endDrill(s); return; }
  const mine = s.game.turn() === (s.rep.color === 'black' ? 'b' : 'w');
  if (node.me && mine) {
    const q = drillQuestion(node, fen);
    if (!q) { endDrill(s); return; }
    s.q = q;
    s.nodeId = nodeId(s.rep, key);
    s.base = s.game.history().length;
    s.baseLast = s.last;
    s.errs = 0;
    s.revealed = false;
    s.failed = false;
    s.busy = false;
    s.status = '';
    s.hl = [];
    updateBoard(s);
    updatePanel(s, true);
    return;
  }
  if (!node.me && !mine) {
    const memo = new Map();
    const items = [];
    for (const r of node.replies || []) {
      try {
        const g = new Chess(fen);
        g.move(r[0]);
        const w = Number(r[1]);
        if (!(w > 0)) continue;
        const [due, total] = dueBelow(s.rep, g.fen(), memo, new Set());
        items.push({ san: r[0], w, due, total });
      } catch (e) { /* 不合法的著法略過 */ }
    }
    // 只有「有的分支要複習、有的分支已經熟了」時才偏向到期的那邊（權重 ×4）；全部到期就照真實比例
    if (items.some(x => x.due > 0) && items.some(x => x.total > 0 && x.due === 0)) {
      for (const x of items) if (x.due > 0) x.w *= 4;
    }
    const pick = T.pickWeighted(items);
    if (!pick) { endDrill(s); return; }
    s.q = null;
    s.busy = true;
    updateBoard(s);
    later(s, 600, () => {
      playMove(s, pick.san);
      later(s, 500, () => drillAdvance(s));
    });
    return;
  }
  endDrill(s);   // 節點的顏色和輪到誰對不上，資料有問題，當作結束
}

function drillRight(s, mv, kind) {
  const q = s.q;
  s.stats.me++;
  if (!s.failed) {
    s.stats.clean++;
    s.rec = store.record(s.nodeId, true);
  }
  const text = kind === 'best' ? q.idea : `主線：${q.best}${q.idea ? '。' + q.idea : ''}`;
  s.msg = { kind: 'ok', title: kind === 'best' ? '正確' : '可行', text };
  s.q = null;
  updateBoard(s, { animate: true });
  updatePanel(s, true);
  let t = 750;
  const inTree = !!s.rep.nodes[T.fen4(s.game.fen())];
  if (kind === 'alt' && !inTree) {
    // 這個走法不在樹裡：收回，改走主線，才接得上後面的節點
    later(s, t, () => { rewind(s); updateBoard(s); updatePanel(s); });
    later(s, t + 120, () => playMove(s, q.best));
    t += 120 + 700;
  }
  later(s, t, () => drillAdvance(s));
}

function endDrill(s) {
  s.q = null;
  s.done = true;
  s.busy = false;
  s.status = '';
  s.hl = [];
  updateBoard(s);
  updatePanel(s, true);
}

function movesText(s) {
  const out = [];
  s.game.history().forEach((m, i) => out.push(i % 2 === 0 ? `${i / 2 + 1}.${m}` : m));
  return out.join(' ') || '（還沒走）';
}

function drillPanel(s) {
  const el = document.getElementById('panel');
  if (!el) return;
  const list = `<div class="line small movelist">${esc(movesText(s))}</div>`;
  if (s.done) {
    const st = s.stats;
    el.innerHTML = `
      <div class="result ok"><h3>本線完成</h3>
        <p>你走了 ${st.me} 步，一次就對的有 ${st.clean} 步。</p></div>
      ${msgHtml(s.msg)}
      ${list}
      <div class="actions">
        <div class="btns"><button class="btn grow" id="explore">分析</button><a class="btn grow" href="#/openings/drill">換開局</a></div>
        <div class="btns"><button class="btn primary grow" id="again">重練</button></div>
      </div>`;
    document.getElementById('again').addEventListener('click', () => pageDrill(s.rep.id));
    document.getElementById('explore').addEventListener('click', () => startExplore(s));
    return;
  }
  el.innerHTML = `
    ${msgHtml(s.msg)}
    ${hintHtml(s)}
    ${list}
    <div class="btns actions">
      <button class="btn grow" id="giveup"${s.busy || s.revealed || !s.q ? ' disabled' : ''}>解答</button>
      <button class="btn grow" id="restart">重來</button>
    </div>`;
  document.getElementById('giveup').addEventListener('click', () => giveUp(s));
  document.getElementById('restart').addEventListener('click', () => pageDrill(s.rep.id));
}

/* ---------- 學習模式 ---------- */

const NO_LEARN = `<div class="card empty"><p>學習資料還沒產生。</p><p class="muted small">缺少 data/learn.json。</p></div>`;
const enc = encodeURIComponent;

function learnLevelOf(repId) {
  const n = Number(store.getSettings().learnLevel?.[repId]);
  return Number.isFinite(n) && n >= 1 && n <= 4 ? Math.floor(n) : 1;
}

function setLearnLevel(repId, n) {
  store.setSetting('learnLevel', { ...store.getSettings().learnLevel, [repId]: n });
}

// 這套開局的學習資料與目前等級；找不到回 null
function learnCtx(repId) {
  const root = state.learnData;
  if (!state.openings || !root) return null;
  const rep = state.openings.find(r => r.id === repId);
  const ld = root.repertoires && root.repertoires[repId];
  if (!rep || !ld || !Array.isArray(ld.chapters)) return null;
  const levels = root.levels;
  const lv = Math.min(learnLevelOf(repId), levels.length);
  return { rep, ld, levels, lv, thr: levels[lv - 1] };
}

function learnMissing(back) {
  setTitle('學習模式', back);
  $view.innerHTML = `<div class="card empty"><p>找不到這套開局或章節。</p><a class="btn" href="#/learn">回清單</a></div>`;
}

function pbarHtml(p) {
  const t = p.total || 0;
  const w = n => (t ? n / t * 100 : 0).toFixed(2);
  return `<div class="pbar" role="img" aria-label="已熟 ${p.known}、到期 ${p.due}、未學 ${p.fresh}">`
    + `<i class="k" style="width:${w(p.known)}%"></i><i class="d" style="width:${w(p.due)}%"></i><i class="n" style="width:${w(p.fresh)}%"></i></div>`;
}

const PKEY = '<div class="pkey"><span><i class="k"></i>已熟</span><span><i class="d"></i>到期</span><span><i class="n"></i>未學</span></div>';

// 全部開局的到期步數（開局頁的入口用）
function learnDueTotal() {
  if (!state.openings || !state.learnData) return 0;
  let n = 0;
  const now = Date.now();
  for (const rep of state.openings) {
    const c = learnCtx(rep.id);
    if (c) n += L.repProgress(rep, c.ld, c.thr, now).due;
  }
  return n;
}

function pageLearnList() {
  setTitle('學習模式', '#/openings');
  if (!state.openings || !state.learnData) { $view.innerHTML = NO_LEARN; return; }
  const now = Date.now();
  const rows = state.openings.map(rep => {
    const c = learnCtx(rep.id);
    if (!c) return '';
    const p = L.repProgress(rep, c.ld, c.thr, now);
    return `<a class="row chev learnrow" href="#/learn/${enc(rep.id)}">
      <div class="l"><div>${esc(rep.name)}</div>
        <div class="small muted">${rep.color === 'black' ? '執黑' : '執白'}　第 ${c.lv} 級</div>
        ${pbarHtml(p)}</div>
      <div class="r"><b>${p.due}</b><div>到期</div></div></a>`;
  }).join('');
  $view.innerHTML = `<p class="muted small">選一套開局，分章學習常見分支。</p>${rows || NO_LEARN}${PKEY}`;
}

function levelDesc(levels) {
  return levels.map((l, i) => `第${i + 1}級＝每 ${Math.round(1 / l)} 盤${i === 0 ? '遇到 1 次以上' : ''}`).join('；');
}

function pageLearnRep(repId) {
  const c = learnCtx(repId);
  if (!c) { learnMissing('#/learn'); return; }
  const { rep, ld, levels, lv, thr } = c;
  setTitle(rep.name, '#/learn');
  const now = Date.now();
  const p = L.progressOf(L.repMoves(rep, ld, thr), now);
  const lvBtns = levels.map((t, i) => {
    const n = L.repMoves(rep, ld, t).length;
    return `<button class="btn${i + 1 === lv ? ' on' : ''}" data-lv="${i + 1}" aria-pressed="${i + 1 === lv}">第 ${i + 1} 級<small>${n} 步</small></button>`;
  }).join('');
  const rows = ld.chapters.map(ch => {
    const share = `實戰 ${L.fmtPct(ch.share)}`;
    const items = L.chapterMoves(rep, ch, thr);
    if (!items.length) {
      let open = 0;
      for (let k = lv + 1; k <= levels.length; k++) {
        if (L.chapterMoves(rep, ch, levels[k - 1]).length) { open = k; break; }
      }
      return `<div class="row off"><div class="l"><div>${esc(ch.title)}</div><div class="small muted">${share}</div><div class="small muted pclamp">${esc(L.pathZh(L.commonPrefix(ch.prefixes)))}</div></div>
        <div class="r">${open ? `第 ${open} 級開放` : '—'}</div></div>`;
    }
    const cp = L.progressOf(items, now);
    return `<a class="row chev learnrow" href="#/learn/${enc(repId)}/${enc(ch.id)}">
      <div class="l"><div>${esc(ch.title)}</div><div class="small muted">${share}</div><div class="small muted pclamp">${esc(L.pathZh(L.commonPrefix(ch.prefixes)))}</div>${pbarHtml(cp)}</div>
      <div class="r"><b>${cp.due}</b><div>到期</div></div></a>`;
  }).join('');
  $view.innerHTML = `
    <div class="card">
      <div>${sideChip(rep.color)}</div>
      <p class="small muted" style="margin:8px 0 0">${esc(levelDesc(levels))}</p>
      <div class="lvls">${lvBtns}</div>
      ${pbarHtml(p)}
      <div class="small muted" style="margin-top:4px">第 ${lv} 級共 ${p.total} 步：已熟 ${p.known}，到期 ${p.due}，未學 ${p.fresh}。</div>
      <div class="btns"><a class="btn primary grow" href="#/learn/${enc(repId)}/review"${p.due ? '' : ' aria-disabled="true" tabindex="-1"'}>全部複習（${p.due}）</a></div>
    </div>
    <h2>章節</h2>${rows}${PKEY}`;
  $view.querySelectorAll('.lvls .btn').forEach(b => b.addEventListener('click', () => {
    setLearnLevel(repId, Number(b.dataset.lv));
    pageLearnRep(repId);
  }));
}

function pageLearnChapter(repId, chId) {
  const c = learnCtx(repId);
  const ch = c && c.ld.chapters.find(x => x.id === chId);
  if (!c || !ch) { learnMissing('#/learn'); return; }
  const { rep, lv, thr } = c;
  setTitle(ch.title, `#/learn/${enc(repId)}`);
  const now = Date.now();
  const items = L.chapterMoves(rep, ch, thr);
  const p = L.progressOf(items, now);
  const nLines = L.newLines(rep, ch, thr, Infinity, now).length;
  const base = `#/learn/${enc(repId)}/${enc(chId)}`;
  const dis = ok => (ok ? '' : ' aria-disabled="true" tabindex="-1"');
  $view.innerHTML = `
    <div class="card">
      <div class="small muted">${rep.color === 'black' ? '執黑' : '執白'}　實戰 ${esc(L.fmtPct(ch.share))}　第 ${lv} 級</div>
      <div class="pathline">${esc(L.pathZh(L.commonPrefix(ch.prefixes)))}</div>
      ${ch.plan ? `<h3>計畫</h3><p class="prose">${esc(ch.plan)}</p>` : ''}
      ${ch.watch ? `<h3>注意</h3><p class="prose">${esc(ch.watch)}</p>` : ''}
      ${p.total ? `${pbarHtml(p)}<div class="small muted" style="margin-top:4px">共 ${p.total} 步：已熟 ${p.known}，到期 ${p.due}，未學 ${p.fresh}。</div>`
        : `<p class="muted">第 ${lv} 級沒有這章的著法，可在上一頁調高等級。</p>`}
    </div>
    <div class="btns vlist">
      <a class="btn primary" href="${base}/new"${dis(nLines)}>學新線（${nLines} 條）</a>
      <a class="btn" href="${base}/review"${dis(p.due)}>複習（${p.due} 步）</a>
      <a class="btn" href="${base}/browse">瀏覽分支</a>
    </div>${p.total ? PKEY : ''}`;
}

/* ----- 學習工作階段（學新線、複習、瀏覽、從這裡練）----- */

function learnSession(repId, chId, sub, arg) {
  const c = learnCtx(repId);
  const chap = c && chId ? c.ld.chapters.find(x => x.id === chId) || null : null;
  if (!c || (chId && !chap)) { learnMissing('#/learn'); return; }
  const back = chap ? `#/learn/${enc(repId)}/${enc(chId)}` : `#/learn/${enc(repId)}`;
  setTitle(chap ? chap.title : `${c.rep.name}：複習`, back);
  stopTimer();
  const s = state.learn = {
    kind: 'learn', mode: sub, rep: c.rep, ld: c.ld, chap, back, thr: c.thr,
    orientation: c.rep.color,
    game: new Chess(), last: null, prevLast: null, hl: [], arrows: null, status: '',
    q: null, cm: null, busy: true, done: false, msg: null, notice: null, phase: '',
    errs: 0, qErr: false, lineErr: false, revealed: false,
    lines: [], li: 0, line: null, mi: 0, pv: 0, attempt: 1,
    newSet: new Set(), seen: new Set(), recorded: new Set(),
    stats: { asked: 0, clean: 0 },
    queue: [], pending: new Set(), cur: null, total: 0,
    path: [], pos: null,
    onMove: learnUserMove,
  };
  $view.innerHTML = `<div class="split" id="split">
    <div class="split-board" id="bcol">
      <div class="turn">${sideChip(c.rep.color)}<span>${esc(c.rep.name)}</span></div>
      ${boardRowHtml()}
    </div>
    <div class="split-info"><div id="panel"></div></div></div>`;
  state.board = new Board(document.getElementById('board'));
  state.evalFen = null;
  if (store.getSettings().evalbar) engine.warm();
  updateBoard(s);
  updatePanel(s);
  if (sub === 'new') learnStartNew(s);
  else if (sub === 'review') {
    const items = chap ? L.chapterMoves(c.rep, chap, c.thr) : L.repMoves(c.rep, c.ld, c.thr);
    learnStartReview(s, L.dueItems(items));
  } else if (sub === 'browse') {
    s.phase = 'browse';
    s.path = L.commonPrefix(chap.prefixes);
    browseRender(s, false);
  } else if (sub === 'from') {
    const path = String(arg || '').split('_').filter(Boolean);
    learnStartFrom(s, path);
  } else { learnMissing('#/learn'); }
}

function learnArrow(m, color) {
  return { from: m.from, to: m.to, color: color || 'var(--arrow-good)' };
}

function learnCheckLevel(s) {
  const c = learnCtx(s.rep.id);
  if (!c) return;
  const nl = L.maybeLevelUp(c.rep, c.ld, c.lv, c.levels);
  if (nl > c.lv) {
    setLearnLevel(s.rep.id, nl);
    s.notice = `第 ${nl} 級已開放`;
  }
}

function noticeHtml(s) {
  if (!s.notice) return '';
  const t = s.notice;
  s.notice = null;   // 只顯示一次
  return `<div class="notice">${esc(t)}</div>`;
}

function learnEmpty(s, text) {
  s.phase = 'empty';
  s.busy = false;
  s.q = null;
  s.msg = { kind: 'info', title: text, text: '' };
  updateBoard(s);
  updatePanel(s);
}

/* ----- 學新線 ----- */

function learnStartNew(s) {
  const c = learnCtx(s.rep.id);
  if (c) s.thr = c.thr;
  s.lines = L.newLines(s.rep, s.chap, s.thr, store.getSettings().learnBatch);
  s.li = 0;
  s.newSet = new Set();
  s.seen = new Set();
  s.recorded = new Set();
  s.stats = { asked: 0, clean: 0 };
  for (const ln of s.lines) for (const m of ln.moves) if (m.me && m.id && L.moveStatus(m.id) === 'new') s.newSet.add(m.id);
  if (!s.lines.length) { learnEmpty(s, '這一章目前沒有未學的線。'); return; }
  learnPreview(s);
}

function learnStartFrom(s, path) {
  const c = learnCtx(s.rep.id);
  s.fromPath = path;
  s.attempt = 1;
  const pos = L.positionAt(s.rep, path);
  const lines = pos && pos.node ? L.linesFrom(s.rep, path, c.thr).slice(0, store.getSettings().learnBatch) : [];
  s.lines = lines;
  s.li = 0;
  s.newSet = new Set();
  s.seen = new Set();
  s.recorded = new Set();
  s.stats = { asked: 0, clean: 0 };
  if (!lines.length) { learnEmpty(s, '這個局面之後沒有可練的線。'); return; }
  learnQuizStart(s);
}

function learnNextLine(s) {
  s.li++;
  s.attempt = 1;
  if (s.li >= s.lines.length) { learnSummary(s); return; }
  if (s.mode === 'from') learnQuizStart(s); else learnPreview(s);
}

function learnPreview(s) {
  s.phase = 'pre';
  s.line = s.lines[s.li];
  s.attempt = 1;
  s.msg = null;
  s.q = null;
  s.busy = true;
  pvSet(s, 0, false);
}

// 預覽走到第 k 步之後的局面；箭頭標出「下一步」
function pvSet(s, k, animate) {
  const line = s.line;
  s.pv = k;
  const m = k > 0 ? line.moves[k - 1] : null;
  s.game = new Chess(m ? m.fenAfter : L.START_FEN);
  s.last = m ? { from: m.from, to: m.to } : null;
  const nx = line.moves[k];
  s.arrows = nx ? [learnArrow(nx, nx.me ? 'var(--arrow-me)' : 'var(--arrow-opp)')] : null;
  updateBoard(s, { animate });
  if (animate && m) audio.play(m.cap ? 'capture' : 'move');
  updatePanel(s);
}

function learnQuizStart(s) {
  const line = s.lines[s.li];
  s.line = line;
  s.phase = 'quiz';
  s.lineErr = false;
  s.msg = null;
  s.arrows = null;
  s.status = '';
  s.q = null;
  s.busy = true;
  s.mi = s.mode === 'from' ? line.start : 0;
  const pm = s.mi > 0 ? line.moves[s.mi - 1] : null;
  s.game = new Chess(pm ? pm.fenAfter : L.START_FEN);
  s.last = pm ? { from: pm.from, to: pm.to } : null;
  updateBoard(s);
  updatePanel(s);
  later(s, 450, () => learnStep(s));
}

// 已熟、而且不是這批新學的著法：自動快轉
function learnSkip(s, m) {
  if (!m.node) return true;
  if (s.mode !== 'new') return false;
  return L.moveStatus(m.id) === 'known' && (!s.newSet.has(m.id) || s.seen.has(m.id));
}

function learnStep(s) {
  const line = s.line;
  if (s.mi >= line.moves.length) { learnLineDone(s); return; }
  const m = line.moves[s.mi];
  if (!m.me || learnSkip(s, m)) {
    s.q = null;
    s.busy = true;
    later(s, m.me ? 300 : 500, () => {
      playMove(s, m.san);
      s.mi++;
      later(s, 400, () => learnStep(s));
    });
    return;
  }
  learnAsk(s);
}

function learnAsk(s) {
  const m = s.line.moves[s.mi];
  s.cm = m;
  s.q = { fen: m.fenBefore, best: m.san };
  s.errs = 0;
  s.qErr = false;
  s.revealed = false;
  s.busy = false;
  s.status = '';
  s.arrows = null;
  s.msg = null;
  updateBoard(s);
  updatePanel(s);
}

// 每個著法在一輪裡只記一次（第一次對或錯）；複習的補考不記
function learnRecord(s, m, correct) {
  if (!m.id || s.recorded.has(m.id)) return;
  if (s.cur && s.cur.retry) return;
  s.recorded.add(m.id);
  s.rec = store.record(m.id, correct);
  if (correct) s.seen.add(m.id);
}

function learnUserMove(s, from, to, promo) {
  if (!s || s.busy || s.done || !s.q || !s.cm) return;
  let mv;
  try { mv = s.game.move({ from, to, promotion: promo || 'q' }); } catch (e) { return; }
  s.prevLast = s.last;
  s.last = { from: mv.from, to: mv.to };
  s.arrows = null;
  audio.play(mv.captured ? 'capture' : 'move');
  const m = s.cm;
  if (norm(mv.san) === norm(m.san)) { learnCorrect(s); return; }
  const mvZh = L.zhSan(mv.san, mv.color === 'w');
  const bestZh = L.zhSan(m.san, m.white);
  const alt = Object.keys(m.node.accept && typeof m.node.accept === 'object' ? m.node.accept : {})
    .some(a => norm(a) === norm(mv.san));
  s.busy = true;
  if (alt) {
    // 可行但不是本線：不算錯，收回後請使用者改下本線的著法
    s.msg = { kind: 'info', title: `可行，但本線走 ${bestZh}`, text: '請改下本線的著法。' };
    s.status = '';
    updateBoard(s, { animate: true });
    updatePanel(s);
    later(s, 1100, () => learnRewind(s, true));
    return;
  }
  s.errs++;
  s.qErr = true;
  s.lineErr = true;
  learnRecord(s, m, false);
  const why = T.lookup(m.node.why, mv.san);
  s.msg = { kind: 'bad', title: `${mvZh}：不是本線的著法`, text: typeof why === 'string' && why ? why : `箭頭是正確的走法：${bestZh}。` };
  s.status = 'bad';
  updateBoard(s, { animate: true });
  updatePanel(s);
  later(s, 900, () => learnRewind(s, true));
}

// 收回使用者剛走的一步，並用箭頭標出本線的走法
function learnRewind(s, showArrow) {
  s.game.undo();
  s.last = s.prevLast;
  s.busy = false;
  s.status = '';
  s.arrows = showArrow && s.cm ? [learnArrow(s.cm)] : null;
  updateBoard(s);
  updatePanel(s);
}

function learnCorrect(s) {
  const m = s.cm;
  const first = !s.qErr;
  if (first) learnRecord(s, m, true);
  if (!(s.cur && s.cur.retry)) { s.stats.asked++; if (first) s.stats.clean++; }
  s.busy = true;
  s.status = 'ok';
  s.msg = { kind: 'ok', title: '正確', text: typeof m.node.idea === 'string' ? m.node.idea : '' };
  s.q = null;
  s.asking = false;
  s.mi++;
  updateBoard(s, { animate: true });
  updatePanel(s);
  later(s, 750, () => {
    s.status = '';
    if (s.mode === 'review') reviewAfter(s); else learnStep(s);
  });
}

function learnGiveUp(s) {
  if (s.busy || !s.q || s.revealed || !s.cm) return;
  s.revealed = true;
  s.qErr = true;
  s.lineErr = true;
  learnRecord(s, s.cm, false);
  s.arrows = [learnArrow(s.cm)];
  s.msg = { kind: 'info', title: '解答', text: `${L.zhSan(s.cm.san, s.cm.white)}，請走一次。` };
  updateBoard(s);
  updatePanel(s);
}

function learnLineDone(s) {
  s.q = null;
  if (s.lineErr) {
    s.attempt++;
    s.busy = true;
    s.msg = { kind: 'info', title: '這條線有錯誤', text: '再測一遍。' };
    updateBoard(s);
    updatePanel(s);
    later(s, 1400, () => learnQuizStart(s));
    return;
  }
  learnCheckLevel(s);
  s.phase = 'lineDone';
  s.busy = false;
  s.arrows = null;
  updateBoard(s);
  updatePanel(s);
}

function learnSummary(s) {
  learnCheckLevel(s);
  s.phase = 'sum';
  s.q = null;
  s.busy = false;
  s.arrows = null;
  updateBoard(s);
  updatePanel(s);
}

/* ----- 複習 ----- */

function learnStartReview(s, items) {
  s.queue = items.map(it => ({ id: it.id, line: it.line, idx: it.idx, retry: false }));
  s.pending = new Set(items.map(it => it.id));
  s.total = items.length;
  s.stats = { asked: 0, clean: 0 };
  s.recorded = new Set();
  s.seen = new Set();
  if (!items.length) { learnEmpty(s, '目前沒有到期的著法。'); return; }
  s.phase = 'quiz';
  reviewNext(s);
}

// 每題從該著法往前兩個半步開始，自動走那兩步再讓使用者下
function reviewNext(s) {
  if (!s.queue.length) { learnSummary(s); return; }
  const it = s.queue.shift();
  s.cur = it;
  s.line = it.line;
  s.asking = true;
  if (!it.retry) s.pending.delete(it.id);
  const st = Math.max(0, it.idx - 2);
  const pm = st > 0 ? it.line.moves[st - 1] : null;
  s.mi = st;
  s.game = new Chess(pm ? pm.fenAfter : L.START_FEN);
  s.last = pm ? { from: pm.from, to: pm.to } : null;
  s.q = null;
  s.busy = true;
  s.msg = null;
  s.arrows = null;
  s.status = '';
  updateBoard(s);
  updatePanel(s);
  const play = () => {
    if (s.mi >= it.idx) { learnAsk(s); return; }
    playMove(s, it.line.moves[s.mi].san);
    s.mi++;
    later(s, 600, play);
  };
  later(s, 500, play);
}

// 答對後：答錯過的排到最後再考；否則同一條線下一步也到期就接著考
function reviewAfter(s) {
  const it = s.cur;
  const line = s.line;
  if (s.qErr) {
    s.queue.push({ id: it.id, line: it.line, idx: it.idx, retry: true });
    reviewNext(s);
    return;
  }
  const opp = line.moves[s.mi];        // s.mi 已經指向答完的下一步（對手的應著）
  const nm = line.moves[s.mi + 1];
  if (!it.retry && opp && !opp.me && nm && nm.id && s.pending.has(nm.id)) {
    s.pending.delete(nm.id);
    s.queue = s.queue.filter(x => x.id !== nm.id);
    s.cur = { id: nm.id, line, idx: s.mi + 1, retry: false };
    s.q = null;
    s.busy = true;
    later(s, 400, () => {
      playMove(s, opp.san);
      s.mi++;
      later(s, 500, () => learnAsk(s));
    });
    return;
  }
  reviewNext(s);
}

/* ----- 瀏覽分支 ----- */

function browseRender(s, animate) {
  const pos = L.positionAt(s.rep, s.path);
  s.pos = pos;
  s.q = null;
  s.busy = false;
  s.status = '';
  if (!pos) { s.arrows = null; updateBoard(s); updatePanel(s); return; }
  s.game = new Chess(pos.fen);
  s.last = pos.last;
  let arrows = null;
  const node = pos.node;
  if (node && !pos.over) {
    if (node.me) {
      const st = L.step(pos.fen, node.best);
      if (st) arrows = [{ from: st.from, to: st.to, color: 'var(--arrow-me)' }];
    } else {
      const reps = (node.replies || []).filter(r => Number(r[1]) > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
      const top = reps.length ? Number(reps[0][1]) : 1;
      arrows = [];
      for (const r of reps) {
        const st = L.step(pos.fen, r[0]);
        if (st) arrows.push({ from: st.from, to: st.to, color: 'var(--arrow-opp)', opacity: +(0.3 + 0.6 * (Number(r[1]) / top)).toFixed(2) });
      }
    }
  }
  s.arrows = arrows;
  updateBoard(s, { animate });
  if (animate && pos.last) audio.play(pos.cap ? 'capture' : 'move');
  updatePanel(s);
}

// 分支旁的練習狀態：到期優先，其次已熟／未學；不在目前等級的標「第 N 級」
function branchTag(s, sans) {
  const levels = (state.learnData && state.learnData.levels) || [];
  const p = L.branchProgress(s.rep, sans, s.thr, levels);
  if (!p) return '';
  if (p.needLevel !== undefined) return `<span class="btag lv">${p.needLevel ? `第 ${p.needLevel} 級` : '範圍外'}</span>`;
  if (!p.total) return '';
  let t;
  if (p.due) t = `<span class="btag d"><i></i>到期 ${p.due}</span>`;
  else if (p.known === p.total) t = `<span class="btag k"><i></i>已熟</span>`;
  else if (!p.known) t = `<span class="btag n"><i></i>未學 ${p.fresh}</span>`;
  else t = `<span class="btag k"><i></i>已熟 ${p.known}/${p.total}</span>`;
  return t;
}

function browseGo(s, san) {
  s.path.push(san);
  if (!L.positionAt(s.rep, s.path)) { s.path.pop(); return; }
  browseRender(s, true);
}

function browsePanel(s, el) {
  const pos = s.pos;
  const node = pos && pos.node;
  let body;
  if (!pos) body = '<div class="result info"><p>這個局面讀不出來。</p></div>';
  else if (pos.over) body = '<div class="result info"><p>對局已結束。</p></div>';
  else if (!node) body = '<div class="result info"><p>這個局面沒有更多資料。</p></div>';
  else if (node.me) {
    const st = L.step(pos.fen, node.best);
    const zh = st ? L.zhSan(st.san, st.white) : node.best;
    const alts = Object.entries(node.accept && typeof node.accept === 'object' ? node.accept : {})
      .filter(([a]) => norm(a) !== norm(node.best))
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .map(([a]) => ({ san: a, st: L.step(pos.fen, a) }))
      .filter(x => x.st);
    body = `<div class="small muted" style="margin:6px 0 2px">輪到你</div>
      <button class="row brow" data-san="${esc(node.best)}"><div class="l"><div>你的走法：${esc(zh)}</div>${node.idea ? `<div class="small muted">${esc(node.idea)}</div>` : ''}</div><div class="r">${branchTag(s, [...s.path, node.best])}</div></button>
      ${alts.length ? `<div class="alts"><span>也可以：</span>${alts.map(x => `<button class="chip" data-san="${esc(x.san)}">${esc(L.zhSan(x.st.san, x.st.white))}</button>`).join('')}</div>` : ''}`;
  } else {
    const rows = (node.replies || []).filter(r => Number(r[1]) > 0).sort((a, b) => b[1] - a[1])
      .map(r => ({ r, st: L.step(pos.fen, r[0]) })).filter(x => x.st);
    body = `<div class="small muted" style="margin:6px 0 2px">對手可能走</div>`
      + rows.map(x => {
        const tag = branchTag(s, [...s.path, x.r[0]]);
        return `<button class="row brow${tag.includes('btag lv') ? ' off' : ''}" data-san="${esc(x.r[0])}"><div class="l"><div>${esc(L.zhSan(x.st.san, x.st.white))}</div>${tag ? `<div>${tag}</div>` : ''}</div><div class="r"><b>${esc(L.fmtPct(x.r[1]))}</b></div></button>`;
      }).join('');
  }
  const canFrom = !!(pos && node && !pos.over);
  el.innerHTML = `
    <div class="pathline">${esc(L.pathZh(s.path) || '（起始局面）')}</div>
    ${(() => { const t = pos && node && !pos.over ? branchTag(s, s.path) : ''; return t ? `<div class="small muted bsum">這個局面以下：${t}</div>` : ''; })()}
    ${body}
    <div class="actions"><div class="btns">
      <button class="btn icon" id="b-prev" aria-label="上一步"${s.path.length ? '' : ' disabled'}>${ICON.prev}</button>
      <button class="btn primary grow" id="b-from"${canFrom ? '' : ' disabled'}>從這裡練</button>
      <a class="btn grow" href="${esc(s.back)}">回章節</a>
    </div></div>`;
  el.querySelectorAll('[data-san]').forEach(b => b.addEventListener('click', () => browseGo(s, b.dataset.san)));
  document.getElementById('b-prev').addEventListener('click', () => { s.path.pop(); browseRender(s, false); });
  document.getElementById('b-from').addEventListener('click', () => {
    location.hash = `#/learn/${enc(s.rep.id)}/${enc(s.chap.id)}/from/${enc(s.path.join('_'))}`;
  });
}

/* ----- 面板 ----- */

function learnPanel(s) {
  const el = document.getElementById('panel');
  if (!el) return;
  if (s.mode === 'browse') { browsePanel(s, el); return; }
  const backBtn = `<a class="btn grow" href="${esc(s.back)}">${s.chap ? '回章節' : '回上頁'}</a>`;
  if (s.phase === 'empty') {
    el.innerHTML = `${msgHtml(s.msg)}<div class="btns actions">${backBtn}</div>`;
    return;
  }
  if (s.phase === 'pre') { previewPanel(s, el); return; }
  if (s.phase === 'sum') { summaryPanel(s, el, backBtn); return; }
  if (s.phase === 'lineDone') {
    const last = s.li >= s.lines.length - 1;
    el.innerHTML = `
      <div class="stepbar">第 ${s.li + 1} / ${s.lines.length} 條</div>
      <div class="result ok"><h3>這條線完成</h3><p>${s.attempt > 1 ? `第 ${s.attempt} 次測驗全對。` : '一次全對。'}</p></div>
      ${noticeHtml(s)}
      <div class="pathline">${esc(L.pathZh(s.line.moves.map(m => m.san)))}</div>
      <div class="btns actions"><button class="btn primary grow" id="l-next">${last ? '完成' : '下一條'}</button></div>`;
    document.getElementById('l-next').addEventListener('click', () => learnNextLine(s));
    return;
  }
  quizPanel(s, el);
}

function previewPanel(s, el) {
  const line = s.line;
  const k = s.pv;
  const nx = line.moves[k];
  let info;
  if (nx) {
    const zh = L.zhSan(nx.san, nx.white);
    const idea = nx.me && nx.node && nx.node.idea ? `<p>${esc(nx.node.idea)}</p>` : '';
    const share = !nx.me && nx.ratio != null ? `<p>實戰 ${esc(L.fmtPct(nx.ratio))}</p>` : '';
    info = `<div class="result info"><span class="side-tag">${nx.me ? '你的著法' : '對手著法'}</span><h3>${esc(zh)}</h3>${idea}${share}</div>`;
  } else {
    info = '<div class="result ok"><h3>預覽完成</h3><p>接著自己下一遍。</p></div>';
  }
  el.innerHTML = `
    <div class="stepbar">第 ${s.li + 1} / ${s.lines.length} 條　預覽</div>
    ${info}
    <div class="pathline">${esc(L.pathZh(line.moves.slice(0, k).map(m => m.san)) || '（還沒走）')}</div>
    <div class="actions"><div class="btns">
      <button class="btn icon" id="pv-first" aria-label="回到起點"${k ? '' : ' disabled'}>${ICON.first}</button>
      <button class="btn icon" id="pv-prev" aria-label="上一步"${k ? '' : ' disabled'}>${ICON.prev}</button>
      ${nx ? `<button class="btn primary grow" id="pv-next">下一步</button>` : `<button class="btn primary grow" id="pv-go">自己下一遍</button>`}
    </div></div>`;
  document.getElementById('pv-first').addEventListener('click', () => pvSet(s, 0, false));
  document.getElementById('pv-prev').addEventListener('click', () => pvSet(s, Math.max(0, s.pv - 1), false));
  const nxt = document.getElementById('pv-next');
  if (nxt) nxt.addEventListener('click', () => pvSet(s, s.pv + 1, true));
  const go = document.getElementById('pv-go');
  if (go) go.addEventListener('click', () => learnQuizStart(s));
}

function quizPanel(s, el) {
  let head;
  if (s.mode === 'review') head = `<div class="stepbar">複習　剩餘 ${s.queue.length + (s.asking ? 1 : 0)} 題</div>`;
  else head = `<div class="stepbar">第 ${s.li + 1} / ${s.lines.length} 條　測驗${s.attempt > 1 ? `（第 ${s.attempt} 次）` : ''}</div>`;
  const sans = s.line ? s.line.moves.slice(0, s.mi).map(m => m.san) : [];
  el.innerHTML = `
    ${head}
    ${msgHtml(s.msg)}
    <div class="pathline">${esc(L.pathZh(sans) || '（還沒走）')}</div>
    <div class="btns actions">
      <button class="btn grow" id="lq-give"${s.busy || !s.q || s.revealed ? ' disabled' : ''}>解答</button>
      ${s.mode === 'new' ? '<button class="btn grow" id="lq-pre">重看預覽</button>' : ''}
    </div>`;
  document.getElementById('lq-give').addEventListener('click', () => learnGiveUp(s));
  const pre = document.getElementById('lq-pre');
  if (pre) pre.addEventListener('click', () => { stopTimer(); learnPreview(s); });
}

function summaryPanel(s, el, backBtn) {
  const st = s.stats;
  let title, text, again = '';
  if (s.mode === 'review') {
    title = '複習完成';
    text = `共 ${s.total} 題，你下了 ${st.asked} 步，一次就對 ${st.clean} 步。`;
  } else {
    title = s.mode === 'from' ? '練習完成' : '這一批完成';
    text = `共 ${s.lines.length} 條線，你下了 ${st.asked} 步，一次就對 ${st.clean} 步。`;
    const more = s.mode === 'new' ? L.newLines(s.rep, s.chap, s.thr, 1).length : 0;
    if (s.mode === 'new') again = `<button class="btn primary grow" id="l-more"${more ? '' : ' disabled'}>再學一批</button>`;
    else again = '<button class="btn primary grow" id="l-more">再練一次</button>';
  }
  el.innerHTML = `
    <div class="result ok"><h3>${title}</h3><p>${text}</p></div>
    ${noticeHtml(s)}
    <div class="btns actions">${again}${backBtn}</div>`;
  const more = document.getElementById('l-more');
  if (more) more.addEventListener('click', () => {
    if (s.mode === 'new') learnStartNew(s); else learnStartFrom(s, s.fromPath || []);
  });
}

/* ---------- 設定 ---------- */

function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function pageSettings() {
  setTitle('設定');
  const cnt = store.counts();
  const set = store.getSettings();
  $view.innerHTML = `
    <div class="card"><h3 style="margin-top:0">進度</h3>
      <p>已練習 ${cnt.total} 題。各盒題數：${cnt.boxes.map((n, i) => `第${i + 1}盒 ${n}`).join('，')}。</p>
      <div class="btns">
        <button class="btn grow" id="exp">匯出 JSON</button>
        <button class="btn grow" id="cpy">複製</button>
      </div>
      <label class="small muted" for="imp">匯入（覆蓋現有進度）</label>
      <div class="btns"><input type="file" id="imp" accept="application/json,.json"></div>
      <div class="btns"><button class="btn danger grow" id="clr">清除進度</button></div>
      <div id="msg"></div>
    </div>
    <div class="card"><h3 style="margin-top:0">外觀</h3>
      <label class="small muted" for="ui">背景</label>
      <select id="ui"><option value="auto"${set.ui === 'auto' ? ' selected' : ''}>跟隨系統</option><option value="light"${set.ui === 'light' ? ' selected' : ''}>淺色</option><option value="dark"${set.ui === 'dark' ? ' selected' : ''}>深色</option></select>
    </div>
    <div class="card"><h3 style="margin-top:0">棋盤與音效</h3>
      <label class="check"><input type="checkbox" id="snd"${set.sound ? ' checked' : ''}> 音效</label>
      <label class="small muted" for="cap">吃子音效</label>
      <div class="btns" style="margin-top:4px"><select id="cap" style="flex:1">${Object.entries(audio.CAPTURE_STYLES).map(([k, v]) => `<option value="${k}"${set.capture === k ? ' selected' : ''}>${v}</option>`).join('')}</select><button class="btn" id="cap-play">試聽</button></div>
      <label class="check"><input type="checkbox" id="imute"${set.ignoreMute ? ' checked' : ''}> 靜音模式仍播放（iOS 17 以上；可能暫停背景音樂）</label>
      <label class="check"><input type="checkbox" id="evb"${set.evalbar ? ' checked' : ''}> 評估條</label>
      <label class="small muted" for="theme">棋盤配色</label>
      <select id="theme"><option value="green"${set.board === 'green' ? ' selected' : ''}>綠白格（預設）</option><option value="brown"${set.board === 'brown' ? ' selected' : ''}>棕色系</option></select>
      <div class="board-slot" id="theme-prev" style="margin-top:10px"></div>
    </div>
    <div class="card"><h3 style="margin-top:0">學習模式</h3>
      <label class="small muted" for="lbatch">每批學幾條新線</label>
      <select id="lbatch">${[1, 2, 3, 4, 5, 6, 8, 10].map(n => `<option value="${n}"${set.learnBatch === n ? ' selected' : ''}>${n} 條</option>`).join('')}</select>
    </div>
    <div class="card"><h3 style="margin-top:0">音效診斷</h3>
      <div class="btns"><button class="btn grow" id="t-rec">測試錄音</button><button class="btn grow" id="t-syn">測試合成音</button><button class="btn grow" id="t-el">測試媒體播放</button></div>
      <pre class="small muted" id="t-out" style="white-space:pre-wrap;margin:6px 0 0"></pre>
    </div>
    <div class="card"><h3 style="margin-top:0">資料</h3>
      <p>資料產生時間：${state.report ? esc(fmtDate(state.report.generated)) : '讀不到'}</p>
      <p>題目數：${state.puzzles.length}${state.skipped ? `（有 ${state.skipped} 題格式不對，已略過）` : ''}</p>
      <p>帳號：${esc(state.report?.username || '—')}</p>
      <div class="btns"><button class="btn grow" id="upd">檢查更新</button></div>
    </div>
    <p class="small muted">Tactix 版本 ${esc(APP_VERSION)}<br>棋子圖：cburnett（CC BY-SA）。棋規：chess.js（BSD）。引擎：Stockfish.js（GPL-3.0）。詳見 vendor/LICENSES.md。</p>`;
  const prev = () => {
    try { renderBoard(document.getElementById('theme-prev'), { fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4', orientation: 'white', mini: true }); } catch (e) { /* 預覽失敗不影響設定 */ }
  };
  prev();
  document.getElementById('snd').addEventListener('change', ev => {
    store.setSetting('sound', ev.target.checked);
    audio.unlock();
    if (ev.target.checked) audio.play('move');
  });
  document.getElementById('cap').addEventListener('change', ev => { store.setSetting('capture', ev.target.value); audio.unlock(); audio.play('capture', ev.target.value); });
  document.getElementById('cap-play').addEventListener('click', () => { audio.unlock(); audio.play('capture', document.getElementById('cap').value); });
  document.getElementById('imute').addEventListener('change', ev => { store.setSetting('ignoreMute', ev.target.checked); audio.setIgnoreMute(); audio.unlock(); audio.play('capture', store.getSettings().capture); });
  const tout = document.getElementById('t-out');
  const showDiag = extra => {
    const d = audio.diag();
    tout.textContent = `版本 ${APP_VERSION}｜音訊 ${d.state}｜取樣率 ${d.rate ?? '—'}｜錄音 ${d.loaded}/${d.total}｜audioSession ${d.session}${d.err ? '\n錯誤：' + d.err : ''}${extra ? '\n' + extra : ''}`;
  };
  document.getElementById('t-rec').addEventListener('click', () => { audio.unlock(); const ok = audio.testRecorded(); setTimeout(() => showDiag(ok ? '已送出錄音播放' : '錄音尚未載入'), 300); });
  document.getElementById('t-syn').addEventListener('click', () => { audio.unlock(); audio.testSynth(); setTimeout(() => showDiag('已送出合成音播放'), 300); });
  document.getElementById('t-el').addEventListener('click', async () => { const r = await audio.testElement(); showDiag('媒體播放：' + r); });
  showDiag();
  document.getElementById('evb').addEventListener('change', ev => store.setSetting('evalbar', ev.target.checked));
  document.getElementById('lbatch').addEventListener('change', ev => store.setSetting('learnBatch', Math.max(1, Math.min(10, Number(ev.target.value) || 4))));
  document.getElementById('ui').addEventListener('change', ev => {
    const v = ev.target.value;
    store.setSetting('ui', v === 'light' || v === 'dark' ? v : 'auto');
    applyTheme();
  });
  document.getElementById('theme').addEventListener('change', ev => {
    store.setSetting('board', ev.target.value === 'brown' ? 'brown' : 'green');
    applyTheme();
  });
  const msg = t => { document.getElementById('msg').innerHTML = `<div class="toast">${esc(t)}</div>`; };
  document.getElementById('exp').addEventListener('click', () => {
    try {
      download(`chesscoach-progress-${new Date().toISOString().slice(0, 10)}.json`, store.exportText());
      msg('已匯出。');
    } catch (e) { msg('匯出失敗，請改用「複製進度文字」。'); }
  });
  document.getElementById('cpy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(store.exportText()); msg('已複製。'); }
    catch (e) { msg('這個瀏覽器不允許複製，請改用匯出。'); }
  });
  document.getElementById('imp').addEventListener('change', async ev => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      if (!window.confirm('要用這個檔案取代目前的練習進度嗎？')) { ev.target.value = ''; return; }
      const n = store.replaceAll(obj);
      msg(`已匯入，共 ${n} 題的進度。`);
      state.cur = null;
    } catch (e) { msg('匯入失敗：檔案格式不對。'); }
    ev.target.value = '';
  });
  document.getElementById('clr').addEventListener('click', () => {
    if (!window.confirm('確定要清除全部練習進度嗎？這個動作無法復原。')) return;
    store.clear();
    state.cur = null;
    pageSettings();
  });
  document.getElementById('upd').addEventListener('click', async () => {
    msg('檢查中…');
    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update();
      }
    } catch (e) { /* 離線時略過 */ }
    setTimeout(() => location.reload(), 800);
  });
}

/* ---------- 啟動 ---------- */

function applyTheme() {
  const root = document.documentElement;
  if (store.getSettings().board === 'brown') root.dataset.board = 'brown';
  else delete root.dataset.board;
  const ui = store.getSettings().ui;
  if (ui === 'light' || ui === 'dark') root.dataset.theme = ui;
  else delete root.dataset.theme;
}

async function main() {
  store.load();
  applyTheme();
  // iPhone 要在使用者手勢裡啟動音效
  for (const ev of ['pointerup', 'touchend', 'click']) document.addEventListener(ev, audio.unlock, { passive: true });
  await loadData();
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator && !MOCK) {
    try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) { /* 忽略 */ }
  }
}
main();
