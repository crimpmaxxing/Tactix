// 改版時把 VERSION 加一，舊的程式快取會在 activate 時刪掉。
// data/*.json 放在另一個快取（DATA_CACHE），改版時不清掉，避免離線時丟失資料。
const VERSION = 'v2.6.1';
const STATIC_CACHE = 'chesscoach-static-' + VERSION;
const DATA_CACHE = 'chesscoach-data';

const STATIC_ASSETS = [
  './',
  'index.html',
  'app.js',
  'store.js',
  'board.js',
  'trainer.js',
  'audio.js',
  'engine.js',
  'overview.js',
  'learn.js',
  'style.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'vendor/chess.js',
  'sounds/move.wav', 'sounds/capture-1.wav', 'sounds/capture-2.wav', 'sounds/capture-3.wav',
  ...['w', 'b'].flatMap(c => ['K', 'Q', 'R', 'B', 'N', 'P'].map(t => `vendor/pieces/${c}${t}.svg`)),
];
// 引擎檔（可能還沒放），抓不到不擋安裝
const OPTIONAL_ASSETS = ['vendor/stockfish/stockfish-19-lite-single.js', 'vendor/stockfish/stockfish-19-lite-single.wasm'];
const DATA_ASSETS = ['data/report.json', 'data/stats.json', 'data/puzzles.json', 'data/openings.json', 'data/learn.json'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const sc = await caches.open(STATIC_CACHE);
    await sc.addAll(STATIC_ASSETS.map(u => new Request(u, { cache: 'reload' })));
    await Promise.all(OPTIONAL_ASSETS.map(u => sc.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    const dc = await caches.open(DATA_CACHE);
    await Promise.all(DATA_ASSETS.map(async u => {
      try {
        if (!(await dc.match(u))) await dc.add(new Request(u, { cache: 'reload' }));
      } catch (e) { /* 資料檔暫時抓不到也不擋安裝 */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('chesscoach-static-') && k !== STATIC_CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isData(url) {
  return url.pathname.includes('/data/') && url.pathname.endsWith('.json');
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 測試用假資料（data/mock/）不快取，每次都直接連網
  if (url.pathname.includes('/data/mock/')) return;

  if (isData(url)) {
    // 先回快取，背景更新
    event.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req, { cache: 'no-cache' }).then(res => {
        if (res && res.ok) cache.put(url.pathname, res.clone());
        return res;
      }).catch(() => null);
      if (hit) { event.waitUntil(net); return hit; }
      return (await net) || new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
    })());
    return;
  }

  // 其他檔案：先找快取，找不到再連網；網頁導覽失敗時回 index.html
  event.respondWith((async () => {
    const cache = await caches.open(STATIC_CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (e) {
      if (req.mode === 'navigate') {
        const idx = await cache.match('index.html');
        if (idx) return idx;
      }
      return new Response('離線中，且這個檔案還沒有快取。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
