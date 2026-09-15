#!/usr/bin/env python3
"""
ingest_ratings.py
─────────────────
Pull the raters' judgements out of the response Sheet, write a dated CSV
beside each stimulus set, and fill the `qc` block in each image's sidecar.

    python3 tools/ingest_ratings.py                  # report only, writes nothing
    python3 tools/ingest_ratings.py --write          # also update the sidecars
    python3 tools/ingest_ratings.py --csv rows.csv   # read a file, not the Sheet
    python3 tools/ingest_ratings.py --set vpt_v5_vape

Report-only is the default because the sidecars are the stimulus pipelines'
own files. Run without --write first and read what it says it will change.

Safety properties, in case this is ever edited:

- It only writes `qc` keys that ALREADY EXIST in a sidecar. A key the sidecar
  does not have is reported and skipped, never created, because the pipelines
  read these files and an invented key is a silent schema change.
- It backs every sidecar up before the first write, under
  <set>/qc/sidecar_backup_<stamp>/.
- The sets live on OneDrive, which conflict-renames and reverts files, so
  every write is read back and compared before the run is called a success.
- Nothing is skipped silently. Every row that does not become a rating is
  counted and printed with the reason.
"""

import argparse
import csv
import io
import json
import os
import re
import shutil
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_sets import SETS          # one source of truth for set ids and paths

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SET_BY_ID = {s["set_id"]: s for s in SETS}

# ── how several raters become one judgement ──────────────────────────────
#
# These are QC policy, not implementation detail. Change them here.

# 'worst'    — one rater can veto: any Unusable makes it unusable, then any
#              Borderline makes it borderline. Conservative; a disputed image
#              gets looked at rather than shipped.
# 'majority' — the most common verdict wins; ties fall back to 'worst'.
DECISION_RULE = "worst"

OVERALL_TO_DECISION = {
    "usable":     "accept",
    "borderline": "review",
    "unusable":   "regenerate",
}
SEVERITY = ["usable", "borderline", "unusable"]      # increasing severity

# qc.cue_visible is a three-state judgement, not a coin flip: clear yes, clear
# no, and "the raters did not agree well enough to call it", which stays None
# so a human looks rather than a threshold deciding silently.
CUE_VISIBLE_TRUE_AT = 3.5    # mean cue_identifiable >= this  -> True
CUE_VISIBLE_FALSE_AT = 2.5   # mean cue_identifiable <= this  -> False

NUMERIC_FIELDS = ("pleasantness", "artifact", "cue_identifiable",
                  "cue_prominence")


# ── reading the ratings ──────────────────────────────────────────────────

def sheet_url_from_config():
    """Read sheetCsvUrl out of config.js so there is one source of truth."""
    path = os.path.join(REPO, "config.js")
    with open(path) as fh:
        m = re.search(r"sheetCsvUrl:\s*'([^']+)'", fh.read())
    if not m or not m.group(1):
        sys.exit("ERROR: config.js has no sheetCsvUrl. Pass --csv instead.")
    return m.group(1)


def _fetch_once(url):
    # The published-CSV URL 307-redirects. urllib follows redirects; a bare
    # curl does not, which reads an empty body and looks like an empty sheet.
    sep = "&" if "?" in url else "?"
    req = urllib.request.Request(
        f"{url}{sep}_={int(time.time() * 1000)}",
        headers={"User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=60) as fh:
        text = fh.read().decode("utf-8-sig", "replace")
    return list(csv.DictReader(io.StringIO(text)))


def fetch_rows(url, fetches=3, pause=2.0):
    """Union of several reads of the published Sheet.

    Google serves the published CSV from more than one snapshot, and they are
    not in step: three cache-busted reads seconds apart returned 461, 463 and
    451 rows on 2026-09-09. One read therefore undercounts silently, which for
    a QC pass means an image quietly looks unrated. Read a few times and take
    the union, keyed on the fields that make a row unique.
    """
    def key(r):
        return (r.get("Timestamp", ""), r.get("rater", ""),
                r.get("set_id", ""), r.get("image_id", ""),
                r.get("rated_at", ""))

    seen, raw_counts, distinct_counts = {}, [], []
    for i in range(max(1, fetches)):
        if i:
            time.sleep(pause)
        try:
            rows = _fetch_once(url)
        except Exception as e:
            print(f"  ! read {i + 1} of {fetches} failed: {e}")
            continue
        raw_counts.append(len(rows))
        distinct_counts.append(len({key(r) for r in rows}))
        for r in rows:
            seen.setdefault(key(r), r)

    if not raw_counts:
        sys.exit("ERROR: could not read the published Sheet at all.")

    union = list(seen.values())
    print(f"  {len(raw_counts)} reads returned {raw_counts} rows "
          f"({distinct_counts} distinct); union {len(union)}")

    if max(raw_counts) != min(raw_counts):
        print(f"    the Sheet served snapshots differing by "
              f"{max(raw_counts) - min(raw_counts)} rows, which is why it is "
              f"read more than once")
    gained = len(union) - max(distinct_counts)
    if gained > 0:
        print(f"    {gained} row(s) were in one snapshot but not another and "
              f"a single read would have missed them")
    dups = max(raw_counts) - max(distinct_counts)
    if dups > 0:
        print(f"    {dups} row(s) in a single snapshot share "
              f"rater+set+image+rated_at and were counted once")
    return union


def read_csv_file(path):
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


# ── turning rows into one rating per (rater, set, image) ─────────────────

def collect(rows, wanted_sets):
    """Latest row per (rater, set, image) wins; count every row we drop."""
    latest, dropped = {}, defaultdict(list)

    for n, row in enumerate(rows, start=2):        # row 1 is the header
        rater = (row.get("rater") or "").strip()
        set_id = (row.get("set_id") or "").strip()
        image_id = (row.get("image_id") or "").strip()

        if not rater or not set_id or not image_id:
            dropped["missing rater, set_id or image_id"].append(n)
            continue
        if set_id not in SET_BY_ID:
            dropped[f"unknown set_id {set_id!r}"].append(n)
            continue
        if set_id not in wanted_sets:
            dropped[f"set {set_id} not selected this run"].append(n)
            continue

        key = (rater, set_id, image_id)
        stamp = (row.get("rated_at") or row.get("Timestamp") or "").strip()
        prev = latest.get(key)
        if prev is None or stamp >= prev["_stamp"]:
            row = dict(row)
            row["_stamp"] = stamp
            row["_sheet_row"] = n
            latest[key] = row

    return latest, dropped


def mean(values):
    return round(sum(values) / len(values), 1) if values else None


def aggregate(records):
    """Several raters' rows for one image -> the fields a sidecar can hold."""
    overalls = [r.get("overall", "").strip() for r in records]
    overalls = [o for o in overalls if o in OVERALL_TO_DECISION]

    if not overalls:
        verdict = None
    elif DECISION_RULE == "majority":
        counts = {o: overalls.count(o) for o in set(overalls)}
        top = max(counts.values())
        tied = [o for o, c in counts.items() if c == top]
        verdict = max(tied, key=SEVERITY.index) if len(tied) > 1 else tied[0]
    else:
        verdict = max(overalls, key=SEVERITY.index)

    nums = defaultdict(list)
    for r in records:
        for f in NUMERIC_FIELDS:
            v = (r.get(f) or "").strip()
            if v == "":
                continue
            try:
                nums[f].append(float(v))
            except ValueError:
                print(f"    ! sheet row {r['_sheet_row']}: {f}={v!r} is not a "
                      f"number, ignored for the average")

    cue_mean = mean(nums["cue_identifiable"])
    if cue_mean is None:
        cue_visible = None
    elif cue_mean >= CUE_VISIBLE_TRUE_AT:
        cue_visible = True
    elif cue_mean <= CUE_VISIBLE_FALSE_AT:
        cue_visible = False
    else:
        cue_visible = None                      # genuinely unresolved

    notes = []
    for r in sorted(records, key=lambda r: r.get("rater", "")):
        c = (r.get("comment") or "").strip()
        flags = (r.get("flags") or "").strip()
        bits = []
        if flags:
            bits.append("flags: " + flags.replace(";", ", "))
        if c:
            bits.append(c)
        if bits:
            notes.append(f"{r.get('rater')}: " + " — ".join(bits))

    return {
        "decision": OVERALL_TO_DECISION.get(verdict) if verdict else None,
        "raters": sorted({r.get("rater", "") for r in records}),
        "cue_visible": cue_visible,
        "artifact_severity": mean(nums["artifact"]),
        "notes": "; ".join(notes) or None,
        "_overalls": overalls,
        "_disagree": len(set(overalls)) > 1,
        "_means": {f: mean(nums[f]) for f in NUMERIC_FIELDS},
    }


# ── writing ──────────────────────────────────────────────────────────────

def read_override(side_path):
    """qc.decision_override, if the sidecar carries one.

    Shape: {"decision": "accept"|"review"|"regenerate", "by": "jaa",
            "reason": "...", "at": ISO}. Written by hand (edit_prompt.py-style,
    with a history event), never by this script. A malformed one is an error,
    not a silent fall-through."""
    if not os.path.exists(side_path):
        return None
    with open(side_path) as fh:
        qc = json.load(fh).get("qc") or {}
    ov = qc.get("decision_override")
    if ov is None:
        return None
    if not isinstance(ov, dict) or ov.get("decision") not in OVERALL_TO_DECISION.values():
        sys.exit(f"ERROR: {side_path}: qc.decision_override must be a dict with "
                 f"decision in {sorted(set(OVERALL_TO_DECISION.values()))}; got {ov!r}")
    return ov


def write_sidecar(path, qc_updates, backup_dir, dry_run):
    """Fill existing qc keys only. Returns (changed_keys, skipped_keys)."""
    with open(path) as fh:
        side = json.load(fh)

    qc = side.get("qc")
    if qc is None:
        return [], ["<no qc block at all>"]

    changed, skipped = [], []
    for key, value in qc_updates.items():
        if key not in qc:
            skipped.append(key)          # never invent a key
            continue
        if qc[key] != value:
            qc[key] = value
            changed.append(key)

    if changed and not dry_run:
        os.makedirs(backup_dir, exist_ok=True)
        shutil.copy2(path, os.path.join(backup_dir, os.path.basename(path)))

        tmp = path + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(side, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, path)

        # OneDrive silently reverts and conflict-renames; prove the write stuck
        with open(path) as fh:
            back = json.load(fh)
        for key in changed:
            if back.get("qc", {}).get(key) != qc_updates[key]:
                sys.exit(f"ERROR: {path} did not keep the change to qc.{key} "
                         f"(OneDrive may have reverted it). Stopping so the "
                         f"run is not reported as a success.")

    return changed, skipped


# ── main ─────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", help="read this CSV instead of the published Sheet")
    ap.add_argument("--set", dest="sets", action="append",
                    help="restrict to this set id (repeatable)")
    ap.add_argument("--write", action="store_true",
                    help="actually update the sidecars (default: report only)")
    ap.add_argument("--fetches", type=int, default=3,
                    help="how many times to read the Sheet and union the "
                         "results (default 3; its snapshots disagree)")
    args = ap.parse_args()

    wanted = set(args.sets or SET_BY_ID)
    unknown = wanted - set(SET_BY_ID)
    if unknown:
        sys.exit(f"ERROR: unknown set(s): {', '.join(sorted(unknown))}")

    source = args.csv or sheet_url_from_config()
    print(f"reading {source}")
    rows = (read_csv_file(args.csv) if args.csv
            else fetch_rows(source, fetches=args.fetches))
    print(f"  {len(rows)} data rows\n")

    if not args.write:
        print("REPORT ONLY — no file will be written anywhere. "
              "Re-run with --write to apply.\n")

    latest, dropped = collect(rows, wanted)
    if dropped:
        print("rows not used:")
        for reason, lines in sorted(dropped.items()):
            print(f"  {len(lines):4}  {reason}  (sheet rows "
                  f"{', '.join(map(str, lines[:8]))}"
                  f"{', …' if len(lines) > 8 else ''})")
        print()

    by_image = defaultdict(list)
    for (rater, set_id, image_id), row in latest.items():
        by_image[(set_id, image_id)].append(row)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    exit_code = 0

    for set_id in [s["set_id"] for s in SETS if s["set_id"] in wanted]:
        spec = SET_BY_ID[set_id]
        set_root = os.path.dirname(spec["source_path"])
        qc_dir = os.path.join(set_root, "qc")
        manifest_path = os.path.join(REPO, "sets", set_id, "manifest.json")
        with open(manifest_path) as fh:
            manifest = json.load(fh)
        all_ids = [i["id"] for i in manifest["images"]]

        rated = {img: recs for (s, img), recs in by_image.items() if s == set_id}
        unknown_ids = sorted(set(rated) - set(all_ids))
        for bad in unknown_ids:
            print(f"  ! {set_id}: {bad!r} is not an image in this set, ignored")
            rated.pop(bad)

        # A rating older than the image now on disk describes a file that no
        # longer exists. The manifest's generated_at is the sidecar's
        # generation.timestamp; the app applies the same rule when resuming.
        gen_at = {i["id"]: i.get("generated_at") for i in manifest["images"]}
        superseded = defaultdict(int)
        for img in list(rated):
            g = gen_at.get(img)
            if not g:
                continue
            keep = [r for r in rated[img] if r["_stamp"] and r["_stamp"] > g]
            if len(keep) != len(rated[img]):
                superseded[img] += len(rated[img]) - len(keep)
            if keep:
                rated[img] = keep
            else:
                rated.pop(img)
        if superseded:
            n_rows = sum(superseded.values())
            print(f"  {n_rows} rating(s) on {len(superseded)} image(s) predate the current "
                  f"image file and were not used (image regenerated after rating): "
                  + ", ".join(sorted(superseded)[:8]) + (", …" if len(superseded) > 8 else ""))

        print(f"{set_id}")
        print(f"  {len(rated)}/{len(all_ids)} images have at least one rating")

        by_n = defaultdict(int)
        for recs in rated.values():
            by_n[len({r['rater'] for r in recs})] += 1
        for n in sorted(by_n):
            print(f"    {by_n[n]:4} images rated by {n} rater(s)")
        if not rated:
            print("  nothing to do\n")
            continue

        # dated CSV of what we used, beside the set
        out_csv = os.path.join(qc_dir, f"ratings_{today}.csv")
        cols = ["set_id", "image_id", "raters", "n_raters", "decision",
                "overalls", "disagreement", "cue_visible", "artifact_severity",
                *[f"mean_{f}" for f in NUMERIC_FIELDS], "notes"]

        disagreements, agg_by_image, overridden = [], {}, []
        rows_out = []
        for image_id in all_ids:
            if image_id not in rated:
                continue
            agg = aggregate(rated[image_id])
            ov = read_override(os.path.join(spec["source_path"], f"{image_id}.json"))
            if ov:
                # Jason's call on record in the sidecar beats the rating rule.
                # The ratings still show in `overalls`; only `decision` is his.
                agg["decision"] = ov["decision"]
                overridden.append((image_id, ov))
            agg_by_image[image_id] = agg
            if agg["_disagree"]:
                disagreements.append((image_id, agg["_overalls"]))
            rows_out.append({
                "set_id": set_id, "image_id": image_id,
                "raters": ";".join(agg["raters"]), "n_raters": len(agg["raters"]),
                "decision": agg["decision"] or "",
                "overalls": ";".join(agg["_overalls"]),
                "disagreement": "yes" if agg["_disagree"] else "",
                "cue_visible": "" if agg["cue_visible"] is None else agg["cue_visible"],
                "artifact_severity": agg["artifact_severity"] if agg["artifact_severity"] is not None else "",
                **{f"mean_{f}": (agg["_means"][f] if agg["_means"][f] is not None else "")
                   for f in NUMERIC_FIELDS},
                "notes": agg["notes"] or "",
            })

        if args.write:
            os.makedirs(qc_dir, exist_ok=True)
            with open(out_csv, "w", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=cols)
                w.writeheader()
                w.writerows(rows_out)
            print(f"  wrote {out_csv} ({len(rows_out)} rows)")
        else:
            print(f"  would write {out_csv} ({len(rows_out)} rows)")

        tally = defaultdict(int)
        for r in rows_out:
            tally[r["decision"] or "(no overall)"] += 1
        print("  decisions: " + ", ".join(f"{v} {k}" for k, v in sorted(tally.items())))
        if overridden:
            print(f"  {len(overridden)} decision(s) taken from qc.decision_override "
                  f"instead of the rating rule:")
            for image_id, ov in overridden:
                print(f"    {image_id}: {ov['decision']} ({ov.get('by', '?')}, "
                      f"{str(ov.get('at', ''))[:10]}) — {ov.get('reason', '')}")
        if disagreements:
            print(f"  {len(disagreements)} image(s) where raters disagreed on Overall:")
            for image_id, overalls in disagreements[:10]:
                print(f"    {image_id}: {' vs '.join(overalls)}")
            if len(disagreements) > 10:
                print(f"    … and {len(disagreements) - 10} more (see the CSV)")

        # sidecars
        backup_dir = os.path.join(qc_dir, f"sidecar_backup_{stamp}")
        n_changed = n_unchanged = 0
        missing_keys = defaultdict(int)
        for image_id, agg in agg_by_image.items():
            side_path = os.path.join(spec["source_path"], f"{image_id}.json")
            if not os.path.exists(side_path):
                print(f"  ! sidecar missing for {image_id}: {side_path}")
                exit_code = 1
                continue
            updates = {k: agg[k] for k in
                       ("decision", "raters", "cue_visible",
                        "artifact_severity", "notes")}
            changed, skipped = write_sidecar(side_path, updates, backup_dir,
                                             dry_run=not args.write)
            for k in skipped:
                missing_keys[k] += 1
            if changed:
                n_changed += 1
            else:
                n_unchanged += 1

        verb = "updated" if args.write else "would update"
        print(f"  sidecars: {verb} {n_changed}, already current {n_unchanged}")
        if args.write and n_changed:
            print(f"  backups in {backup_dir}")
        for k, n in sorted(missing_keys.items()):
            print(f"  note: qc.{k} is not a key in {n} sidecar(s) of this set, "
                  f"so it was left alone rather than created")
        print()

    print("done" if args.write else
          "done — report only, nothing was written. Re-run with --write to apply.")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
