(() => {
  const $ = (id) => document.getElementById(id);
  const DB = window.PendingDB;
  const HISTORY_KEY = 'transcripts.v1';
  const SHARE_CACHE = 'share-inbox';
  const SHARE_KEY = '/shared-audio';
  const RING_LEN = 326.7;
  const SYNC_TAG = 'transcribe-pending';

  const fmt = (s) => {
    if (!isFinite(s)) return '00:00';
    s = Math.floor(s);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const fileOf = (it) => (it.blob ? new File([it.blob], it.name || 'הקלטה.webm', { type: it.type || it.blob.type || 'audio/webm' }) : null);

  const state = { file: null, lang: 'he', xhr: null, creep: null, url: null, editing: false, cancelled: false };

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
  function notice(text, actionLabel, action, ms = 7000) {
    const n = $('notice');
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
  function setFile(file) {
    state.file = file;
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
    const item = { id: newId(), blob, name: `הקלטה-${stamp}.${ext}`, type, lang: state.lang, at: Date.now(), dur: rec.dur, status: 'draft' };
    // Save to the device right away — nothing is lost if the app closes now.
    try { await DB.put(item); } catch (_) {}
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
    try { await DB.del(it.id); } catch (_) {}
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
    const it = rec.item;
    if (!it) return;
    it.lang = state.lang;
    rec.item = null; // keep the blob; it's now owned by the queue
    recAudio.pause();
    $('rec-review').hidden = true;
    $('rec-idle').hidden = false;
    startTranscription(it);
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

  /* ---------- Offline support ---------- */
  function askNotify() {
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    try {
      if (localStorage.getItem('askedNotify')) return;
      localStorage.setItem('askedNotify', '1');
    } catch (_) {}
    try { Notification.requestPermission().catch(() => {}); } catch (_) {}
  }

  function registerSync() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready
      .then((r) => r.sync && r.sync.register(SYNC_TAG))
      .catch(() => {});
  }

  function savedForLater(msg) {
    show('home');
    renderPending();
    registerSync();
    notice(msg || 'אין חיבור לאינטרנט. ההקלטה נשמרה במכשיר ותתומלל אוטומטית כשהחיבור יחזור.');
  }

  /* ---------- Transcribe (with progress) ---------- */
  $('btn-start').addEventListener('click', () => {
    if (!state.file) return;
    if (state.file.size > 5.5 * 1024 * 1024) {
      showError('הקובץ גדול מדי (מעל 5.5MB).');
      return;
    }
    const f = state.file;
    startTranscription({ id: newId(), blob: f, name: f.name || 'הקלטה', type: f.type || '', lang: state.lang, at: Date.now(), status: 'waiting' });
  });

  // Every transcription goes through the device queue first, so a failure
  // never loses the audio.
  async function startTranscription(item) {
    if (!navigator.onLine) askNotify(); // still inside the tap — permission prompt allowed
    $('home-error').hidden = true;
    item.status = 'waiting';
    item.retryAt = 0;
    item.error = '';
    try { await DB.put(item); } catch (_) {}

    if (!navigator.onLine) { savedForLater(); return; }

    let claimed = null;
    try { claimed = await DB.claim(item.id, { force: true }); } catch (_) { claimed = item; }
    if (!claimed) { toast('ההקלטה כבר בתמלול…'); renderPending(); return; }
    runWithProgress(claimed);
  }

  function runWithProgress(item) {
    const file = fileOf(item);
    show('loading');
    setProgress(0);
    state.cancelled = false;

    const xhr = new XMLHttpRequest();
    state.xhr = xhr;
    xhr.open('POST', '/api/transcribe');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress((e.loaded / e.total) * 55); };
    xhr.upload.onload = () => { setProgress(Math.max(state.pct, 55)); startCreep(); };

    const finish = async (status, data) => {
      stopCreep();
      state.xhr = null;
      if (state.cancelled) {
        item.status = 'paused';
        item.lockAt = 0;
        try { await DB.put(item); } catch (_) {}
        show('home');
        renderPending();
        toast('בוטל. ההקלטה שמורה למטה ברשימה');
        return;
      }
      const outcome = DB.classify(status, data);
      if (outcome.text != null) {
        setProgress(100);
        const entry = saveHistory(outcome.text, item.lang, item.name);
        try { await DB.del(item.id); } catch (_) {}
        setTimeout(() => openResult(outcome.text, file, entry.id), 350);
        return;
      }
      try { await DB.settle(item, outcome); } catch (_) {}
      if (outcome.retry) {
        askNotify();
        savedForLater(status === 0
          ? 'החיבור נכשל. ההקלטה נשמרה במכשיר ותתומלל אוטומטית כשהחיבור יחזור.'
          : (outcome.error || 'שירות התמלול לא זמין כרגע.') + ' ההקלטה נשמרה וננסה שוב בעוד רגע.');
      } else {
        show('home');
        renderPending();
        showError(outcome.error);
      }
    };

    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (_) {}
      finish(xhr.status, data);
    };
    xhr.onerror = () => finish(0, null);
    xhr.onabort = () => finish(0, null);
    xhr.send(DB.formFor(item));
  }

  $('btn-cancel').addEventListener('click', () => {
    state.cancelled = true;
    if (state.xhr) state.xhr.abort();
  });

  /* ---------- Background queue ---------- */
  let processing = false;
  async function processQueue() {
    if (processing || !navigator.onLine || state.xhr) return;
    processing = true;
    try {
      let items = [];
      try { items = await DB.all(); } catch (_) {}
      const due = items.filter((i) => DB.isDue(i)).sort((a, b) => a.at - b.at);
      for (const it of due) {
        if (!navigator.onLine || state.xhr) break;
        await DB.send(it.id).catch(() => {});
        renderPending();
      }
    } finally {
      processing = false;
      await collectDone();
    }
  }

  // Move finished items (by the page or the service worker) into history.
  async function collectDone() {
    let items = [];
    try { items = await DB.all(); } catch (_) { return; }
    const done = items.filter((i) => i.status === 'done').sort((a, b) => a.at - b.at);
    for (const it of done) {
      const entry = saveHistory(it.text, it.lang, it.name);
      try { await DB.del(it.id); } catch (_) {}
      const file = fileOf(it);
      notice('ההקלטה שנשמרה תומללה ✓', 'לצפייה', () => openResult(it.text, file, entry.id), 10000);
    }
    renderPending();
  }

  window.addEventListener('online', async () => {
    let items = [];
    try { items = await DB.all(); } catch (_) {}
    if (items.some((i) => i.status === 'waiting' || i.status === 'sending')) toast('החיבור חזר — מתמללים את ההקלטות שנשמרו', 3000);
    processQueue();
  });
  window.addEventListener('offline', renderPending);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) processQueue(); });
  setInterval(() => { if (!document.hidden) processQueue(); }, 30000);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'pending-updated') collectDone();
    });
  }

  /* ---------- Waiting list (on home) ---------- */
  const pAudio = new Audio();
  let pPlaying = null;
  pAudio.addEventListener('ended', () => { pPlaying = null; renderPending(); });
  pAudio.addEventListener('pause', () => { if (pPlaying) { pPlaying = null; renderPending(); } });

  const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
  const ICON_SEND = '<svg class="icon" viewBox="0 0 24 24"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/></svg>';
  const ICON_X = '<svg class="icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  function statusText(it) {
    if (it.status === 'sending') return 'מתמללת…';
    if (it.status === 'waiting') {
      if (!navigator.onLine) return 'ממתינה לאינטרנט';
      return it.error ? it.error + ' — ננסה שוב' : 'בתור לתמלול…';
    }
    if (it.status === 'error') return it.error || 'התמלול נכשל';
    return 'לא נשלחה';
  }

  async function renderPending() {
    let items = [];
    try { items = await DB.all(); } catch (_) {}
    const reviewId = rec.item && rec.item.id;
    items = items.filter((i) => i.status !== 'done' && i.id !== reviewId).sort((a, b) => b.at - a.at);
    $('pending').hidden = items.length === 0;
    $('net-badge').hidden = navigator.onLine;
    const ul = $('pending-list');
    ul.innerHTML = '';
    items.forEach((it) => {
      const li = document.createElement('li');
      li.className = 'pitem' + (it.status === 'error' ? ' is-error' : '');

      const play = document.createElement('button');
      play.className = 'pitem__play';
      play.setAttribute('aria-label', 'השמע');
      play.innerHTML = pPlaying === it.id ? ICON_PAUSE : ICON_PLAY;
      play.disabled = !it.blob;
      play.addEventListener('click', () => {
        if (pPlaying === it.id) { pAudio.pause(); return; }
        if (pAudio.src) URL.revokeObjectURL(pAudio.src);
        pAudio.src = URL.createObjectURL(it.blob);
        pAudio.play().catch(() => {});
        pPlaying = it.id;
        renderPending();
      });

      const info = document.createElement('div');
      info.className = 'pitem__info';
      const title = document.createElement('span');
      title.className = 'pitem__title';
      const d = new Date(it.at);
      const today = d.toDateString() === new Date().toDateString();
      title.textContent = 'הקלטה ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
        + (today ? '' : ' · ' + d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' }));
      const st = document.createElement('span');
      st.className = 'pitem__status';
      st.textContent = statusText(it);
      info.append(title, st);

      const send = document.createElement('button');
      send.className = 'pitem__send';
      send.setAttribute('aria-label', 'תמלל עכשיו');
      send.innerHTML = ICON_SEND;
      send.disabled = it.status === 'sending';
      send.addEventListener('click', () => {
        if (!navigator.onLine) {
          it.status = 'waiting';
          DB.put(it).then(renderPending).catch(() => {});
          registerSync();
          askNotify();
          toast('אין אינטרנט — תתומלל אוטומטית כשהחיבור יחזור', 3000);
          return;
        }
        startTranscription(it);
      });

      const del = document.createElement('button');
      del.className = 'pitem__x';
      del.setAttribute('aria-label', 'מחק הקלטה');
      del.innerHTML = ICON_X;
      del.addEventListener('click', async () => {
        if (!confirm('למחוק את ההקלטה? אי אפשר יהיה לשחזר אותה.')) return;
        if (pPlaying === it.id) pAudio.pause();
        try { await DB.del(it.id); } catch (_) {}
        renderPending();
      });

      li.append(play, info, send, del);
      ul.appendChild(li);
    });
  }

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
    $('file-input').value = '';
    setFile(null);
    renderHistory();
    renderPending();
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
  async function takeSharedFile() {
    const params = new URLSearchParams(location.search);
    if (!params.has('shared')) return null;
    history.replaceState(null, '', '/');
    if (!('caches' in window)) return null;
    try {
      const cache = await caches.open(SHARE_CACHE);
      const res = await cache.match(SHARE_KEY);
      if (!res) return null;
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('X-Filename') || 'הקלטה.ogg');
      const file = new File([blob], name, { type: blob.type || 'audio/ogg' });
      // Move it into the device queue before removing it from the share inbox.
      const item = { id: newId(), blob: file, name, type: file.type, lang: state.lang, at: Date.now(), status: 'waiting' };
      try { await DB.put(item); } catch (_) {}
      await cache.delete(SHARE_KEY);
      return item;
    } catch (_) {
      return null;
    }
  }

  /* ---------- Boot ---------- */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  const started = performance.now();
  const MIN_SPLASH = 1100;

  async function boot() {
    renderHistory();
    const shared = await takeSharedFile();

    // Restore a recording the user hadn't confirmed yet (app was closed during review).
    if (!shared) {
      try {
        const drafts = (await DB.all()).filter((i) => i.status === 'draft').sort((a, b) => b.at - a.at);
        if (drafts[0]) showReview(drafts[0]);
      } catch (_) {}
    }
    await renderPending();

    const wait = Math.max(0, MIN_SPLASH - (performance.now() - started));
    await new Promise((r) => setTimeout(r, wait));
    $('splash').classList.add('is-gone');
    setTimeout(() => $('splash').remove(), 800);

    if (shared) {
      setFile(fileOf(shared));
      startTranscription(shared);
    } else {
      processQueue();
    }
  }

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
})();
