// Keeps the current recording / selected file on the device (IndexedDB),
// so it survives leaving the app or a failed transcription.
// Slots: 'rec' – the in-app recording under review, 'file' – the chosen/shared file.
// A slot is cleared only after a successful transcription or when the user removes it.
window.SlotDB = (() => {
  // A fresh database name: the old one ('transcribe-ai') needed a version
  // upgrade, which hangs forever if an older copy of the app is still open.
  const DB = 'transcribe-slots';
  const STORE = 'slots';
  const OPEN_TIMEOUT = 3000;

  try { indexedDB.deleteDatabase('transcribe-ai'); } catch (_) {}

  function open() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
      const timer = setTimeout(() => done(reject, new Error('idb timeout')), OPEN_TIMEOUT);
      let r;
      try { r = indexedDB.open(DB, 1); } catch (e) { done(reject, e); return; }
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      r.onblocked = () => done(reject, new Error('idb blocked'));
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => db.close(); // never block a newer version
        if (settled) { db.close(); return; }
        done(resolve, db);
      };
      r.onerror = () => done(reject, r.error);
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

  const safe = (p, fallback) => p.catch(() => fallback);

  return {
    put: (item) => safe(withStore('readwrite', (s) => s.put(item))),
    del: (id) => safe(withStore('readwrite', (s) => s.delete(id))),
    get: (id) => safe(withStore('readonly', (s, done) => { const r = s.get(id); r.onsuccess = () => done(r.result || null); }), null),
  };
})();
