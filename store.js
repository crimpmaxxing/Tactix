// 練習進度：localStorage 讀寫全包 try/catch，讀不到就當全新開始。
export const BASE_KEY = 'chesscoach.v1.progress';
export let KEY = BASE_KEY;
// 測試資料模式（?mock=1）用另一個 key，才不會弄髒真正的進度。
export function setNamespace(ns) {
  KEY = ns ? BASE_KEY + '.' + ns : BASE_KEY;
  mem = null;
}
export const INTERVALS = [0, 1, 3, 7, 21]; // 盒 1–5 的間隔（天）

let mem = null;

function num(x, d) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

function normalize(obj) {
  const items = {};
  if (obj && typeof obj === 'object' && obj.items && typeof obj.items === 'object') {
    for (const [id, v] of Object.entries(obj.items)) {
      if (!v || typeof v !== 'object') continue;
      items[id] = {
        box: Math.min(5, Math.max(1, Math.floor(num(v.box, 1)))),
        due: num(v.due, 0),
        right: Math.max(0, Math.floor(num(v.right, 0))),
        wrong: Math.max(0, Math.floor(num(v.wrong, 0))),
        last: num(v.last, 0),
      };
    }
  }
  return { v: 1, items };
}

export function load() {
  if (mem) return mem;
  let obj = null;
  try {
    const t = localStorage.getItem(KEY);
    if (t) obj = JSON.parse(t);
  } catch (e) { obj = null; }
  mem = normalize(obj);
  return mem;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(mem));
    return true;
  } catch (e) { return false; }
}

export function get(id) { return load().items[id] || null; }

export function dueTime(box, now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + INTERVALS[box - 1]).getTime();
}

export function isDue(id, now = Date.now()) {
  const it = get(id);
  return !it || it.due <= now;
}

// 答對升一盒、答錯回第一盒。回傳新狀態。
export function record(id, correct, now = Date.now()) {
  const m = load();
  const it = m.items[id] || { box: 1, due: 0, right: 0, wrong: 0, last: 0 };
  const from = it.box;
  if (correct) { it.box = Math.min(5, it.box + 1); it.right++; }
  else { it.box = 1; it.wrong++; }
  it.due = correct ? dueTime(it.box, now) : now;
  it.last = now;
  m.items[id] = it;
  const saved = save();
  return { from, box: it.box, days: INTERVALS[it.box - 1], saved };
}

export function replaceAll(obj) {
  if (!obj || typeof obj !== 'object' || !obj.items || typeof obj.items !== 'object') {
    throw new Error('格式不對');
  }
  mem = normalize(obj);
  save();
  return Object.keys(mem.items).length;
}

export function clear() {
  mem = normalize(null);
  try { localStorage.removeItem(KEY); } catch (e) { /* 忽略 */ }
}

export function exportText() {
  return JSON.stringify(load(), null, 2);
}

export function counts() {
  const items = Object.values(load().items);
  const boxes = [0, 0, 0, 0, 0];
  for (const it of items) boxes[it.box - 1]++;
  return { total: items.length, boxes };
}

/* ---------- 偏好設定（音效、棋盤配色）---------- */
export const SETTINGS_KEY = 'chesscoach.v1.settings';
let smem = null;

function cleanLevels(x) {
  const out = {};
  if (x && typeof x === 'object' && !Array.isArray(x)) {
    for (const [k, v] of Object.entries(x)) {
      const n = Math.floor(Number(v));
      if (n >= 1 && n <= 4) out[k] = n;
    }
  }
  return out;
}

export function getSettings() {
  if (smem) return smem;
  let o = null;
  try {
    const t = localStorage.getItem(SETTINGS_KEY);
    if (t) o = JSON.parse(t);
  } catch (e) { o = null; }
  smem = {
    sound: o && typeof o.sound === 'boolean' ? o.sound : true,
    board: o && o.board === 'brown' ? 'brown' : 'green',
    ui: o && (o.ui === 'light' || o.ui === 'dark') ? o.ui : 'auto',
    evalbar: o && typeof o.evalbar === 'boolean' ? o.evalbar : true,
    capture: o && ['rec1', 'rec2', 'rec3'].includes(o.capture) ? o.capture : 'rec3',
    ignoreMute: o && typeof o.ignoreMute === 'boolean' ? o.ignoreMute : false,
    // 學習模式：每批新線條數、各套開局目前的等級（{開局id: 1–4}）
    learnBatch: o && o.learnBatch != null && Number.isFinite(Number(o.learnBatch)) ? Math.min(10, Math.max(1, Math.floor(Number(o.learnBatch)))) : 4,
    learnLevel: cleanLevels(o && o.learnLevel),
    // 每日新線上限（0＝不限）；達到後「下一步」改建議複習或實戰模擬
    learnDaily: o && [0, 4, 8, 12, 16].includes(Number(o.learnDaily)) ? Number(o.learnDaily) : 8,
  };
  return smem;
}

export function setSetting(key, value) {
  getSettings()[key] = value;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(smem)); } catch (e) { /* 存不了就只在這次有效 */ }
}
