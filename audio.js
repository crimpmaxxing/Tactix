// 音效：優先播真實錄音（sounds/*.wav，Freesound CC0，見 vendor/LICENSES.md）；
// 錄音載入失敗時退回 Web Audio 合成音。
import * as store from './store.js';

let ctx = null;
let lastErr = '';

// iOS 17+：'playback' 讓網頁音效不受側邊靜音開關影響（但可能暫停背景音樂）；'auto' 照系統規則
function applySession() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = store.getSettings().ignoreMute ? 'playback' : 'auto';
  } catch (e) { lastErr = 'audioSession: ' + e.message; }
}

function ensure() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      applySession();
      ctx = new AC();
      loadAll(ctx);
    }
    // iPhone 的 App 切到背景再回來時，狀態會是 'interrupted'（不是 'suspended'），一律恢復
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  } catch (e) { return null; }
}

// iPhone 要在使用者手勢裡建立／恢復 AudioContext；每次觸碰都會呼叫。
// 第一次額外播一段無聲的音，讓 iOS 正式解鎖音訊輸出。
let primed = false;
export function unlock() {
  const c = ensure();
  if (!c || primed) return;
  try {
    const b = c.createBuffer(1, 1, 22050);
    const src = c.createBufferSource();
    src.buffer = b;
    src.connect(c.destination);
    src.start(0);
    primed = true;
  } catch (e) { /* 下次觸碰再試 */ }
}

function tone(c, t, { type = 'sine', f0, f1, dur, gain }) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(c, t, { dur, gain, freq, q = 1, kind = 'bandpass' }) {
  const n = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, n, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = kind;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(c.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}

// 真實錄音：同一段走子錄音（JJTaynos, Freesound #733927, CC0）切出的單次落子
const FILES = { move: 'sounds/move.wav', rec1: 'sounds/capture-1.wav', rec2: 'sounds/capture-2.wav', rec3: 'sounds/capture-3.wav' };
const bufs = {};
let loading = null;
function loadAll(c) {
  if (loading) return loading;
  loading = Promise.all(Object.entries(FILES).map(async ([k, u]) => {
    try {
      const ab = await (await fetch(u)).arrayBuffer();
      bufs[k] = await new Promise((res, rej) => c.decodeAudioData(ab, res, rej));
    } catch (e) { lastErr = `${u}: ${e && e.message ? e.message : e}`; }
  }));
  return loading;
}
function playBuf(c, key, t) {
  const b = bufs[key];
  if (!b) return false;
  const src = c.createBufferSource();
  src.buffer = b;
  src.connect(c.destination);
  src.start(t);
  return true;
}

// Capture 音效三選一（設定頁可試聽）
export const CAPTURE_STYLES = { rec1: 'A・低沉', rec2: 'B・清脆', rec3: 'C・適中' };

// 合成音（錄音載入失敗時用）。
function synthCapture(c, t) {
  noise(c, t, { dur: 0.035, gain: 0.5, freq: 2600, q: 1.4 });
  tone(c, t, { type: 'sine', f0: 1150, f1: 820, dur: 0.05, gain: 0.2 });
  noise(c, t + 0.045, { dur: 0.06, gain: 0.45, freq: 1500, q: 1.1 });
  tone(c, t + 0.045, { type: 'triangle', f0: 560, f1: 380, dur: 0.08, gain: 0.22 });
}
function synthMove(c, t) {
  noise(c, t, { dur: 0.04, gain: 0.35, freq: 1800, kind: 'lowpass' });
  tone(c, t, { type: 'triangle', f0: 700, f1: 380, dur: 0.06, gain: 0.3 });
}

// kind: 'move' | 'capture'；style 只給試聽用
export function play(kind, style) {
  if (!store.getSettings().sound && !style) return;
  const c = ensure();
  if (!c) return;
  try {
    const t = c.currentTime + 0.005;
    if (kind === 'capture') {
      if (!playBuf(c, style || store.getSettings().capture, t)) synthCapture(c, t);
    } else if (!playBuf(c, 'move', t)) synthMove(c, t);
  } catch (e) { lastErr = 'play: ' + (e && e.message ? e.message : e); }
}

/* ---------- 診斷（設定頁用） ---------- */
export function setIgnoreMute() { applySession(); }
export function diag() {
  return {
    state: ctx ? ctx.state : '尚未建立',
    rate: ctx ? ctx.sampleRate : null,
    loaded: Object.keys(bufs).length,
    total: Object.keys(FILES).length,
    session: navigator.audioSession ? navigator.audioSession.type : '不支援',
    err: lastErr,
  };
}
export function testRecorded() { const c = ensure(); if (!c) return false; return playBuf(c, 'rec3', c.currentTime + 0.01); }
export function testSynth() { const c = ensure(); if (!c) return; synthCapture(c, c.currentTime + 0.01); }
// 改用 <audio> 元素播放：在 iOS 上不受靜音開關影響
export function testElement() {
  try {
    const a = new Audio(FILES.rec3);
    return a.play().then(() => 'ok').catch(e => 'fail: ' + e.message);
  } catch (e) { return Promise.resolve('fail: ' + e.message); }
}
