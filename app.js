/* vera-rater — schema-driven rating engine.
 *
 * The set manifests carry their own schema, so adding a set or changing an
 * item is a builder change, not a change here. Storage lives behind
 * window.VERABackend; this file never knows which backend is in use.
 */

(function () {
  'use strict';

  const cfg = window.VERA_CONFIG;
  const backend = window.VERABackend;
  const $ = sel => document.querySelector(sel);

  const S = {
    rater: null,
    setId: null,
    manifest: null,
    order: [],          // image ids, deterministically shuffled per rater+set
    idx: 0,
    records: {},        // imageId -> { values:{}, state:'…', at:iso }
    activeRow: 0,
    zoom: false,
    startedAt: null,
    ratedThisSession: 0,
  };

  const RATER_KEY = 'vera.rater';
  const draftKey = () => `vera.draft.${S.rater}.${S.setId}`;

  // ── deterministic per-rater order ────────────────────────────────────────

  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffledOrder(ids, rater, setId) {
    const rnd = mulberry32(hashStr(`${rater}|${setId}`));
    const out = ids.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // ── draft cache ──────────────────────────────────────────────────────────

  function loadDraft() {
    try {
      const raw = localStorage.getItem(draftKey());
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.warn('draft cache unreadable, starting empty', e);
      return {};
    }
  }

  function saveDraft() {
    try {
      localStorage.setItem(draftKey(), JSON.stringify(S.records));
    } catch (e) {
      console.warn('could not write draft cache', e);
    }
  }

  // ── screens ──────────────────────────────────────────────────────────────

  function show(id) {
    for (const el of document.querySelectorAll('.page')) el.hidden = true;
    $(id).hidden = false;
  }

  function fail(title, detail) {
    $('#errTitle').textContent = title;
    $('#errDetail').textContent = detail;
    show('#error');
    console.error(title, detail);
  }

  // ── start: rater code and set picker ─────────────────────────────────────

  let index = null;

  async function boot() {
    try {
      await backend.init();
    } catch (e) {
      fail('Backend not configured', e.message);
      return;
    }
    $('#backendNote').textContent = backend.describe();

    try {
      const res = await fetch('sets/index.json?_=' + Date.now());
      if (!res.ok) throw new Error(`HTTP ${res.status} reading sets/index.json`);
      index = await res.json();
    } catch (e) {
      fail('Could not load the set list',
           e.message + ' — has tools/build_sets.py been run?');
      return;
    }

    const params = new URLSearchParams(location.search);
    const rater = params.get('rater') || localStorage.getItem(RATER_KEY) || '';
    $('#raterInput').value = rater;
    renderPicker();
    show('#picker');
    $('#raterInput').focus();

    const wantSet = params.get('set');
    if (rater && wantSet && index.sets.some(s => s.set_id === wantSet)) {
      if (acceptRater(rater)) startSet(wantSet);
    }
  }

  function acceptRater(code) {
    code = (code || '').trim().toLowerCase();
    if (!code) {
      $('#raterErr').textContent = 'A rater code is required — ratings must be attributable.';
      return false;
    }
    if (cfg.requireKnownRater && !(code in (cfg.raters || {}))) {
      $('#raterErr').textContent =
        `"${code}" is not an issued code. Known codes: ${Object.keys(cfg.raters || {}).join(', ') || '(none configured)'}.`;
      return false;
    }
    $('#raterErr').textContent = '';
    S.rater = code;
    localStorage.setItem(RATER_KEY, code);
    return true;
  }

  function renderPicker() {
    const list = $('#setList');
    list.innerHTML = '';
    for (const s of index.sets) {
      const b = document.createElement('button');
      b.className = 'setcard';
      b.innerHTML =
        `<div><div class="name"></div><div class="meta"></div></div>` +
        `<div class="count"></div>`;
      b.querySelector('.name').textContent = s.title;
      b.querySelector('.meta').textContent = s.subtitle;
      b.querySelector('.count').textContent = `${s.count} images`;
      b.addEventListener('click', () => {
        if (acceptRater($('#raterInput').value)) startSet(s.set_id);
      });
      list.appendChild(b);
    }
  }

  // ── loading a set ────────────────────────────────────────────────────────

  async function startSet(setId) {
    S.setId = setId;
    const entry = index.sets.find(s => s.set_id === setId);
    try {
      const res = await fetch(entry.manifest + '?_=' + Date.now());
      if (!res.ok) throw new Error(`HTTP ${res.status} reading ${entry.manifest}`);
      S.manifest = await res.json();
    } catch (e) {
      fail('Could not load the set', e.message);
      return;
    }

    const ids = S.manifest.images.map(i => i.id);
    S.order = shuffledOrder(ids, S.rater, setId);
    S.records = loadDraft();
    S.startedAt = Date.now();
    S.ratedThisSession = 0;

    // Merge the backend's view of what is already saved. A record the server
    // has but this browser does not becomes 'saved' with no local values, so
    // it counts as done and is skipped rather than silently re-rated.
    try {
      const { ids: done, at } = await backend.progress(S.rater, setId);
      let added = 0, superseded = 0, current = 0;
      for (const id of done) {
        const when = at && at.get(id);
        if (!ratingIsCurrent(id, when)) {
          // The image was regenerated after this rater last rated it. The old
          // row stays in the Sheet as history; here it no longer counts.
          if (S.records[id] && (S.records[id].state === 'saved' || S.records[id].state === 'queued')) {
            S.records[id] = { values: {}, state: 'unrated', superseded: true };
          }
          superseded++;
          continue;
        }
        current++;
        if (!S.records[id]) { S.records[id] = { values: {}, state: 'saved', remote: true, at: when }; added++; }
        else if (S.records[id].state === 'queued') S.records[id].state = 'saved';
      }
      // A local draft can also be older than the image (rated on this browser,
      // then the image changed): apply the same rule to it.
      for (const [id, r] of Object.entries(S.records)) {
        if ((r.state === 'saved' || r.state === 'queued') && !done.has(id) && !ratingIsCurrent(id, r.at)) {
          S.records[id] = { values: {}, state: 'unrated', superseded: true };
          superseded++;
        }
      }
      $('#resumeNote').textContent = (current || superseded)
        ? `Resumed: ${current} of ${S.order.length} already recorded for ${S.rater}` +
          (added ? ` (${added} from another device)` : '') +
          (superseded ? `. ${superseded} image${superseded === 1 ? ' was' : 's were'} ` +
                        'regenerated since you rated them and are back in your queue.' : '.')
        : '';
      saveDraft();
    } catch (e) {
      $('#resumeNote').textContent =
        'Could not read saved progress, so resume is from this browser only: ' + e.message;
      console.warn(e);
    }

    buildRows();
    S.idx = firstUnrated();
    show('#rater');
    render();
  }

  function firstUnrated() {
    const i = S.order.findIndex(id => !isDone(id));
    return i === -1 ? 0 : i;
  }

  const isDone = id => {
    const st = S.records[id] && S.records[id].state;
    return st === 'saved' || st === 'queued';
  };

  // A rating is current if it was made after the image now on disk was
  // generated (manifest `generated_at`, from the stimulus sidecar). No
  // generated_at, or no rating time, means we cannot tell, so it counts.
  function ratingIsCurrent(id, ratedAt) {
    const img = S.manifest.images.find(i => i.id === id);
    const gen = img && img.generated_at;
    if (!gen || !ratedAt) return true;
    const g = Date.parse(gen), r = Date.parse(ratedAt);
    if (Number.isNaN(g) || Number.isNaN(r)) return true;
    return r > g;
  }

  // ── item rows ────────────────────────────────────────────────────────────

  const inputItems = () => S.manifest.schema.filter(
    it => it.type === 'choice' || it.type === 'scale');

  function buildRows() {
    const wrap = $('#items');
    wrap.innerHTML = '';
    S.manifest.schema.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.field = item.field;
      row.dataset.index = String(i);

      const left = document.createElement('div');
      const lab = document.createElement('div');
      lab.className = 'lab';
      lab.textContent = item.label + (item.required ? '' : ' (optional)');
      left.appendChild(lab);

      if (item.type === 'scale') {
        const a = document.createElement('div');
        a.className = 'anch';
        a.textContent = `1 ${item.anchors.low} · 5 ${item.anchors.high}`;
        left.appendChild(a);
      }
      row.appendChild(left);

      if (item.type === 'choice') {
        row.classList.add('tri');
        const keys = document.createElement('div');
        keys.className = 'keys';
        item.options.forEach(opt => {
          const k = document.createElement('button');
          k.className = `k ${opt.tone || ''}`;
          k.dataset.value = opt.value;
          k.textContent = `${opt.key.toUpperCase()} ${opt.label}`;
          k.addEventListener('click', () => { setValue(item.field, opt.value); });
          keys.appendChild(k);
        });
        row.appendChild(keys);
      } else if (item.type === 'scale') {
        const keys = document.createElement('div');
        keys.className = 'keys';
        for (let n = item.min; n <= item.max; n++) {
          const k = document.createElement('button');
          k.className = 'k';
          k.dataset.value = String(n);
          k.textContent = String(n);
          k.addEventListener('click', () => { setValue(item.field, n); });
          keys.appendChild(k);
        }
        row.appendChild(keys);
      } else if (item.type === 'flags') {
        const box = document.createElement('div');
        box.className = 'flags';
        item.options.forEach(opt => {
          const f = document.createElement('button');
          f.className = 'flag';
          f.dataset.value = opt.value;
          f.textContent = `${opt.key.toUpperCase()} ${opt.label}`;
          f.addEventListener('click', () => toggleFlag(opt.value));
          box.appendChild(f);
        });
        row.appendChild(box);
      } else if (item.type === 'text') {
        const ta = document.createElement('textarea');
        ta.id = 'commentBox';
        // "press C ... Escape" means nothing on a phone with no such keys
        ta.placeholder = matchMedia('(pointer:coarse)').matches
          ? 'Comment — tap to type (optional)'
          : 'Comment — press C to type here, Escape to leave';
        ta.addEventListener('input', () => {
          rec().values[item.field] = ta.value;
          markDirty();
        });
        row.appendChild(ta);
      }
      wrap.appendChild(row);
    });

    $('#setTitle').textContent = S.manifest.title;
    $('#instructions').textContent = S.manifest.instructions;
    $('#instructions').title = S.manifest.instructions;   // full text on hover
    $('#raterChip').textContent = S.rater;
  }

  // ── current record ───────────────────────────────────────────────────────

  const curId = () => S.order[S.idx];
  const curImage = () => S.manifest.images.find(i => i.id === curId());

  function rec() {
    const id = curId();
    if (!S.records[id]) S.records[id] = { values: {}, state: 'unrated' };
    if (!S.records[id].values) S.records[id].values = {};
    return S.records[id];
  }

  function markDirty() {
    const r = rec();
    // any touched record is 'edited' until a save resolves it, so the state
    // line never reads "Not yet rated" over a part-filled form
    if (r.state !== 'saving') r.state = 'edited';
    saveDraft();
    renderSaveState();
  }

  function setValue(field, value) {
    rec().values[field] = value;
    markDirty();
    renderRows();
    const items = inputItems();
    const at = items.findIndex(it => it.field === field);
    if (at !== -1 && at === S.activeRow && S.activeRow < items.length - 1) {
      S.activeRow++;
      renderRows();
    }
  }

  function toggleFlag(value) {
    const r = rec();
    const cur = new Set((r.values.flags || '').split(';').filter(Boolean));
    cur.has(value) ? cur.delete(value) : cur.add(value);
    r.values.flags = [...cur].join(';');
    markDirty();
    renderRows();
  }

  function missingRequired() {
    return S.manifest.schema
      .filter(it => it.required)
      .filter(it => {
        const v = rec().values[it.field];
        return v === undefined || v === null || v === '';
      })
      .map(it => it.label);
  }

  // ── rendering ────────────────────────────────────────────────────────────

  function render() {
    const img = curImage();
    $('#imgId').textContent = img.id;
    $('#imgLabel').textContent = img.label;
    $('#imgPos').textContent = `${S.idx + 1} / ${S.order.length}`;
    const el = $('#stimulus');
    el.src = `sets/${S.setId}/images/${img.file}`;
    el.alt = `${img.label} — ${img.id}`;
    S.zoom = false;
    $('#imgWrap').classList.remove('zoom');
    $('#zoomBtn').textContent = 'zoom';
    $('#prevBtn').disabled = S.idx === 0;
    $('#skipBtn').disabled = S.idx >= S.order.length - 1;
    S.activeRow = 0;
    renderRows();
    renderSaveState();
    renderProgress();
    // On a phone the items are scrolled through; a new image must start at
    // the top rather than wherever the last one was left.
    window.scrollTo({ top: 0 });
  }

  function toggleZoom() {
    S.zoom = !S.zoom;
    $('#imgWrap').classList.toggle('zoom', S.zoom);
    $('#zoomBtn').textContent = S.zoom ? 'fit' : 'zoom';
  }

  function renderRows() {
    const items = inputItems();
    const values = rec().values;
    for (const row of document.querySelectorAll('#items .row')) {
      const field = row.dataset.field;
      const item = S.manifest.schema.find(it => it.field === field);
      const inputPos = items.findIndex(it => it.field === field);
      row.classList.toggle('active', inputPos !== -1 && inputPos === S.activeRow);

      if (item.type === 'choice' || item.type === 'scale') {
        for (const k of row.querySelectorAll('.k')) {
          k.classList.toggle('sel', String(values[field] ?? '') === k.dataset.value);
        }
      } else if (item.type === 'flags') {
        const on = new Set((values.flags || '').split(';').filter(Boolean));
        for (const f of row.querySelectorAll('.flag')) {
          f.classList.toggle('on', on.has(f.dataset.value));
        }
      } else if (item.type === 'text') {
        const ta = row.querySelector('textarea');
        if (ta.value !== (values[field] || '')) ta.value = values[field] || '';
      }
    }
  }

  const SAVE_TEXT = {
    unrated: 'Not yet rated',
    edited:  'Edited — press Enter to save',
    saving:  'Saving…',
    queued:  'Sent, not yet confirmed',
    saved:   'Saved',
    failed:  'Save failed',
  };

  function renderSaveState() {
    const r = rec();
    const el = $('#saveState');
    el.className = 'save ' + r.state;
    el.textContent = SAVE_TEXT[r.state] || r.state;
    if (r.state === 'failed') {
      el.textContent = 'Save failed: ' + (r.error || 'unknown') + ' ';
      const b = document.createElement('button');
      b.className = 'secondary';
      b.textContent = 'Retry';
      b.addEventListener('click', () => saveCurrent());
      el.appendChild(b);
    }
  }

  function renderProgress() {
    const segs = $('#segs');
    if (segs.children.length !== S.order.length) {
      segs.innerHTML = '';
      S.order.forEach(() => segs.appendChild(document.createElement('i')));
    }
    let saved = 0, queued = 0, failed = 0;
    S.order.forEach((id, i) => {
      const st = (S.records[id] || {}).state || 'unrated';
      const seg = segs.children[i];
      seg.className = '';
      if (st === 'saved') { seg.classList.add('saved'); saved++; }
      else if (st === 'queued') { seg.classList.add('queued'); queued++; }
      else if (st === 'failed') { seg.classList.add('failed'); failed++; }
      if (i === S.idx) seg.classList.add('cur');
    });

    const done = saved + queued;
    let left = '';
    if (S.ratedThisSession >= 3) {
      const perImg = (Date.now() - S.startedAt) / S.ratedThisSession;
      const mins = Math.round(perImg * (S.order.length - done) / 60000);
      left = mins > 0 ? `, about ${mins} min left` : '';
    }
    const parts = [`${saved} of ${S.order.length} confirmed`];
    if (queued) parts.push(`${queued} awaiting confirmation`);
    if (failed) parts.push(`${failed} failed`);
    $('#progLeft').textContent = parts.join(', ') + left;
    $('#progRight').textContent = `${S.idx + 1} / ${S.order.length}`;
  }

  // ── saving ───────────────────────────────────────────────────────────────

  async function saveCurrent() {
    const missing = missingRequired();
    if (missing.length) {
      $('#saveState').className = 'save failed';
      $('#saveState').textContent = 'Needs: ' + missing.join(', ');
      return false;
    }
    const r = rec();
    const id = curId();
    r.state = 'saving';
    renderSaveState();

    const record = {
      rater: S.rater,
      set_id: S.setId,
      image_id: id,
      schema_version: String(S.manifest.schema_version),
      rated_at: new Date().toISOString(),
    };
    for (const it of S.manifest.schema) {
      record[it.field] = r.values[it.field] ?? '';
    }

    try {
      r.state = await backend.save(record);
      r.error = null;
      r.at = record.rated_at;
      S.ratedThisSession++;
    } catch (e) {
      r.state = 'failed';
      r.error = e.message;
      console.error('save failed', e);
    }
    saveDraft();
    renderSaveState();
    renderProgress();
    return r.state !== 'failed';
  }

  async function saveAndAdvance() {
    const ok = await saveCurrent();
    if (!ok) return;                     // a failed save blocks advancing
    const next = S.order.findIndex((id, i) => i > S.idx && !isDone(id));
    if (next === -1) {
      const anyLeft = S.order.findIndex(id => !isDone(id));
      if (anyLeft === -1) { finish(); return; }
      S.idx = anyLeft;
    } else {
      S.idx = next;
    }
    render();
  }

  function go(delta) {
    const n = S.idx + delta;
    if (n < 0 || n >= S.order.length) return;
    S.idx = n;
    render();
  }

  function nextUnrated() {
    const next = S.order.findIndex((id, i) => i > S.idx && !isDone(id));
    const at = next === -1 ? S.order.findIndex(id => !isDone(id)) : next;
    if (at === -1) { finish(); return; }
    S.idx = at;
    render();
  }

  // ── reconcile: promote queued to saved against the backend's own record ──

  async function reconcile(el) {
    el.textContent = 'Checking…';
    try {
      const { ids, at } = await backend.progress(S.rater, S.setId);
      let promoted = 0, stillQueued = 0;
      for (const [id, r] of Object.entries(S.records)) {
        if (r.state === 'queued' || r.state === 'saved') {
          const confirmed = ids.has(id) && ratingIsCurrent(id, at && at.get(id));
          if (confirmed) { if (r.state === 'queued') promoted++; r.state = 'saved'; }
          else if (r.state === 'queued') stillQueued++;
        }
      }
      saveDraft();
      renderProgress();
      renderSaveState();
      const confirmed = S.order.filter(id => (S.records[id] || {}).state === 'saved').length;
      el.textContent =
        `${confirmed}/${S.order.length} confirmed in the store` +
        (promoted ? `, ${promoted} newly confirmed` : '') +
        (stillQueued ? `, ${stillQueued} still unconfirmed (the Sheet can lag a few minutes)` : '');
    } catch (e) {
      el.textContent = 'Could not check: ' + e.message;
    }
  }

  function finish() {
    const saved = S.order.filter(id => (S.records[id] || {}).state === 'saved').length;
    const queued = S.order.filter(id => (S.records[id] || {}).state === 'queued').length;
    $('#doneSummary').textContent =
      `${saved} of ${S.order.length} confirmed saved` +
      (queued ? `, ${queued} sent but not yet confirmed.` : '.');
    show('#done');
  }

  // ── keyboard ─────────────────────────────────────────────────────────────

  document.addEventListener('keydown', ev => {
    if ($('#rater').hidden) return;
    const ta = document.getElementById('commentBox');
    const inText = document.activeElement === ta;

    if (inText) {
      if (ev.key === 'Escape') { ta.blur(); ev.preventDefault(); }
      return;                            // let every other key type normally
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

    const items = inputItems();
    const key = ev.key.toLowerCase();

    if (ev.key === 'Enter') { ev.preventDefault(); saveAndAdvance(); return; }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      S.activeRow = Math.min(S.activeRow + 1, items.length - 1); renderRows(); return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      S.activeRow = Math.max(S.activeRow - 1, 0); renderRows(); return;
    }
    if (ev.key === 'ArrowLeft')  { ev.preventDefault(); go(-1); return; }
    if (ev.key === 'ArrowRight') { ev.preventDefault(); go(1);  return; }

    if (key === 'c') {
      const box = document.getElementById('commentBox');
      if (box) { ev.preventDefault(); box.focus(); }
      return;
    }
    if (key === 'n') { ev.preventDefault(); nextUnrated(); return; }
    if (key === 'z') { ev.preventDefault(); toggleZoom(); return; }
    if (key === '?') { ev.preventDefault(); $('#hint').hidden = !$('#hint').hidden; return; }

    // letters bound to a choice option or a flag, live from any row
    for (const it of S.manifest.schema) {
      if (it.type === 'choice') {
        const opt = it.options.find(o => o.key === key);
        if (opt) { ev.preventDefault(); setValue(it.field, opt.value); return; }
      }
      if (it.type === 'flags') {
        const opt = it.options.find(o => o.key === key);
        if (opt) { ev.preventDefault(); toggleFlag(opt.value); return; }
      }
    }

    // digits fill the active row
    if (/^[1-9]$/.test(key) && items[S.activeRow]) {
      const it = items[S.activeRow];
      const n = Number(key);
      if (it.type === 'scale' && n >= it.min && n <= it.max) {
        ev.preventDefault(); setValue(it.field, n);
      } else if (it.type === 'choice' && it.options[n - 1]) {
        ev.preventDefault(); setValue(it.field, it.options[n - 1].value);
      }
    }
  });

  // ── wiring ───────────────────────────────────────────────────────────────

  $('#startBtn').addEventListener('click', () => {
    if (acceptRater($('#raterInput').value)) {
      $('#setList').scrollIntoView({ behavior: 'smooth' });
    }
  });
  $('#raterInput').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') $('#startBtn').click();
  });
  $('#backBtn').addEventListener('click', () => { show('#picker'); });

  // The action bar does exactly what the keys do — same functions, so the two
  // routes cannot drift apart. Without it a phone has no way to advance.
  $('#saveNextBtn').addEventListener('click', () => saveAndAdvance());
  $('#prevBtn').addEventListener('click', () => go(-1));
  $('#skipBtn').addEventListener('click', () => go(1));
  $('#zoomBtn').addEventListener('click', toggleZoom);
  $('#imgWrap').addEventListener('click', toggleZoom);
  $('#verifyBtn').addEventListener('click', () => reconcile($('#verifyOut')));
  $('#doneVerifyBtn').addEventListener('click', () => reconcile($('#doneSummary')));
  $('#againBtn').addEventListener('click', () => { show('#picker'); });

  // The local backend is the only store of record for its ratings, so make
  // them retrievable rather than trapped behind localStorage.
  if (typeof backend.exportCsv === 'function') {
    $('#exportBtn').hidden = false;
    $('#exportNote').hidden = false;
    $('#exportBtn').addEventListener('click', async () => {
      const csv = await backend.exportCsv();
      if (!csv) { $('#exportNote').textContent = 'Nothing rated yet.'; return; }
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `vera_ratings_${S.rater}_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }
  $('#hintToggle').addEventListener('click', () => { $('#hint').hidden = !$('#hint').hidden; });

  boot();
})();
