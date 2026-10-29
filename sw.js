/* ===== 与沉 Service Worker：缓存优先 + 后台更新（2026-10-28 重写） =====
   上一版（zika-v3）的病根，就是这次重写要治的：
     ① 打开页面「先取网络」且没有超时 → 弱网下每次都要白等，直到浏览器自己放弃；
     ② 一等就是几十秒，用户以为「装了 SW 才变慢」；
     ③ 缓存名写死 'zika-v3' → 更新后还是命中旧缓存，怎么刷都是旧版。
   这一版的规矩：
     · 缓存名带构建戳 d3939890f4，每次构建都换新名 → 旧缓存自动作废；
     · 打开页面【先给缓存，秒开】，同时在后台悄悄拉最新版写回缓存；
     · index.html 单独给 30 秒长超时（2.4MB 慢网 3.5 秒必然失败）；
     · version.json 一律不拦截，交给浏览器（不然版本检测永远超时）；
     · 首装预缓存分波 + 单文件超时，单个失败不拖住安装；
     · 页面点「更新」时先发 PRECACHE_NOW 把新版落进缓存，再刷新，才刷得动。
   说明：d3939890f4 / 2026-10-29 14:11 由 build.js 每次构建替换。 */
const CACHE = 'zika-w-d3939890f4';
const NAV_TIMEOUT = 30000;
const NET_TIMEOUT = 3500;
const PRECACHE = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './icon.svg'];

function fetchT(req, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    fetch(req).then(r => { clearTimeout(t); res(r) }, e => { clearTimeout(t); rej(e) });
  });
}

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil((async () => {
    try {
      const c = await caches.open(CACHE);
      for (let i = 0; i < PRECACHE.length; i += 4) {
        await Promise.allSettled(PRECACHE.slice(i, i + 4).map(u =>
          fetchT(u, (u.indexOf('index.html') >= 0 || u === './') ? NAV_TIMEOUT : NET_TIMEOUT)
            .then(r => (r && r.ok) ? c.put(u, r.clone()) : null)
            .catch(() => null)
        ));
      }
    } catch (e) { }
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    try {
      const cur = await caches.open(CACHE);
      const hasIndex = !!(await cur.match('./index.html'));
      const olds = (await caches.keys()).filter(k => k !== CACHE);
      if (hasIndex) {
        await Promise.all(olds.map(k => caches.delete(k).catch(() => { })));
      } else {
        for (const k of olds) {
          const m = await caches.open(k).then(c => c.match('./index.html')).catch(() => null);
          if (!m) await caches.delete(k).catch(() => { });
        }
      }
      await self.clients.claim();
    } catch (e) { }
  })());
});

/* 页面点「更新」：先把最新 index 落进缓存，再让页面刷新 */
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type !== 'PRECACHE_NOW') return;
  e.waitUntil((async () => {
    try {
      const c = await caches.open(CACHE);
      const r = await fetchT('./index.html', NAV_TIMEOUT);
      if (r && r.ok) await c.put('./index.html', r.clone());
    } catch (x) { }
    try { if (e.source && e.source.postMessage) e.source.postMessage({ type: 'PRECACHE_DONE' }) } catch (x) { }
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== self.location.origin) return;
  if (/\/version\.json$/.test(u.pathname) || /\/notice\.json$/.test(u.pathname)) return;

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const c = await caches.open(CACHE);
        let hit = await c.match('./index.html');
        if (!hit) hit = await caches.match(req);
        if (hit) {
          e.waitUntil((async () => {
            try {
              const r = await fetchT(req, NAV_TIMEOUT);
              if (r && r.ok) await c.put('./index.html', r.clone());
            } catch (x) { }
          })());
          return hit;
        }
        const r = await fetchT(req, NAV_TIMEOUT);
        if (r && r.ok) { c.put('./index.html', r.clone()).catch(() => { }); }
        return r;
      } catch (err) {
        const keys = await caches.keys();
        for (const k of keys.sort().reverse()) {
          const m = await caches.match('./index.html', { cacheName: k });
          if (m) return m;
        }
        return fetch(req).catch(() => new Response('离线中，连上网络再打开', {
          status: 503, headers: { 'content-type': 'text/plain;charset=utf-8' }
        }));
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req);
    try {
      const r = await fetchT(req, NET_TIMEOUT);
      if (r && r.ok) c.put(req, r.clone()).catch(() => { });
      return r;
    } catch (err) {
      if (hit) return hit;
      return fetch(req).catch(() => new Response('', { status: 504 }));
    }
  })());
});
