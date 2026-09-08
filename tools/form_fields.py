#!/usr/bin/env python3
"""
form_fields.py
──────────────
Read a Google Form's public page and print the entry ids its questions post
under, already shaped for config.js.

    python3 tools/form_fields.py 'https://docs.google.com/forms/d/e/XXXX/viewform'

Matching is by question title, so give the questions the field names the rater
sends: rater, set_id, image_id, schema_version, overall, pleasantness,
artifact, cue_identifiable, cue_prominence, flags, comment, rated_at.
"""

import json
import re
import sys
import urllib.request

FIELDS = ["rater", "set_id", "image_id", "schema_version", "overall",
          "pleasantness", "artifact", "cue_identifiable", "cue_prominence",
          "flags", "comment", "rated_at"]


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as fh:
        return fh.read().decode("utf-8", "replace")


def questions(html):
    """Pull the (title, entry_id) pairs out of FB_PUBLIC_LOAD_DATA_."""
    m = re.search(r"FB_PUBLIC_LOAD_DATA_\s*=\s*(\[.*?\]);\s*</script>", html, re.S)
    if not m:
        sys.exit("ERROR: no FB_PUBLIC_LOAD_DATA_ in the page. Is the URL the "
                 "public /viewform link, and is the form open without sign-in?")
    data = json.loads(m.group(1))
    out = []
    for q in (data[1][1] or []):
        title = (q[1] or "").strip()
        for entry in (q[4] or []):
            out.append((title, f"entry.{entry[0]}"))
    return out


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    url = sys.argv[1].replace("/formResponse", "/viewform")
    found = questions(fetch(url))

    print(f"# {len(found)} question(s) on the form\n")
    for title, entry in found:
        print(f"#   {entry:22} {title!r}")

    by_title = {t.strip().lower(): e for t, e in found}
    print("\n# paste into config.js under googleForm:\n")
    print("    entries: {")
    missing = []
    for f in FIELDS:
        entry = by_title.get(f)
        if entry:
            print(f"      {f + ':':18} '{entry}',")
        else:
            print(f"      {f + ':':18} '',   // NO QUESTION TITLED {f!r}")
            missing.append(f)
    print("    },")

    print(f"\n# matched {len(FIELDS) - len(missing)}/{len(FIELDS)} fields")
    if missing:
        print("# missing question titles: " + ", ".join(missing))
        print("# add a short-answer question with each of those exact titles.")
    print("\n    formUrl: '" + url.replace("/viewform", "/formResponse") + "',")


if __name__ == "__main__":
    main()
