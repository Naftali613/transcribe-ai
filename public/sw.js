const VERSION = 'v2';
const SHELL_CACHE = 'shell-' + VERSION;
const SHARE_CACHE = 'share-inbox';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/logo.png', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

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
