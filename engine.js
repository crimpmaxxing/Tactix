// 瀏覽器內的 Stockfish（stockfish.js 19 lite 單執行緒，GPL-3.0，見 vendor/stockfish/Copying.txt）。
// 引擎檔不存在或載入失敗時，available() 回 false，其他功能照常運作。
// analyze(fen, onUpdate)：每次有新的搜尋結果就呼叫 onUpdate({ wpWhite, cp, mate, best, depth })，
// cp／mate 都換算成白方觀點。新的 analyze 會自動停掉舊的。

const ENGINE_URL = 'vendor/stockfish/stockfish-19-lite-single.js';
const MOVETIME = 1500;      // 每個局面最多想 1.5 秒
const K = 0.00368208;       // 與分析程式相同的勝率公式

let worker = null;
let state = 'idle';         // idle | loading | ready | failed
let readyWaiters = [];
let job = null;             // { fen, white, cb, last }
let staleBestmoves = 0;     // 送了 stop 之後，舊搜尋還會回一個 bestmove，要略過

export function wpFromCp(cp) { return 50 + 50 * (2 / (1 + Math.exp(-K * cp)) - 1); }

export function available() { return state !== 'failed'; }
export function isReady() { return state === 'ready'; }

function start() {
  if (state !== 'idle') return;
  state = 'loading';
  try {
    worker = new Worker(ENGINE_URL);
  } catch (e) { fail(); return; }
  worker.onerror = () => fail();
  worker.onmessage = e => onLine(String(e.data || ''));
  worker.postMessage('uci');
  // 10 秒內沒回應就當作沒有引擎
  setTimeout(() => { if (state === 'loading') fail(); }, 10000);
}

function fail() {
  state = 'failed';
  try { if (worker) worker.terminate(); } catch (e) { /* 忽略 */ }
  worker = null;
  for (const w of readyWaiters) w(false);
  readyWaiters = [];
}

function whenReady() {
  if (state === 'ready') return Promise.resolve(true);
  if (state === 'failed') return Promise.resolve(false);
  start();
  return new Promise(res => readyWaiters.push(res));
}

function onLine(line) {
  if (line === 'uciok') { worker.postMessage('isready'); return; }
  if (line === 'readyok' && state === 'loading') {
    state = 'ready';
    for (const w of readyWaiters) w(true);
    readyWaiters = [];
    return;
  }
  if (line.startsWith('bestmove')) {
    if (staleBestmoves > 0) { staleBestmoves--; return; }
    if (job && job.last) job.cb({ ...job.last, done: true });
    job = null;
    return;
  }
  if (!line.startsWith('info') || !job || staleBestmoves > 0) return;
  if (/\bmultipv (?!1\b)\d+/.test(line)) return;
  const d = line.match(/\bdepth (\d+)/);
  const cp = line.match(/\bscore cp (-?\d+)/);
  const mt = line.match(/\bscore mate (-?\d+)/);
  const pv = line.match(/\bpv (\S+)/);
  if (!d || (!cp && !mt) || / (lower|upper)bound/.test(line)) return;
  const sign = job.white ? 1 : -1;     // 引擎分數是「輪到走的一方」觀點
  const r = { depth: Number(d[1]), best: pv ? pv[1] : (job.last && job.last.best) || null, cp: null, mate: null };
  if (mt) {
    r.mate = sign * Number(mt[1]);
    r.wpWhite = r.mate > 0 ? 100 : 0;
  } else {
    r.cp = sign * Number(cp[1]);
    r.wpWhite = wpFromCp(r.cp);
  }
  job.last = r;
  job.cb(r);
}

export async function analyze(fen, cb) {
  stop();
  const my = { fen, white: fen.split(' ')[1] === 'w', cb, last: null };
  job = my;
  const ok = await whenReady();
  if (!ok || job !== my) return;
  worker.postMessage('position fen ' + fen);
  worker.postMessage('go movetime ' + MOVETIME);
  my.started = true;
}

export function stop() {
  if (job && job.started && worker && state === 'ready') {
    worker.postMessage('stop');
    staleBestmoves++;
  }
  job = null;
}

// 預先載入（進到練習頁時呼叫，讓第一次分析不用等）
export function warm() { if (state === 'idle') start(); }
