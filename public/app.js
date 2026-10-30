(() => {
  const $ = (id) => document.getElementById(id);
  const DB = window.SlotDB;
  const HISTORY_KEY = 'transcripts.v1';
  const SHARE_CACHE = 'share-inbox';
  const SHARE_KEY = '/shared-audio';
  const APP_VERSION = '10';
  const RING_LEN = 326.7;

  const fmt = (s) => {
    if (!isFinite(s)) return '00:00';
    s = Math.floor(s);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const fileOf = (it) => (it && it.blob ? new File([it.blob], it.name || 'הקלטה.webm', { type: it.type || it.blob.type || 'audio/webm' }) : null);

  const state = { file: null, lang: 'he', xhr: null, creep: null, url: null, editing: false, cancelled: false, booting: true, source: '' };

  // Small anonymous reports (no audio, no text) so problems can be traced in the server logs.
  function diag(event, data = {}) {
    try {
      const body = JSON.stringify({ event, v: APP_VERSION, standalone: matchMedia('(display-mode: standalone)').matches, ...data });
      if (!(navigator.sendBeacon && navigator.sendBeacon('/api/log', body))) {
        fetch('/api/log', { method: 'POST', body, keepalive: true }).catch(() => {});
      }
    } catch (_) {}
  }
  window.addEventListener('error', (e) => diag('js-error', { msg: String(e.message).slice(0, 200), line: e.lineno }));
  window.addEventListener('unhandledrejection', (e) => diag('js-rejection', { msg: String(e.reason && e.reason.message || e.reason).slice(0, 200) }));

  /* ---------- Screens & messages ---------- */
  function show(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('is-active'));
    $('screen-' + name).classList.add('is-active');
    window.scrollTo({ top: 0 });
  }
  const onHome = () => $('screen-home').classList.contains('is-active');

  function toast(msg, ms = 2200) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('is-on'), ms);
  }

  // Top banner with an optional action button
  function notice(text, { tone = 'dark', actionLabel, action, ms = 6000 } = {}) {
    const n = $('notice');
    n.classList.toggle('is-ok', tone === 'ok');
    n.classList.toggle('is-warn', tone === 'warn');
    $('notice-text').textContent = text;
    const b = $('notice-btn');
    b.hidden = !actionLabel;
    b.textContent = actionLabel || '';
    b.onclick = () => { hideNotice(); action && action(); };
    n.hidden = false;
    requestAnimationFrame(() => n.classList.add('is-on'));
    clearTimeout(notice.t);
    notice.t = setTimeout(hideNotice, ms);
  }
  function hideNotice() {
    const n = $('notice');
    n.classList.remove('is-on');
    setTimeout(() => { if (!n.classList.contains('is-on')) n.hidden = true; }, 300);
  }
  $('notice-x').addEventListener('click', hideNotice);

  /* ---------- File selection ---------- */
  function setFile(file, { persist = true } = {}) {
    state.file = file;
    if (persist) {
      if (file) DB.put({ id: 'file', blob: file, name: file.name || 'הקלטה', type: file.type || '' });
      else DB.del('file');
    }
    $('file-chip').hidden = !file;
    $('file-name').textContent = file ? (file.name || 'הקלטה') : '';
    $('btn-start').disabled = !file;
    $('home-error').hidden = true;
  }
  $('file-input').addEventListener('change', (e) => setFile(e.target.files[0] || null));
  $('file-remove').addEventListener('click', () => { $('file-input').value = ''; setFile(null); });

  /* ---------- Bottom sheets ---------- */
  function openSheet(el) {
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('is-open'));
  }
  function closeSheet(el) {
    el.classList.remove('is-open');
    setTimeout(() => { el.hidden = true; }, 280);
  }
  document.querySelectorAll('.sheet').forEach((el) => {
    el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeSheet(el)));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.sheet:not([hidden])').forEach(closeSheet);
  });
  $('btn-whatsapp').addEventListener('click', () => openSheet($('wa-sheet')));
  $('btn-history').addEventListener('click', () => { renderHistory(); openSheet($('hist-sheet')); });

  document.querySelectorAll('.lang').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.lang').forEach((x) => { x.classList.remove('is-on'); x.setAttribute('aria-checked', 'false'); });
    b.classList.add('is-on');
    b.setAttribute('aria-checked', 'true');
    state.lang = b.dataset.lang;
  }));

  /* ---------- Record in app (hold to talk) ---------- */
  const rec = { stream: null, mr: null, chunks: [], start: 0, tick: null, item: null, url: null, dur: 0, holding: false };
  const recBtn = $('btn-rec');
  const recAudio = $('rec-audio');

  function pickMime() {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    if (!window.MediaRecorder) return null;
    return types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  }

  async function recStart(e) {
    e.preventDefault();
    if (rec.mr) return;
    rec.holding = true;
    try { recBtn.setPointerCapture(e.pointerId); } catch (_) {}
    if (pickMime() === null || !navigator.mediaDevices) {
      toast('הדפדפן לא תומך בהקלטה');
      return;
    }
    try {
      if (!rec.stream || !rec.stream.active) {
        rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      }
    } catch (_) {
      rec.holding = false;
      toast('צריך לאשר גישה למיקרופון');
      return;
    }
    // Finger lifted while the permission prompt was open — don't start.
    if (!rec.holding) { releaseMic(); toast('עכשיו החזק את הכפתור ודבר'); return; }

    const mime = pickMime();
    rec.chunks = [];
    rec.mr = new MediaRecorder(rec.stream, mime ? { mimeType: mime } : undefined);
    rec.mr.ondataavailable = (ev) => { if (ev.data && ev.data.size) rec.chunks.push(ev.data); };
    rec.mr.onstop = recFinish;
    rec.mr.start(250);
    rec.start = Date.now();
    if (navigator.vibrate) navigator.vibrate(30);
    recBtn.classList.add('is-rec');
    $('rec-hint').textContent = 'שחרר כדי לסיים';
    $('rec-timer').hidden = false;
    $('rec-timer').textContent = '00:00';
    rec.tick = setInterval(() => { $('rec-timer').textContent = fmt((Date.now() - rec.start) / 1000); }, 250);
  }

  function recStop() {
    rec.holding = false;
    if (!rec.mr || rec.mr.state === 'inactive') return;
    rec.dur = (Date.now() - rec.start) / 1000;
    rec.mr.stop();
  }

  function recResetIdle() {
    clearInterval(rec.tick);
    recBtn.classList.remove('is-rec');
    $('rec-hint').textContent = 'החזק לחוץ ודבר';
    $('rec-timer').hidden = true;
  }

  function releaseMic() {
    if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
    rec.stream = null;
  }

  async function recFinish() {
    const type = rec.mr.mimeType || 'audio/webm';
    rec.mr = null;
    recResetIdle();
    releaseMic();
    if (rec.dur < 0.8) {
      toast('ההקלטה קצרה מדי — החזק לחוץ בזמן הדיבור');
      return;
    }
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    const blob = new Blob(rec.chunks, { type });
    const stamp = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }).replace(':', '-');
    const item = { id: 'rec', blob, name: `הקלטה-${stamp}.${ext}`, type, at: Date.now(), dur: rec.dur };
    // Save to the device right away — nothing is lost if the app closes now.
    await DB.put(item);
    showReview(item);
  }

  function showReview(item) {
    rec.item = item;
    if (rec.url) URL.revokeObjectURL(rec.url);
    rec.url = URL.createObjectURL(item.blob);
    recAudio.src = rec.url;
    $('rec-time').textContent = fmt(item.dur || 0);
    $('rec-prog').style.width = '0%';
    $('rec-idle').hidden = true;
    $('rec-review').hidden = false;
  }

  function hideReview() {
    recAudio.pause();
    recAudio.removeAttribute('src');
    if (rec.url) URL.revokeObjectURL(rec.url);
    rec.url = null;
    rec.item = null;
    $('rec-review').hidden = true;
    $('rec-idle').hidden = false;
  }

  async function discardDraft() {
    const it = rec.item;
    if (!it) return hideReview();
    if ((it.dur || 0) > 15 && !confirm('למחוק את ההקלטה? אי אפשר יהיה לשחזר אותה.')) return false;
    await DB.del('rec');
    hideReview();
    return true;
  }

  recBtn.addEventListener('pointerdown', recStart);
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => recBtn.addEventListener(ev, recStop));
  recBtn.addEventListener('contextmenu', (e) => e.preventDefault());

  $('rec-play').addEventListener('click', () => { recAudio.paused ? recAudio.play() : recAudio.pause(); });
  recAudio.addEventListener('play', () => { $('rec-ic-play').hidden = true; $('rec-ic-pause').hidden = false; });
  const recPaused = () => { $('rec-ic-play').hidden = false; $('rec-ic-pause').hidden = true; };
  recAudio.addEventListener('pause', recPaused);
  recAudio.addEventListener('ended', () => {
    recPaused();
    $('rec-prog').style.width = '100%';
    $('rec-time').textContent = fmt(rec.item ? rec.item.dur : 0);
  });
  recAudio.addEventListener('timeupdate', () => {
    const d = isFinite(recAudio.duration) && recAudio.duration > 0 ? recAudio.duration : (rec.item ? rec.item.dur : 1);
    $('rec-prog').style.width = Math.min(100, (recAudio.currentTime / d) * 100) + '%';
    $('rec-time').textContent = fmt(recAudio.currentTime);
  });

  $('rec-discard').addEventListener('click', discardDraft);
  $('rec-again').addEventListener('click', async () => { if (await discardDraft() !== false) toast('החזק לחוץ ודבר'); });
  $('rec-ok').addEventListener('click', () => {
    if (!rec.item) return;
    recAudio.pause();
    transcribe('rec', fileOf(rec.item));
  });

  /* ---------- Progress ring ---------- */
  function setProgress(p) {
    const v = Math.max(0, Math.min(100, p));
    $('ring-bar').style.strokeDashoffset = RING_LEN * (1 - v / 100);
    $('loading-pct').textContent = Math.round(v) + '%';
    state.pct = v;
  }
  function startCreep() {
    stopCreep();
    state.creep = setInterval(() => {
      const left = 95 - state.pct;
      if (left > 0.2) setProgress(state.pct + left * 0.05);
    }, 300);
  }
  function stopCreep() { clearInterval(state.creep); state.creep = null; }

  function showError(msg) {
    const e = $('home-error');
    e.textContent = msg;
    e.hidden = false;
  }

  /* ---------- Connection messages ---------- */
  function offlineNotice() {
    notice('אין חיבור לאינטרנט. ההקלטה נשמרה כאן — נסה שוב כשהחיבור יחזור.', { tone: 'warn', ms: 6000 });
  }
  window.addEventListener('online', () => notice('החיבור לאינטרנט חזר ✓', { tone: 'ok', ms: 3500 }));
  window.addEventListener('offline', () => notice('אין חיבור לאינטרנט', { tone: 'warn', ms: 3500 }));

  /* ---------- Transcribe ---------- */
  $('btn-start').addEventListener('click', () => {
    if (state.file) transcribe('file', state.file);
  });

  // source: 'rec' (in-app recording) or 'file' (uploaded / shared).
  // The audio stays where it is until the transcription succeeds.
  function transcribe(source, file) {
    if (!file) return;
    $('home-error').hidden = true;
    if (state.source === 'share' && (!navigator.onLine || file.size > 5.5 * 1024 * 1024)) {
      diag('share-transcribe-skipped', { online: navigator.onLine, size: file.size });
      state.source = '';
    }
    if (file.size > 5.5 * 1024 * 1024) {
      show('home');
      showError('הקובץ גדול מדי לתמלול (מעל 5.5MB, בערך שעה של הקלטה).');
      return;
    }
    if (!navigator.onLine) { offlineNotice(); return; }

    show('loading');
    setProgress(0);
    state.cancelled = false;

    const fd = new FormData();
    fd.append('file', file, file.name || 'audio.webm');
    fd.append('lang', state.lang);

    const xhr = new XMLHttpRequest();
    state.xhr = xhr;
    xhr.open('POST', '/api/transcribe');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress((e.loaded / e.total) * 55); };
    xhr.upload.onload = () => { setProgress(Math.max(state.pct, 55)); startCreep(); };

    const finish = (status, data) => {
      stopCreep();
      state.xhr = null;
      if (state.source === 'share') diag('share-transcribe-done', { status, cancelled: state.cancelled, err: data && data.error });
      state.source = '';
      if (state.cancelled) { show('home'); return; }
      if (status >= 200 && status < 300 && data && typeof data.text === 'string') {
        setProgress(100);
        const entry = saveHistory(data.text, state.lang, file.name);
        if (source === 'rec') { DB.del('rec'); hideReview(); }
        else { $('file-input').value = ''; setFile(null); }
        setTimeout(() => openResult(data.text, file, entry.id), 350);
        return;
      }
      show('home');
      if (status === 0) {
        if (!navigator.onLine) offlineNotice();
        else notice('החיבור נכשל. ההקלטה נשמרה כאן — נסה שוב.', { tone: 'warn' });
      } else {
        showError((data && data.error) || 'התמלול נכשל. נסה שוב.');
      }
    };

    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (_) {}
      finish(xhr.status, data);
    };
    xhr.onerror = () => finish(0, null);
    xhr.onabort = () => finish(0, null);
    xhr.send(fd);
  }

  $('btn-cancel').addEventListener('click', () => {
    state.cancelled = true;
    if (state.xhr) state.xhr.abort();
  });

  /* ---------- Result ---------- */
  function openResult(text, file, id) {
    state.currentId = id;
    setEditing(false);
    closeSheet($('hist-sheet'));
    $('transcript').textContent = text;
    $('transcript').scrollTop = 0;
    setupPlayer(file);
    show('result');
  }

  function setEditing(on) {
    const wasEditing = state.editing;
    state.editing = on;
    const t = $('transcript');
    t.contentEditable = on ? 'true' : 'false';
    t.classList.toggle('is-editing', on);
    const btn = $('btn-edit');
    btn.classList.toggle('is-on', on);
    btn.querySelector('span').textContent = on ? 'שמירה' : 'עריכה';
    if (on) {
      t.focus();
    } else if (wasEditing && state.currentId) {
      updateHistory(state.currentId, t.innerText.trim());
    }
  }

  $('btn-edit').addEventListener('click', () => {
    setEditing(!state.editing);
    if (!state.editing) toast('נשמר');
  });

  $('btn-copy').addEventListener('click', async () => {
    const text = $('transcript').innerText.trim();
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('הועתק');
  });

  $('btn-share').addEventListener('click', async () => {
    const text = $('transcript').innerText.trim();
    if (navigator.share) {
      try { await navigator.share({ text }); } catch (_) {}
    } else {
      window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
    }
  });

  $('btn-new').addEventListener('click', () => {
    if (state.editing) setEditing(false);
    $('audio').pause();
    renderHistory();
    show('home');
  });

  /* ---------- Player ---------- */
  const audio = $('audio');
  function buildWave(seed) {
    const w = $('wave');
    w.innerHTML = '';
    let x = seed || 7;
    const n = 48;
    for (let i = 0; i < n; i++) {
      x = (x * 9301 + 49297) % 233280;
      const r = x / 233280;
      const env = 0.35 + 0.65 * Math.sin((i / n) * Math.PI);
      const s = document.createElement('span');
      s.style.height = Math.max(12, Math.round((0.25 + r * 0.75) * env * 100)) + '%';
      w.appendChild(s);
    }
  }

  function setupPlayer(file) {
    if (state.url) URL.revokeObjectURL(state.url);
    state.url = null;
    audio.pause();
    setPlaying(false);
    if (!file) {
      $('player').hidden = true;
      audio.removeAttribute('src');
      return;
    }
    $('player').hidden = false;
    state.url = URL.createObjectURL(file);
    audio.src = state.url;
    buildWave(file.size % 1000 + 3);
    $('t-cur').textContent = '00:00';
    $('t-dur').textContent = '00:00';
    paintSeek(0);
  }

  function setPlaying(on) {
    $('ic-play').hidden = on;
    $('ic-pause').hidden = !on;
  }

  function paintSeek(frac) {
    const seek = $('seek');
    seek.value = Math.round(frac * 1000);
    seek.style.setProperty('--p', frac * 100 + '%');
    const bars = $('wave').children;
    const upto = Math.floor(frac * bars.length);
    for (let i = 0; i < bars.length; i++) bars[i].classList.toggle('is-played', i < upto);
  }

  $('btn-play').addEventListener('click', () => { audio.paused ? audio.play() : audio.pause(); });
  $('btn-skip').addEventListener('click', () => {
    if (isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, audio.currentTime + 10);
  });
  audio.addEventListener('play', () => setPlaying(true));
  audio.addEventListener('pause', () => setPlaying(false));
  audio.addEventListener('ended', () => setPlaying(false));
  audio.addEventListener('loadedmetadata', () => {
    // Some formats (ogg/opus from WhatsApp, webm) report Infinity until fully scanned.
    if (!isFinite(audio.duration)) {
      audio.currentTime = 1e7;
      audio.addEventListener('timeupdate', function fix() {
        audio.removeEventListener('timeupdate', fix);
        audio.currentTime = 0;
        $('t-dur').textContent = fmt(audio.duration);
      });
    } else {
      $('t-dur').textContent = fmt(audio.duration);
    }
  });
  audio.addEventListener('timeupdate', () => {
    if (!isFinite(audio.duration) || audio.duration === 0) return;
    $('t-cur').textContent = fmt(audio.currentTime);
    if (!state.seeking) paintSeek(audio.currentTime / audio.duration);
  });
  $('seek').addEventListener('input', (e) => {
    state.seeking = true;
    const frac = e.target.value / 1000;
    paintSeek(frac);
    if (isFinite(audio.duration)) $('t-cur').textContent = fmt(frac * audio.duration);
  });
  $('seek').addEventListener('change', (e) => {
    state.seeking = false;
    if (isFinite(audio.duration)) audio.currentTime = (e.target.value / 1000) * audio.duration;
  });

  /* ---------- History ---------- */
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch (_) { return []; }
  }
  function storeHistory(list) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 100))); } catch (_) {}
  }
  function saveHistory(text, lang, name) {
    const entry = { id: newId(), text, lang, name: name || '', at: Date.now() };
    const list = loadHistory();
    list.unshift(entry);
    storeHistory(list);
    return entry;
  }
  function updateHistory(id, text) {
    const list = loadHistory();
    const item = list.find((x) => x.id === id);
    if (item) { item.text = text; storeHistory(list); }
  }

  function renderHistory() {
    const list = loadHistory();
    const ul = $('history-list');
    ul.innerHTML = '';
    $('history-empty').hidden = list.length > 0;
    list.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'history__item';

      const open = document.createElement('button');
      open.className = 'history__open';
      const snip = document.createElement('span');
      snip.className = 'history__snippet';
      snip.dir = 'auto';
      snip.textContent = item.text.replace(/\s+/g, ' ').slice(0, 120) || '(ריק)';
      const meta = document.createElement('span');
      meta.className = 'history__meta';
      const d = new Date(item.at);
      meta.textContent = d.toLocaleDateString('he-IL') + ' · ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
      open.append(snip, meta);
      open.addEventListener('click', () => openResult(item.text, null, item.id));

      const del = document.createElement('button');
      del.className = 'history__del';
      del.setAttribute('aria-label', 'מחק');
      del.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';
      del.addEventListener('click', () => {
        if (!confirm('למחוק את התמלול?')) return;
        storeHistory(loadHistory().filter((x) => x.id !== item.id));
        renderHistory();
      });

      li.append(open, del);
      ul.appendChild(li);
    });
  }

  /* ---------- Shared from WhatsApp ---------- */
  // The service worker leaves the shared file in a cache. We check it on every
  // start (not only when the URL says ?shared), so a reload can't lose it.
  async function takeSharedFile() {
    const params = new URLSearchParams(location.search);
    const viaShare = params.has('shared');
    if (viaShare) history.replaceState(null, '', '/');
    if (!('caches' in window)) { if (viaShare) diag('share-open', { error: 'no-caches' }); return null; }
    try {
      const cache = await caches.open(SHARE_CACHE);
      const metaRes = await cache.match('/share-meta');
      const meta = metaRes ? await metaRes.json().catch(() => null) : null;
      if (metaRes) await cache.delete('/share-meta');
      const res = await cache.match(SHARE_KEY);
      if (!res) {
        if (viaShare || meta) {
          diag('share-open', { found: false, viaShare, meta });
          notice('ההקלטה ששיתפת לא הגיעה לאפליקציה. נסה לשתף שוב.', { tone: 'warn', ms: 7000 });
        }
        return null;
      }
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('X-Filename') || 'הקלטה.ogg');
      const file = new File([blob], name, { type: blob.type || 'audio/ogg' });
      diag('share-open', { found: true, viaShare, size: file.size, type: file.type, name, meta });
      // Keep it on the device before removing it from the share inbox.
      await DB.put({ id: 'file', blob: file, name, type: file.type });
      await cache.delete(SHARE_KEY);
      return file;
    } catch (err) {
      diag('share-open', { error: String(err && err.message || err) });
      return null;
    }
  }

  /* ---------- Boot ---------- */
  if ('serviceWorker' in navigator) {
    // Pick up new versions by itself: when a new service worker takes over,
    // reload once the user isn't in the middle of recording or transcribing.
    let hadController = !!navigator.serviceWorker.controller;
    let reloadPending = false;
    const reloadWhenIdle = () => {
      if (state.booting || rec.mr || state.xhr || state.editing) { setTimeout(reloadWhenIdle, 1500); return; }
      location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; } // first install, nothing to refresh
      if (reloadPending) return;
      reloadPending = true;
      reloadWhenIdle();
    });
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => {});
  }

  const started = performance.now();
  const MIN_SPLASH = 1100;

  async function boot() {
    $('app-version').textContent = 'גרסה ' + APP_VERSION;
    renderHistory();
    let shared = null;
    try {
      shared = await takeSharedFile();

      // Bring back whatever was waiting when the app was closed.
      const [savedRec, savedFile] = await Promise.all([DB.get('rec'), DB.get('file')]);
      if (savedRec && savedRec.blob) showReview(savedRec);
      if (shared) setFile(shared, { persist: false });
      else if (savedFile && savedFile.blob) setFile(fileOf(savedFile), { persist: false });
    } catch (err) {
      diag('boot-error', { msg: String(err && err.message || err) });
    }

    const wait = Math.max(0, MIN_SPLASH - (performance.now() - started));
    await new Promise((r) => setTimeout(r, wait));
    $('splash').classList.add('is-gone');
    setTimeout(() => { const sp = $('splash'); if (sp) sp.remove(); }, 800);

    if (shared) {
      state.source = 'share';
      diag('share-transcribe-start', { online: navigator.onLine, size: shared.size });
      transcribe('file', shared);
    }
    state.booting = false;
  }

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
})();
