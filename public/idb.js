// Keeps the current recording / selected file on the device (IndexedDB),
// so it survives leaving the app or a failed transcription.
// Slots: 'rec' – the in-app recording under review, 'file' – the chosen/shared file.
// A slot is cleared only after a successful transcription or when the user removes it.
window.SlotDB = (() => {
  const DB = 'transcribe-ai';
  const STORE = 'slots';

  function open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (db.objectStoreNames.contains('pending')) db.deleteObjectStore('pending');
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
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

  const safe = (p, fallback) => p.catch(() => fallback);

  return {
    put: (item) => safe(withStore('readwrite', (s) => s.put(item))),
    del: (id) => safe(withStore('readwrite', (s) => s.delete(id))),
    get: (id) => safe(withStore('readonly', (s, done) => { const r = s.get(id); r.onsuccess = () => done(r.result || null); }), null),
  };
})();
