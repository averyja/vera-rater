/* vera-rater configuration — the only file you need to edit to change backend.
 *
 * Nothing here is a secret. Everything in this repo is public, so no API token
 * may ever be pasted into this file. The Google Form endpoint needs no token;
 * the REDCap route (later) puts its token in a Cloudflare Worker instead.
 *
 * ── To switch on the Google Form backend ───────────────────────────────────
 *   1. Build the Form and link it to a response Sheet (see docs/BACKEND_GOOGLE.md).
 *   2. Publish that Sheet to the web as CSV.
 *   3. Run:  python3 tools/form_fields.py <form-view-url>
 *      and paste what it prints into `entries` below.
 *   4. Set backend to 'googleForm', fill formUrl and sheetCsvUrl, commit.
 */

window.VERA_CONFIG = {

  // 'local'      — ratings live in this browser only. No setup. Good for trying
  //                the site out; nothing reaches a server.
  // 'googleForm' — POST to a Google Form, read progress back from its Sheet.
  //
  // Still 'local': the response Sheet below is wired up and verified, but
  // googleForm also needs formUrl and entries, which only the form page
  // carries. Switching before those are filled in makes the site refuse to
  // start. Set this to 'googleForm' in the same edit that fills them.
  backend: 'local',

  googleForm: {
    // .../forms/d/e/<LONG_ID>/formResponse   (note: formResponse, not viewform)
    formUrl: '',

    // The response Sheet, File ▸ Share ▸ Publish to web ▸ CSV.
    // Verified 2026-09-08: reachable, CORS-open, headers match the field names.
    sheetCsvUrl: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTC2yW9S15b98dBYwKkOwXWe5Kuomx2AwTJ9bf7i_iw7DZfFxsddkVFkJpl7nzEcy8rxar9cMPPl3l4/pub?gid=2096115639&single=true&output=csv',

    // Google Form field ids. tools/form_fields.py prints this block for you.
    entries: {
      rater:            '',
      set_id:           '',
      image_id:         '',
      schema_version:   '',
      overall:          '',
      pleasantness:     '',
      artifact:         '',
      cue_identifiable: '',
      cue_prominence:   '',
      flags:            '',
      comment:          '',
      rated_at:         '',
    },

    // Column headers in the response Sheet, used to read progress back.
    // These are the Form's question titles, so keep the titles in step.
    columns: { rater: 'rater', set_id: 'set_id', image_id: 'image_id' },
  },

  // Raters type one of these short codes. Add a line per rater; the code is
  // what identifies them in the data, so keep it stable once issued.
  raters: {
    jaa: 'Jason Avery',
    // rk1: 'Second rater',
  },

  // Refuse a rater code that is not in the list above.
  requireKnownRater: true,
};
