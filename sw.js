// Blue Line GM on a phone: this service worker stands in for the Windows program (desktop/BlueLineGM.cs). The game page
// (app.html, the same page the program shows) asks for /api/... and /photos/... exactly as it does on a PC; here those
// requests are answered on the phone:
//  - saves: the phone's own storage (IndexedDB "blgm" / "saves"), never sent anywhere
//  - league data, logos, photos, faces: files published with the app (data/, logos/, nlogos/, photos/, faces/, coaches/),
//    cached as they're first used so the game works offline after that
//  - the 3D game, NHL.com look-ups, roster files: not on a phone (404 - the page carries on without them)
// Updates: a new version is published with a new VERSION; the page's "Check for updates" (GET /api/update) compares
// version.json with this one, and installing it activates the new worker and reloads (index.html's updInstall).
const VERSION = '2026.10.12.7';
const SHELL = 'blgm-shell-' + VERSION, MEDIA = 'blgm-media';
const BASE = new URL('./', self.location).pathname;   // where the app lives (a GitHub Pages project path, or / locally)
// a request's path relative to the app: the game asks for /api/..., /photos/... from the site root (as on a PC), which
// on GitHub Pages is outside the app's folder - the worker still sees them (it serves every request its pages make)
const rel = url => url.pathname.startsWith(BASE) ? url.pathname.slice(BASE.length) : url.pathname.slice(1);
const SHELL_FILES = ['./', 'index.html', 'app.html', 'manifest.webmanifest', 'version.json', 'icon-192.png', 'icon-512.png',
  'data/league.json', 'data/families.json', 'data/coaches.json', 'data/famcoach.json', 'data/hist_extra.json', 'data/menu_arena.jpg',
  'data/logos.json', 'data/photos.json', 'data/awards.json'];
const CDN = ['https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await c.addAll(SHELL_FILES.map(f => new Request(f, { cache: 'reload' })));
    for (const u of CDN) { try { await c.add(new Request(u, { mode: 'no-cors' })); } catch (err) { } }
  })());
});
self.addEventListener('message', e => { if (e.data === 'skip') self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('blgm-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

// ---------- saves (IndexedDB) ----------
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('blgm', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('saves', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function store(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => { const tx = d.transaction('saves', mode), st = tx.objectStore('saves'); let out; const q = fn(st); if (q) q.onsuccess = () => { out = q.result; }; tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); });
}
const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
const text = (t, status) => new Response(t, { status: status || 200, headers: { 'Content-Type': 'text/plain' } });

async function saves(req, url) {
  const id = decodeURIComponent(rel(url).slice('api/saves'.length).replace(/^\//, ''));
  if (!id) {   // the list: [{id, meta, modified}]
    const all = (await store('readonly', st => st.getAll())) || [];
    return json(all.map(s => ({ id: s.id, meta: s.meta || {}, modified: s.t })));
  }
  if (!/^[a-z0-9-]{1,40}$/.test(id)) return text('', 404);
  if (req.method === 'GET') { const s = await store('readonly', st => st.get(id)); return s ? new Response(s.body, { headers: { 'Content-Type': 'application/json' } }) : text('', 404); }
  if (req.method === 'POST') {
    const body = await req.text(); let meta = null;
    try { const m = url.searchParams.get('meta'); if (m) meta = JSON.parse(m); } catch (err) { }
    const old = await store('readonly', st => st.get(id));
    await store('readwrite', st => st.put({ id, body, meta: meta || (old && old.meta) || {}, t: new Date().toISOString().slice(0, 19) }));
    return text('saved');
  }
  if (req.method === 'DELETE') { await store('readwrite', st => st.delete(id)); return text('deleted'); }
  return text('', 405);
}

// ---------- files: the published copy, cached on first use ----------
async function file(path, type) {
  const c = await caches.open(SHELL);
  const hit = await c.match(BASE + path) || await c.match(path);
  if (hit) return hit;
  try { const r = await fetch(BASE + path); if (r.ok) { c.put(BASE + path, r.clone()); return r; } } catch (err) { }
  return text('', 404);
}
async function media(path) {   // photos, logos, faces: their own cache, kept across versions
  const c = await caches.open(MEDIA);
  const hit = await c.match(BASE + path); if (hit) return hit;
  try { const r = await fetch(BASE + path); if (r.ok) { c.put(BASE + path, r.clone()); return r; } return r; } catch (err) { return text('', 404); }
}

async function api(req, url) {
  const p = rel(url);   // 'api/...', 'photos/...', 'assets/...'
  if (p.startsWith('api/saves')) return saves(req, url);
  if (p === 'api/nhl') return file('data/league.json');
  // the live start's real results so far, as published (tools/build_mobile.py copies the PC's update-live.ps1 output);
  // the phone can't fetch NHL.com itself, so a refresh request just gets an answer
  if (p === 'api/nhl/live') return req.method === 'POST' ? text('started') : file('data/live.json');
  if (p === 'api/nhl/live/state') return json({ updated: null, refreshing: false, log: '' });
  if (p === 'api/nhl/families') return file('data/families.json');
  if (p === 'api/nhl/coaches') return file('data/coaches.json');
  if (p === 'api/nhl/famcoach') return file('data/famcoach.json');
  if (p === 'api/logos') return file('data/logos.json');
  if (p === 'api/photos/list') return file('data/photos.json');
  if (p === 'api/awards') return file('data/awards.json');
  if (p.startsWith('api/nhl/logo/')) return media('nlogos/' + p.slice(13));
  if (p.startsWith('api/logo/')) return media('logos/' + p.slice(9));
  if (p === 'api/realdata') { let upd = null; try { upd = (await (await file('version.json')).json()).data; } catch (err) { } return json({ updated: upd, refreshing: false, log: '' }); }
  if (p === 'api/update') {   // a newer version published? (version.json on the network against this worker's)
    try { const v = await (await fetch(BASE + 'version.json', { cache: 'no-store' })).json(); if (v.ver && v.ver !== VERSION) return json({ ver: v.ver, notes: v.notes || '', mb: v.mb || 1 }); } catch (err) { }
    return json({ none: true, have: VERSION });
  }
  if (p === 'api/update/state') return json({ state: '' });
  if (p === 'api/ping') return text('ok');
  if (p === 'api/league') return text('', 204);
  if (p.startsWith('assets/')) return file('data/' + p.slice(7));
  if (p.startsWith('photos/ai/')) return media('faces/' + p.slice(10).replace(/\?.*$/, ''));
  if (p.startsWith('photos/coaches/')) return media('coaches/' + p.slice(15));
  if (/^photos\/[0-9]{1,12}\.png$/.test(p)) return media('photos/' + p.slice(7).replace('.png', '.webp'));   // (WebP: the see-through background kept)
  return text('', 404);   // the 3D game, NHL.com look-ups, HLM files, family photos: not on a phone
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) {   // the 3D library and fonts: cached once, then offline
    if (CDN.includes(url.href) || url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com'))
      e.respondWith(caches.match(e.request).then(h => h || fetch(e.request).then(r => { const c = r.clone(); caches.open(MEDIA).then(m => m.put(e.request, c)); return r; })));
    return;
  }
  const p = rel(url);
  if (p.startsWith('api/') || p.startsWith('photos/') || p.startsWith('assets/')) { e.respondWith(api(e.request, url)); return; }
  if (!url.pathname.startsWith(BASE)) return;   // (another site on the same host: not ours)
  // the app's own files: from this version's cache, else the network
  e.respondWith(caches.open(SHELL).then(c => c.match(e.request, { ignoreSearch: true }).then(h => h || fetch(e.request))));
});
