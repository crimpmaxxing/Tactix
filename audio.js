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
  g.gain.setValueAtTime(gain, t);
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
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(c.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}

// kind: 'move' | 'capture'
export function play(kind) {
  if (!store.getSettings().sound) return;
  const c = ensure();
  if (!c) return;
  try {
    const t = c.currentTime + 0.005;
    if (kind === 'capture') {
      noise(c, t, { dur: 0.10, gain: 0.7, freq: 1100, q: 0.8 });
      tone(c, t, { type: 'triangle', f0: 190, f1: 70, dur: 0.14, gain: 0.55 });
    } else {
      noise(c, t, { dur: 0.04, gain: 0.35, freq: 1800, kind: 'lowpass' });
      tone(c, t, { type: 'triangle', f0: 440, f1: 190, dur: 0.07, gain: 0.4 });
    }
  } catch (e) { /* 音效失敗不影響操作 */ }
}
