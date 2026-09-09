/* vera-rater backend adapter.
 *
 * The rating engine talks only to this interface, so the storage decision can
 * change without touching app.js:
 *
 *   init()                     -> Promise<void>
 *   describe()                 -> string shown in the UI
 *   save(record)               -> Promise<'saved'|'queued'>   (throws on failure)
 *   progress(rater, setId)     -> Promise<{ids:Set<string>, at:Map<string,string>,
 *                                           authoritative:boolean}>
 *                                 `at` is the latest rated_at (ISO) per image id, so
 *                                 the app can tell a rating of a since-regenerated
 *                                 image from a current one.
 *
 * 'saved'  means a server confirmed the write.
 * 'queued' means the write left the browser but cannot be confirmed yet — the
 *          honest state for a Google Form, whose response is opaque by design.
 *          Those become 'saved' when a later read of the Sheet finds them.
 */

window.VERABackend = (function () {
  'use strict';

  const cfg = window.VERA_CONFIG;

  // ── shared: a real CSV reader (quoted fields, embedded commas, newlines) ──

  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch !== '\r') field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    const head = rows[0].map(h => h.trim());
    return rows.slice(1)
      .filter(r => r.length && r.some(c => c !== ''))
      .map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
  }

  // ── local: this browser only, no network ─────────────────────────────────

  const LOCAL_KEY = 'vera.ratings.v1';

  const localAdapter = {
    name: 'local',
    authoritative: true,
    async init() {},
    describe() {
      return 'Local only — ratings stay in this browser and reach no server.';
    },
    _all() {
      try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); }
      catch (e) { console.warn('local store unreadable, starting empty', e); return {}; }
    },
    async save(rec) {
      const all = this._all();
      all[`${rec.rater}|${rec.set_id}|${rec.image_id}`] = rec;
      localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
      return 'saved';
    },
    async progress(rater, setId) {
      const ids = new Set(), at = new Map();
      for (const rec of Object.values(this._all())) {
        if (rec.rater === rater && rec.set_id === setId) {
          ids.add(rec.image_id);
          const prev = at.get(rec.image_id);
          if (!prev || (rec.rated_at || '') > prev) at.set(rec.image_id, rec.rated_at || '');
        }
      }
      return { ids, at, authoritative: true };
    },
    async exportCsv() {
      const recs = Object.values(this._all());
      if (!recs.length) return '';
      const cols = ['rater', 'set_id', 'image_id', 'schema_version', 'overall',
                    'pleasantness', 'artifact', 'cue_identifiable',
                    'cue_prominence', 'flags', 'comment', 'rated_at'];
      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      return [cols.join(',')]
        .concat(recs.map(r => cols.map(c => esc(r[c])).join(',')))
        .join('\n');
    },
  };

  // ── googleForm: POST to the form, read progress from the published Sheet ──

  const googleForm = {
    name: 'googleForm',
    authoritative: false,
    _cfg: null,

    async init() {
      const g = cfg.googleForm || {};
      const missing = [];
      if (!g.formUrl) missing.push('formUrl');
      if (!g.sheetCsvUrl) missing.push('sheetCsvUrl');
      for (const k of ['rater', 'set_id', 'image_id', 'overall', 'rated_at']) {
        if (!(g.entries || {})[k]) missing.push(`entries.${k}`);
      }
      if (missing.length) {
        throw new Error('config.js is incomplete for the Google Form backend. ' +
                        'Missing: ' + missing.join(', '));
      }
      if (!/\/formResponse\s*$/.test(g.formUrl)) {
        throw new Error('config.js googleForm.formUrl must end in /formResponse ' +
                        '(you may have pasted the /viewform link).');
      }
      this._cfg = g;
    },

    describe() {
      return 'Google Form — saves post to the form; the Sheet confirms them.';
    },

    async save(rec) {
      const g = this._cfg;
      const body = new URLSearchParams();
      for (const [field, entry] of Object.entries(g.entries)) {
        if (!entry) continue;
        const v = rec[field];
        body.append(entry, v == null ? '' : String(v));
      }
      // The form endpoint sends no CORS headers, so the response is opaque and
      // a 4xx is indistinguishable from a 200. A throw here means the request
      // never left the browser; anything else is 'queued' until the Sheet
      // confirms it.
      await fetch(g.formUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      return 'queued';
    },

    async progress(rater, setId) {
      const g = this._cfg;
      const url = g.sheetCsvUrl + (g.sheetCsvUrl.includes('?') ? '&' : '?') +
                  '_=' + Date.now();
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`Could not read the response Sheet (HTTP ${res.status}). ` +
                        'Check that it is published to the web as CSV.');
      }
      const rows = parseCsv(await res.text());
      const col = g.columns || {};
      const ids = new Set(), at = new Map();
      let skipped = 0;
      for (const row of rows) {
        const r = row[col.rater || 'rater'];
        const s = row[col.set_id || 'set_id'];
        const i = row[col.image_id || 'image_id'];
        if (r === undefined || s === undefined || i === undefined) { skipped++; continue; }
        if (r === rater && s === setId && i) {
          ids.add(i);
          // rated_at is the ISO stamp the app sent; the Sheet's own Timestamp
          // is local time with no zone, so it is only a last resort.
          const t = row[col.rated_at || 'rated_at'] || '';
          const prev = at.get(i);
          if (prev === undefined || t > prev) at.set(i, t);
        }
      }
      if (skipped) {
        console.warn(`progress: ${skipped}/${rows.length} sheet rows lacked the ` +
                     'expected columns and were ignored — check ' +
                     'config.js googleForm.columns against the Sheet headers.');
      }
      return { ids, at, authoritative: true, rows: rows.length, skipped };
    },
  };

  // ── selection ────────────────────────────────────────────────────────────

  const adapters = { local: localAdapter, googleForm: googleForm };
  const chosen = adapters[cfg.backend];
  if (!chosen) {
    throw new Error(`config.js backend must be one of ${Object.keys(adapters)
      .join(', ')} — got ${JSON.stringify(cfg.backend)}`);
  }
  chosen.parseCsv = parseCsv;
  return chosen;
})();
