importScripts('/idb.js');

const VERSION = 'v6';
const SHELL_CACHE = 'shell-' + VERSION;
const SHARE_CACHE = 'share-inbox';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/idb.js', '/logo.png', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Audio shared from WhatsApp (Web Share Target)
  if (e.request.method === 'POST' && url.pathname === '/share-target') {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const file = form.getAll('audio').find((f) => f && typeof f === 'object');
        if (file) {
          const cache = await caches.open(SHARE_CACHE);
          await cache.put('/shared-audio', new Response(file, {
            headers: {
              'Content-Type': file.type || 'audio/ogg',
              'X-Filename': encodeURIComponent(file.name || 'הקלטה.ogg'),
            },
          }));
        }
      } catch (_) {}
      return Response.redirect('/?shared=1', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  // Network first, cache fallback — updates show up right away.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/')))
  );
});

// ---------- Recordings saved while offline ----------
// Chrome fires this when connectivity returns, even if the app is closed.
self.addEventListener('sync', (e) => {
  if (e.tag === 'transcribe-pending') e.waitUntil(flushPending());
});

async function flushPending() {
  const items = (await PendingDB.all()).filter((i) => PendingDB.isDue(i)).sort((a, b) => a.at - b.at);
  let done = 0;
  let retry = false;
  let lastText = '';
  for (const it of items) {
    const r = await PendingDB.send(it.id).catch(() => null);
    if (!r) continue;
    if (r.status === 'done') { done++; lastText = r.text || ''; }
    else if (r.status === 'waiting') retry = true;
  }

  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((c) => c.postMessage({ type: 'pending-updated' }));
  const visible = clients.some((c) => c.visibilityState === 'visible');

  if (done && !visible && self.Notification && Notification.permission === 'granted') {
    await self.registration.showNotification(done > 1 ? `${done} הקלטות תומללו` : 'ההקלטה שלך תומללה', {
      body: lastText.replace(/\s+/g, ' ').slice(0, 140),
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'transcribed',
      lang: 'he',
      dir: 'rtl',
    });
  }
  if (retry) throw new Error('retry later'); // the browser retries the sync with backoff
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (cs[0]) {
      await cs[0].focus();
      cs[0].postMessage({ type: 'pending-updated' });
    } else {
      await self.clients.openWindow('/');
    }
  })());
});
