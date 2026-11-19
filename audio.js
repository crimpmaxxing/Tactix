// 音效：用 Web Audio 現場合成兩種短音（走子、吃子），不使用音檔。
import * as store from './store.js';

let ctx = null;

function ensure() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  } catch (e) { return null; }
}

// iPhone 要在使用者手勢裡建立／恢復 AudioContext，所以在第一次觸碰時呼叫。
export function unlock() { ensure(); }

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

// 吃子音效三選一（設定頁可試聽）。全部在 260 Hz 以上，避免 iPhone 喇叭像在震。
export const CAPTURE_STYLES = { wood: '木頭（兩下敲擊）', crisp: '清脆', soft: '柔和' };
const CAPTURE = {
  // 棋子落下、再碰到被吃的子：先硬後鈍的兩下
  wood(c, t) {
    noise(c, t, { dur: 0.035, gain: 0.5, freq: 2600, q: 1.4 });
    tone(c, t, { type: 'sine', f0: 1150, f1: 820, dur: 0.05, gain: 0.2 });
    noise(c, t + 0.045, { dur: 0.06, gain: 0.45, freq: 1500, q: 1.1 });
    tone(c, t + 0.045, { type: 'triangle', f0: 560, f1: 380, dur: 0.08, gain: 0.22 });
  },
  crisp(c, t) {
    noise(c, t, { dur: 0.025, gain: 0.55, freq: 3800, q: 2 });
    tone(c, t, { type: 'sine', f0: 1900, f1: 1300, dur: 0.045, gain: 0.16 });
    tone(c, t + 0.01, { type: 'sine', f0: 950, f1: 700, dur: 0.07, gain: 0.15 });
  },
  soft(c, t) {
    noise(c, t, { dur: 0.08, gain: 0.32, freq: 1100, q: 0.7, kind: 'lowpass' });
    tone(c, t, { type: 'sine', f0: 480, f1: 300, dur: 0.11, gain: 0.24 });
  },
};

// kind: 'move' | 'capture'；style 只給試聽用
export function play(kind, style) {
  if (!store.getSettings().sound && !style) return;
  const c = ensure();
  if (!c) return;
  try {
    const t = c.currentTime + 0.005;
    if (kind === 'capture') {
      (CAPTURE[style || store.getSettings().capture] || CAPTURE.wood)(c, t);
    } else {
      noise(c, t, { dur: 0.04, gain: 0.35, freq: 1800, kind: 'lowpass' });
      tone(c, t, { type: 'triangle', f0: 700, f1: 380, dur: 0.06, gain: 0.3 });
    }
  } catch (e) { /* 音效失敗不影響操作 */ }
}
