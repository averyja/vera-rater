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
  backend: 'googleForm',

  googleForm: {
    // .../forms/d/e/<LONG_ID>/formResponse   (note: formResponse, not viewform)
    // "VERA image ratings" — verified 2026-09-08: publicly reachable with no
    // sign-in, all twelve questions optional, accepting responses.
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLSdTWyWrAwufWmliz0GoXYP1EG41evlFFeg5lM27gwJ73WwlIw/formResponse',

    // The response Sheet, File ▸ Share ▸ Publish to web ▸ CSV.
    // Verified 2026-09-08: reachable, CORS-open, headers match the field names.
    sheetCsvUrl: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTC2yW9S15b98dBYwKkOwXWe5Kuomx2AwTJ9bf7i_iw7DZfFxsddkVFkJpl7nzEcy8rxar9cMPPl3l4/pub?gid=2096115639&single=true&output=csv',

    // Google Form field ids. tools/form_fields.py prints this block for you.
    entries: {
      rater:            'entry.2140325334',
      set_id:           'entry.24781732',
      image_id:         'entry.1442018805',
      schema_version:   'entry.1247332849',
      overall:          'entry.1653953154',
      pleasantness:     'entry.1687993525',
      artifact:         'entry.899921977',
      cue_identifiable: 'entry.2009429021',
      cue_prominence:   'entry.1025474826',
      flags:            'entry.116957713',
      comment:          'entry.542152775',
      rated_at:         'entry.13988456',
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
