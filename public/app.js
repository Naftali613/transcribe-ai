(() => {
  const $ = (id) => document.getElementById(id);
  const HISTORY_KEY = 'transcripts.v1';
  const SHARE_CACHE = 'share-inbox';
  const SHARE_KEY = '/shared-audio';
  const RING_LEN = 326.7;

  const state = { file: null, lang: 'he', xhr: null, creep: null, url: null, editing: false };

  /* ---------- Screens ---------- */
  function show(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('is-active'));
    $('screen-' + name).classList.add('is-active');
    window.scrollTo({ top: 0 });
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('is-on'), 2000);
  }

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

  document.querySelectorAll('.lang').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.lang').forEach((x) => { x.classList.remove('is-on'); x.setAttribute('aria-checked', 'false'); });
    b.classList.add('is-on');
    b.setAttribute('aria-checked', 'true');
    state.lang = b.dataset.lang;
  }));

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

  /* ---------- Transcribe ---------- */
  $('btn-start').addEventListener('click', () => {
    if (!state.file) return;
    if (state.file.size > 5.5 * 1024 * 1024) {
      showError('הקובץ גדול מדי (מעל 5.5MB).');
      return;
    }
    transcribe(state.file, state.lang);
  });

  function showError(msg) {
    const e = $('home-error');
    e.textContent = msg;
    e.hidden = false;
  }

  function transcribe(file, lang) {
    show('loading');
    setProgress(0);

    const fd = new FormData();
    fd.append('file', file, file.name || 'audio.ogg');
    fd.append('lang', lang);

    const xhr = new XMLHttpRequest();
    state.xhr = xhr;
    xhr.open('POST', '/api/transcribe');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress((e.loaded / e.total) * 55);
    };
    xhr.upload.onload = () => { setProgress(Math.max(state.pct, 55)); startCreep(); };
    xhr.onload = () => {
      stopCreep();
      state.xhr = null;
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status >= 200 && xhr.status < 300 && typeof data.text === 'string') {
        setProgress(100);
        const entry = saveHistory(data.text, lang, file.name);
        setTimeout(() => openResult(data.text, file, entry.id), 350);
      } else {
        show('home');
        showError(data.error || 'התמלול נכשל. נסה שוב.');
      }
    };
    xhr.onerror = () => {
      stopCreep();
      state.xhr = null;
      show('home');
      showError('אין חיבור לשרת. בדוק את האינטרנט ונסה שוב.');
    };
    xhr.send(fd);
  }

  $('btn-cancel').addEventListener('click', () => {
    if (state.xhr) state.xhr.abort();
    state.xhr = null;
    stopCreep();
    show('home');
  });

  /* ---------- Result ---------- */
  function openResult(text, file, id) {
    state.currentId = id;
    setEditing(false);
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
    show('home');
  });

  /* ---------- Player ---------- */
  const audio = $('audio');
  const fmt = (s) => {
    if (!isFinite(s)) return '00:00';
    s = Math.floor(s);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };

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
    // Some formats (ogg/opus from WhatsApp) report Infinity until fully scanned.
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
    const entry = { id: Date.now().toString(36), text, lang, name: name || '', at: Date.now() };
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
      await cache.delete(SHARE_KEY);
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('X-Filename') || 'הקלטה.ogg');
      return new File([blob], name, { type: blob.type || 'audio/ogg' });
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
    const wait = Math.max(0, MIN_SPLASH - (performance.now() - started));
    await new Promise((r) => setTimeout(r, wait));
    $('splash').classList.add('is-gone');
    setTimeout(() => $('splash').remove(), 800);
    if (shared) {
      setFile(shared);
      transcribe(shared, state.lang);
    }
  }

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
})();
