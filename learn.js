// 學習模式的純邏輯（不碰 DOM）：中文著法、章節的「線」、進度統計、升級判斷。
// 開局樹（openings.json）以 FEN 前 4 欄為 key；我方節點 {me:true,best,accept,idea}，
// 對手節點 {me:false,replies:[[SAN,比例],…]}。到達率 = 沿路對手比例相乘。
import { Chess } from './vendor/chess.js';
import { fen4, normSan } from './trainer.js';
import * as store from './store.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const EPS = 1e-9;
const MAX_LINES = 600;   // 單一章節單一等級的線數上限，防止爆量

export function nodeId(rep, key) { return `op:${rep.id}:${key}`; }

/* ---------- 中文著法 ---------- */

const PIECE = { K: '王', Q: '后', R: '車', B: '象', N: '馬' };

// Nf6 → 「黑 馬→f6」，exd5 → 「白 兵吃d5」，O-O → 「白 短易位」，e8=Q → 「白 兵→e8升后」
export function zhSan(san, white = true) {
  const side = white ? '白 ' : '黑 ';
  const raw = String(san ?? '');
  const tail = raw.includes('#') ? ' 將死' : raw.includes('+') ? ' 將軍' : '';
  const s = raw.replace(/[+#!?]/g, '');
  if (s === 'O-O' || s === '0-0') return side + '短易位' + tail;
  if (s === 'O-O-O' || s === '0-0-0') return side + '長易位' + tail;
  const m = /^([KQRBN])?([a-h])?([1-8])?(x)?([a-h][1-8])(?:=([QRBN]))?$/.exec(s);
  if (!m) return side + raw;
  const [, p, df, dr, cap, to, promo] = m;
  const name = p ? PIECE[p] : '兵';
  const dis = p && (df || dr) ? `(${df || ''}${dr || ''})` : '';
  return `${side}${name}${dis}${cap ? '吃' : '→'}${to}${promo ? '升' + PIECE[promo] : ''}${tail}`;
}

// 從起點開始的 SAN 序列 → 「1. 白 兵→e4　黑 兵→e5　2. 白 馬→c3」
export function pathZh(sans) {
  const out = [];
  sans.forEach((s, i) => {
    const w = i % 2 === 0;
    out.push((w ? `${i / 2 + 1}. ` : '') + zhSan(s, w));
  });
  return out.join('　');
}

// 比例 → 文字：1% 以上取整數，不到 1% 取一位小數
export function fmtPct(r) {
  const v = Number(r) * 100;
  if (!Number.isFinite(v)) return '—';
  return v >= 1 ? Math.round(v) + '%' : v.toFixed(1) + '%';
}

/* ---------- 走一步（有快取）---------- */

const trans = new Map();

// 回傳 {fen, from, to, cap, san, white, over} 或 null（不合法）
export function step(fen, san) {
  const k = fen + '|' + san;
  if (trans.has(k)) return trans.get(k);
  let r = null;
  try {
    const g = new Chess(fen);
    const m = g.move(san);
    r = { fen: g.fen(), from: m.from, to: m.to, cap: !!m.captured, san: m.san, white: m.color === 'w', over: g.isGameOver() };
  } catch (e) { r = null; }
  trans.set(k, r);
  return r;
}

function isMine(rep, fen) {
  return fen.split(' ')[1] === (rep.color === 'black' ? 'b' : 'w');
}

function replyRatio(node, san) {
  if (!node || !Array.isArray(node.replies)) return 0;
  const n = normSan(san);
  for (const r of node.replies) if (normSan(r[0]) === n) return Number(r[1]) || 0;
  return 0;
}

function sortedReplies(node) {
  return (Array.isArray(node.replies) ? node.replies : [])
    .filter(r => Array.isArray(r) && Number(r[1]) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
}

// 著法紀錄（線上的一步）
function mkMove(rep, fenBefore, st, node, reach, ratio) {
  const key = fen4(fenBefore);
  const mine = isMine(rep, fenBefore);
  return {
    san: st.san, white: st.white, from: st.from, to: st.to, cap: st.cap,
    fenBefore, fenAfter: st.fen, key,
    me: mine, node: mine && node && node.me ? node : null,
    id: mine && node && node.me ? nodeId(rep, key) : null,
    ratio: mine ? null : ratio, reach,
  };
}

/* ---------- 線 ---------- */

// 從起點照 sans 走，回傳 {moves, fen, reach}；任何一步不合法回 null。
export function prefixInfo(rep, sans) {
  let fen = START_FEN, reach = 1;
  const moves = [];
  for (const san of sans) {
    const node = rep.nodes[fen4(fen)];
    const st = step(fen, san);
    if (!st) return null;
    const mine = isMine(rep, fen);
    let ratio = null;
    if (!mine) { ratio = replyRatio(node, san); reach *= ratio; }
    moves.push(mkMove(rep, fen, st, node, reach, ratio));
    fen = st.fen;
  }
  return { moves, fen, reach };
}

// 從 info 的終點往下走：我方走 best，對手只走（到達率×比例 ≥ thr）的應法。
function buildLines(rep, info, thr, out) {
  const cur = info.moves.slice();
  const stack = new Set();
  const start = info.moves.length;
  const finish = reach => {
    if (out.length < MAX_LINES) out.push({ moves: cur.slice(), start, reach, text: cur.map(m => m.san).join(' ') });
  };
  const rec = (fen, reach) => {
    const key = fen4(fen);
    const node = rep.nodes[key];
    if (!node || stack.has(key) || out.length >= MAX_LINES) { finish(reach); return; }
    const mine = isMine(rep, fen);
    stack.add(key);
    try {
      if (node.me && mine) {
        const st = step(fen, node.best);
        if (!st) { finish(reach); return; }
        cur.push(mkMove(rep, fen, st, node, reach, null));
        if (st.over) finish(reach); else rec(st.fen, reach);
        cur.pop();
      } else if (!node.me && !mine) {
        let n = 0;
        for (const r of sortedReplies(node)) {
          const ratio = Number(r[1]);
          if (reach * ratio < thr - EPS) continue;
          const st = step(fen, r[0]);
          if (!st) continue;
          n++;
          cur.push(mkMove(rep, fen, st, node, reach * ratio, ratio));
          if (st.over) finish(reach * ratio); else rec(st.fen, reach * ratio);
          cur.pop();
        }
        if (!n) finish(reach);
      } else {
        finish(reach);
      }
    } finally { stack.delete(key); }
  };
  for (const m of info.moves) stack.add(m.key);   // 前綴走過的局面也算在路徑上，防循環
  rec(info.fen, info.reach);
}

const cache = new WeakMap();   // rep → Map(「章節id|門檻」→ 線)

// 章節在門檻 thr 下的所有線（依終點到達率由高到低）。
export function chapterLines(rep, chapter, thr) {
  let m = cache.get(rep);
  if (!m) { m = new Map(); cache.set(rep, m); }
  const ck = chapter.id + '|' + thr;
  if (m.has(ck)) return m.get(ck);
  const out = [];
  for (const p of chapter.prefixes || []) {
    const info = prefixInfo(rep, p);
    if (!info || info.reach < thr - EPS) continue;
    buildLines(rep, info, thr, out);
  }
  out.sort((a, b) => b.reach - a.reach);
  m.set(ck, out);
  return out;
}

// 從任一局面（sans：從起點的著法）往下的線。門檻：局面本身到達率不夠時，改用該到達率的 20%，
// 這樣冷門分支也有線可練（只走該分支裡的主要應法）。
export function linesFrom(rep, sans, thr) {
  const info = prefixInfo(rep, sans);
  if (!info) return [];
  const t = info.reach >= thr - EPS ? thr : info.reach * 0.2;
  const out = [];
  buildLines(rep, info, t, out);
  out.sort((a, b) => b.reach - a.reach);
  return out;
}

// 局面資訊（瀏覽分支用）
export function positionAt(rep, sans) {
  const info = prefixInfo(rep, sans);
  if (!info) return null;
  const last = info.moves.length ? info.moves[info.moves.length - 1] : null;
  const node = rep.nodes[fen4(info.fen)] || null;
  let over = false;
  try { over = new Chess(info.fen).isGameOver(); } catch (e) { over = true; }
  return {
    fen: info.fen, node, reach: info.reach, over,
    mine: isMine(rep, info.fen),
    last: last ? { from: last.from, to: last.to } : null,
    cap: last ? last.cap : false,
  };
}

export function commonPrefix(prefixes) {
  if (!prefixes || !prefixes.length) return [];
  const first = prefixes[0];
  let n = first.length;
  for (const p of prefixes) {
    let i = 0;
    while (i < n && i < p.length && p[i] === first[i]) i++;
    n = i;
  }
  return first.slice(0, n);
}

/* ---------- 著法清單與進度 ---------- */

// 章節裡所有「我方著法」（不重複，依線的順序）。每項：{id,key,san,node,line,idx}
export function chapterMoves(rep, chapter, thr) {
  const seen = new Set();
  const out = [];
  for (const line of chapterLines(rep, chapter, thr)) {
    line.moves.forEach((m, idx) => {
      if (!m.me || !m.id || seen.has(m.id)) return;
      seen.add(m.id);
      out.push({ id: m.id, key: m.key, san: m.san, node: m.node, line, idx });
    });
  }
  return out;
}

// 整套開局在門檻 thr 下的我方著法（各章節的聯集）
export function repMoves(rep, ld, thr) {
  const map = new Map();
  for (const ch of ld.chapters || []) {
    for (const it of chapterMoves(rep, ch, thr)) if (!map.has(it.id)) map.set(it.id, it);
  }
  return [...map.values()];
}

// 'new' 未學、'due' 到期、'known' 已熟
export function moveStatus(id, now = Date.now()) {
  if (!store.get(id)) return 'new';
  return store.isDue(id, now) ? 'due' : 'known';
}

export function progressOf(items, now = Date.now()) {
  const p = { total: items.length, known: 0, due: 0, fresh: 0 };
  for (const it of items) {
    const s = moveStatus(it.id, now);
    if (s === 'known') p.known++; else if (s === 'due') p.due++; else p.fresh++;
  }
  return p;
}

export function repProgress(rep, ld, thr, now = Date.now()) {
  return progressOf(repMoves(rep, ld, thr), now);
}

export function dueItems(items, now = Date.now()) {
  return items.filter(it => moveStatus(it.id, now) === 'due');
}

// 章節的「新線」：含未學著法的線，貪婪取到涵蓋所有未學著法為止（依到達率高到低）。
// batch 為正數時只取前 batch 條。
export function newLines(rep, chapter, thr, batch = Infinity, now = Date.now()) {
  const covered = new Set();
  const out = [];
  for (const line of chapterLines(rep, chapter, thr)) {
    const fresh = line.moves.filter(m => m.me && m.id && !covered.has(m.id) && moveStatus(m.id, now) === 'new');
    if (!fresh.length) continue;
    for (const m of fresh) covered.add(m.id);
    out.push(line);
    if (out.length >= batch) break;
  }
  return out;
}

// 該套開局目前等級內 ≥90% 的著法 box ≥ 2 → 升一級（可連升），最多到 levels.length 級。回傳新等級。
export function maybeLevelUp(rep, ld, level, levels) {
  let lv = level;
  while (lv < levels.length) {
    const items = repMoves(rep, ld, levels[lv - 1]);
    const good = items.filter(it => {
      const x = store.get(it.id);
      return x && x.box >= 2;
    }).length;
    if (items.length && good / items.length < 0.9) break;
    lv++;
  }
  return lv;
}
