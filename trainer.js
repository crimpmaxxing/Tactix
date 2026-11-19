// 出題共用小工具：判斷走法對錯、組錯誤講解、從講解文字找出對方應著、加權抽樣。
// 題目步驟與開局節點都先轉成同一種「問題」物件：
//   { fen, best, accept:[san], moves:{san:勝率}, why:{san:文字}, whyReply:{san:san}, hint, reply }
import { Chess } from './vendor/chess.js';

export function normSan(s) { return String(s ?? '').replace(/[+#!?]/g, ''); }
export function fen4(fen) { return String(fen).split(' ').slice(0, 4).join(' '); }

// 在字典裡用「去掉 +#!? 的 SAN」找值
export function lookup(map, san) {
  if (!map || typeof map !== 'object') return undefined;
  const n = normSan(san);
  for (const k of Object.keys(map)) if (normSan(k) === n) return map[k];
  return undefined;
}

// 'best' 最佳著、'alt' 也被接受、'wrong' 不對
export function classify(q, san) {
  const n = normSan(san);
  if (normSan(q.best) === n) return 'best';
  if (q.accept.some(a => normSan(a) === n)) return 'alt';
  return 'wrong';
}

// 最佳著要動的棋子在哪一格、走到哪一格
export function bestSquares(q) {
  try {
    const m = new Chess(q.fen).move(q.best);
    return m ? { from: m.from, to: m.to } : null;
  } catch (e) { return null; }
}

// 錯著的說明。有 why 用 why；沒有但有勝率就用勝率；都沒有回空字串。
export function whyText(q, san) {
  const w = lookup(q.why, san);
  if (typeof w === 'string' && w) return w;
  const mine = lookup(q.moves, san);
  const best = lookup(q.moves, q.best);
  if (Number.isFinite(mine) && Number.isFinite(best)) return `這步之後勝率 ${mine}%，最佳是 ${best}%。`;
  return '';
}

// 找出錯著之後對方的應著（SAN）。
// 1. 資料若有 why_reply 就直接用。
// 2. 否則在 why 文字裡找第一個「對方此刻合法」的著法。
// fenAfter：我方走完錯著後的局面（輪到對方）。
export function pickReply(q, san, fenAfter) {
  let legal;
  try { legal = new Chess(fenAfter).moves(); } catch (e) { return null; }
  const map = new Map(legal.map(m => [normSan(m), m]));
  const direct = lookup(q.whyReply, san);
  if (typeof direct === 'string' && map.has(normSan(direct))) return map.get(normSan(direct));
  const text = lookup(q.why, san);
  if (typeof text !== 'string') return null;
  const re = /(?<![A-Za-z0-9])(?:O-O-O|O-O|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)(?![A-Za-z0-9])/g;
  for (const t of text.match(re) || []) {
    const n = normSan(t);
    if (map.has(n)) return map.get(n);
  }
  return null;
}

// items: [{w, ...}]，rnd：0–1 的亂數函式。回傳被抽中的項目。
export function pickWeighted(items, rnd = Math.random) {
  const tot = items.reduce((a, x) => a + Math.max(0, x.w), 0);
  if (!items.length) return null;
  if (tot <= 0) return items[Math.floor(rnd() * items.length)];
  let r = rnd() * tot;
  for (const x of items) {
    r -= Math.max(0, x.w);
    if (r < 0) return x;
  }
  return items[items.length - 1];
}
