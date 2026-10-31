/* ===== 与沉 Service Worker：缓存优先 + 后台更新（2026-10-28 重写） =====
   上一版（zika-v3）的病根，就是这次重写要治的：
     ① 打开页面「先取网络」且没有超时 → 弱网下每次都要白等，直到浏览器自己放弃；
     ② 一等就是几十秒，用户以为「装了 SW 才变慢」；
     ③ 缓存名写死 'zika-v3' → 更新后还是命中旧缓存，怎么刷都是旧版。
   这一版的规矩：
     · 缓存名带构建戳 c6247cf37e，每次构建都换新名 → 旧缓存自动作废；
     · 打开页面【先给缓存，秒开】，同时在后台悄悄拉最新版写回缓存；
     · index.html 单独给 30 秒长超时（2.4MB 慢网 3.5 秒必然失败）；
     · version.json 一律不拦截，交给浏览器（不然版本检测永远超时）；
     · 首装预缓存分波 + 单文件超时，单个失败不拖住安装；
     · 页面点「更新」时先发 PRECACHE_NOW 把新版落进缓存，再刷新，才刷得动。
   说明：c6247cf37e / 2026-10-31 22:51 由 build.js 每次构建替换。 */
const CACHE = 'zika-w-c6247cf37e';
const NAV_TIMEOUT = 30000;
const NET_TIMEOUT = 3500;
const PRECACHE = ['./', './index.html', './manifest.json', './2014.pic', './2016.pic', './icon.svg', './icon-192.png', './icon-512.png'];

function fetchT(req, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    fetch(req).then(r => { clearTimeout(t); res(r) }, e => { clearTimeout(t); rej(e) });
  });
}

/* mochi 同款：index 下载「超时后补一发无超时 fetch」。
   国内弱网 30 秒传不完 2.5MB 是常态，超时后不再放弃，而是无超时慢慢传完
   （实测 50~130 秒也能成），否则更新/预缓存永远失败 → 用户永远停在旧版。 */
function fetchIndexRes(url, ms) {
  return fetchT(url, ms).catch(() => fetch(url));
}
/* HTML 完整性：build.js 在 index.html 末尾写 <!-- __ZIKA_EOF__ <ver> -->。
   弱网下响应被中途截断时 fetch 仍返回 ok，残缺体绝不能进缓存（会白屏）。 */
const HTML_EOF_STAMPED = /<!-- __ZIKA_EOF__ [a-z0-9]+ -->/;
function isCompleteHtml(text) {
  return typeof text === 'string' && HTML_EOF_STAMPED.test(String(text).slice(-300));
}
function isIndexUrl(u) {
  const p = String(u);
  return p.endsWith('/index.html') || p.endsWith('./') || /\/$/.test(p);
}
/* 校验通过才写缓存，返回 true/false */
function putIndex(c, url, res) {
  return res.clone().text().then(function (txt) {
    if (!isCompleteHtml(txt)) return false;
    return c.put(url, res).then(function () { return true });
  }).catch(function () { return false });
}

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil((async () => {
    try {
      const c = await caches.open(CACHE);
      for (let i = 0; i < PRECACHE.length; i += 4) {
        await Promise.allSettled(PRECACHE.slice(i, i + 4).map(u =>
          fetchIndexRes(u, isIndexUrl(u) ? NAV_TIMEOUT : NET_TIMEOUT)
            .then(r => {
              if (!r || !r.ok) return null;
              if (isIndexUrl(u)) return putIndex(c, u, r).then(() => null);
              return c.put(u, r.clone()).then(() => null);
            })
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
      let hasIndex = !!(await cur.match('./index.html'));
      const olds = (await caches.keys()).filter(k => k !== CACHE);

      /* mochi 同款：删旧缓存前先「抢救」一份完整旧 index。
         新缓存没 index 时（预缓存全超时/失败）用它兜底，绝不白屏。 */
      let rescued = null;
      for (const k of olds) {
        if (rescued) break;
        try {
          const m = await caches.open(k).then(c => c.match('./index.html')).catch(() => null);
          if (m && m.ok) {
            const txt = await m.clone().text().catch(() => '');
            if (isCompleteHtml(txt)) rescued = m;
          }
        } catch (x) { }
      }
      if (!hasIndex && rescued) {
        await cur.put('./index.html', rescued).catch(() => { });
        hasIndex = true;
      }
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
      const r = await fetchIndexRes('./index.html', NAV_TIMEOUT);
      if (r && r.ok) await putIndex(c, './index.html', r);
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

  /* ★ 关键：iframe 打开 read.html 也属于 navigate。
     以前这里把「所有 navigate」都当成"打开首页"，直接返回缓存的 index.html，
     于是站内「阅读」的 iframe 加载出来的是整个小站（还带开屏动画）。
     现在只有 根路径 / index.html 才返回外壳，其它 .html 当普通文件处理。 */
  const _isShell = (function () {
    const p2 = u.pathname;
    if (/\/index\.html$/.test(p2)) return true;
    if (p2.endsWith('/')) return true;
    if (/\.html?$/i.test(p2)) return false;
    return true;
  })();

  if (req.mode === 'navigate' && _isShell) {
    e.respondWith((async () => {
      try {
        const c = await caches.open(CACHE);
        let hit = await c.match('./index.html');
        if (!hit) hit = await caches.match(req);
        if (hit) {
          e.waitUntil((async () => {
            try {
              const r = await fetchIndexRes(req, NAV_TIMEOUT);
              if (r && r.ok) await putIndex(c, './index.html', r);
            } catch (x) { }
          })());
          return hit;
        }
        const r = await fetchIndexRes(req, NAV_TIMEOUT);
        if (r && r.ok) { putIndex(c, './index.html', r).catch(() => { }); }
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
