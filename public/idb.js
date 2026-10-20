// Recordings waiting to be transcribed, stored on the device (IndexedDB).
// Shared by the page and the service worker. Nothing here is ever deleted
// unless the user deletes it or it was transcribed and moved to history.
//
// item: { id, blob, name, type, lang, at, dur, status, text, error, lockAt, retryAt }
// status: 'draft'   – recorded, user hasn't confirmed yet
//         'waiting' – confirmed, will be sent when possible
//         'sending' – being sent right now (lockAt = when)
//         'paused'  – user cancelled while sending; sent only on request
//         'error'   – server refused it (e.g. file too big)
//         'done'    – transcribed; text ready, app will move it to history
self.PendingDB = (() => {
  const DB = 'transcribe-ai';
  const STORE = 'pending';
  const LOCK_MS = 2 * 60 * 1000;

  function open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  function withStore(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      let value;
      const t = db.transaction(STORE, mode);
      t.oncomplete = () => { db.close(); resolve(value); };
      t.onerror = t.onabort = () => { db.close(); reject(t.error); };
      fn(t.objectStore(STORE), (v) => { value = v; });
    }));
  }

  const put = (item) => withStore('readwrite', (s) => s.put(item));
  const del = (id) => withStore('readwrite', (s) => s.delete(id));
  const get = (id) => withStore('readonly', (s, done) => { const r = s.get(id); r.onsuccess = () => done(r.result); });
  const all = () => withStore('readonly', (s, done) => { const r = s.getAll(); r.onsuccess = () => done(r.result || []); });

  function isDue(it, now = Date.now()) {
    if (it.status === 'waiting') return !it.retryAt || now >= it.retryAt;
    if (it.status === 'sending') return now - (it.lockAt || 0) > LOCK_MS; // stale lock
    return false;
  }

  // Atomically mark an item as being sent, so the page and the
  // service worker never send the same recording twice.
  function claim(id, { force = false } = {}) {
    return withStore('readwrite', (s, done) => {
      const r = s.get(id);
      r.onsuccess = () => {
        const it = r.result;
        if (!it) return done(null);
        const ok = force ? it.status !== 'sending' || isDue(it) : isDue(it);
        if (!ok) return done(null);
        it.status = 'sending';
        it.lockAt = Date.now();
        it.retryAt = 0;
        s.put(it);
        done(it);
      };
    });
  }

  // Apply a server/network outcome to a claimed item and save it.
  async function settle(it, outcome) {
    if (outcome.text != null) {
      it.status = 'done';
      it.text = outcome.text;
      it.error = '';
    } else if (outcome.retry) {
      it.status = 'waiting';
      it.error = outcome.error || '';
      it.retryAt = outcome.retryAfter ? Date.now() + outcome.retryAfter : 0;
    } else {
      it.status = 'error';
      it.error = outcome.error || 'התמלול נכשל';
    }
    it.lockAt = 0;
    await put(it);
    return it;
  }

  function classify(status, data) {
    if (status >= 200 && status < 300 && data && typeof data.text === 'string') return { text: data.text };
    const error = (data && data.error) || '';
    if (status === 0) return { retry: true, error: 'אין חיבור לאינטרנט' };
    if (status === 429) return { retry: true, error, retryAfter: 60 * 1000 };
    if (status >= 500) return { retry: true, error, retryAfter: 30 * 1000 };
    return { retry: false, error: error || 'התמלול נכשל' };
  }

  function formFor(it) {
    const fd = new FormData();
    fd.append('file', it.blob, it.name || 'audio.webm');
    fd.append('lang', it.lang || 'he');
    return fd;
  }

  // Background send (no progress UI). Returns the updated item or null if not claimed.
  async function send(id) {
    const it = await claim(id);
    if (!it) return null;
    let status = 0;
    let data = null;
    try {
      const res = await fetch('/api/transcribe', { method: 'POST', body: formFor(it) });
      status = res.status;
      try { data = await res.json(); } catch (_) {}
    } catch (_) {
      status = 0;
    }
    return settle(it, classify(status, data));
  }

  return { put, del, get, all, isDue, claim, settle, classify, formFor, send };
})();
