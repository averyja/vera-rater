#!/usr/bin/env python3
"""
build_sets.py
─────────────
Build the web-sized image derivatives and the per-set manifests that drive
the rater, reading the stimulus sidecars as the source of truth.

    python3 tools/build_sets.py                 # all sets
    python3 tools/build_sets.py multicat_v5     # one set
    python3 tools/build_sets.py --manifest-only # re-emit manifests, skip images

Originals stay on OneDrive; only the derivatives land in the repo.
"""

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

# Pillow is imported where it is used, not at module scope: ingest_ratings.py
# imports SETS from here and has no business needing an imaging library.

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETS_DIR = os.path.join(REPO, "sets")

ONEDRIVE = ("/Users/javery/Library/CloudStorage/OneDrive-OklahomaAandMSystem"
            "/Studies/VERA/fMRI_tasks")

MAX_WIDTH = 1400
JPEG_QUALITY = 85

# ── shared item definitions ──────────────────────────────────────────────

OVERALL = {
    "field": "overall",
    "label": "Overall",
    "type": "choice",
    "required": True,
    "options": [
        {"value": "usable",     "label": "Usable",     "key": "u", "tone": "good"},
        {"value": "borderline", "label": "Borderline", "key": "b", "tone": "warn"},
        {"value": "unusable",   "label": "Unusable",   "key": "x", "tone": "bad"},
    ],
}

COMMENT = {
    "field": "comment",
    "label": "Comment",
    "type": "text",
    "required": False,
    "key": "c",
}


def scale(field, label, low, high, required=True):
    return {
        "field": field,
        "label": label,
        "type": "scale",
        "required": required,
        "min": 1,
        "max": 5,
        "anchors": {"low": low, "high": high},
    }


# ── set definitions ──────────────────────────────────────────────────────

SETS = [
    {
        "set_id": "multicat_v5",
        "title": "MULTICAT v5",
        "subtitle": "Localizer images, 5 categories",
        "version": "v5",
        "source_path": (f"{ONEDRIVE}/multicat_localizer/multicat_v5_pipeline/set/images"),
        "glob": "*.json",
        "keep": lambda s: True,
        "instructions": (
            "Judge whether each image is usable as a localizer stimulus for its "
            "category. Use the comment to say what is wrong: people or readable "
            "text in a scene, food that does not look appetising, a vape that is "
            "not recognisable as a vape, a face that reads as angry or outside "
            "21–50, an object that is not a modern everyday item."
        ),
        "schema": [OVERALL, COMMENT],
        "label_of": lambda s: s["category"],
        "meta_of": lambda s: {
            "category": s["category"],
            "role": s.get("role", "scanner"),
            "item": (s.get("item") or {}).get("v5_item"),
            "setting": (s.get("item") or {}).get("setting"),
            "generation_status": (s.get("generation") or {}).get("status"),
        },
    },
    {
        "set_id": "vpt_v5_vape",
        "title": "VPT v5 — vape images",
        "subtitle": "Cue-reactivity stimuli, VAPE condition only",
        "version": "v5",
        "source_path": f"{ONEDRIVE}/VPT_v1/stimulus_set_v5/images",
        "glob": "*.json",
        "keep": lambda s: s.get("condition") == "VAPE",
        "instructions": (
            "Judge each vape image on its own terms. Overall is the QC gate; the "
            "cue items ask whether the device reads as a vape and how much of the "
            "frame it commands. Flag anything a later batch check should catch."
        ),
        "schema": [
            OVERALL,
            scale("pleasantness", "Pleasantness", "Unpleasant", "Very pleasant"),
            scale("artifact", "Artifacts", "None", "Severe"),
            scale("cue_identifiable", "Cue identifiable", "Could be anything",
                  "Unmistakably a vape"),
            scale("cue_prominence", "Cue prominence", "Easy to miss",
                  "Dominates the frame"),
            {
                "field": "flags",
                "label": "Flags",
                "type": "flags",
                "required": False,
                "options": [
                    {"value": "no_vapour",    "label": "Vapour missing",            "key": "v"},
                    {"value": "second_device", "label": "Second device or cigarette", "key": "d"},
                    {"value": "looks_at_cam", "label": "Looks at camera",           "key": "l"},
                    {"value": "readable_text", "label": "Readable text or logo",     "key": "t"},
                    {"value": "scene_mismatch", "label": "Scene mismatch",           "key": "m"},
                ],
            },
            COMMENT,
        ],
        "label_of": lambda s: f"{s['type'].title()} · {s['pair_id']}",
        "meta_of": lambda s: {
            "pair_id": s["pair_id"],
            "type": s["type"],
            "twin_id": s.get("twin_id"),
            "device": s.get("vape_device"),
            "salience": (s.get("scene") or {}).get("salience"),
            "lighting": (s.get("scene") or {}).get("lighting"),
            "generation_status": (s.get("generation") or {}).get("status"),
        },
    },
]


def load_sidecars(spec):
    """Read every sidecar in the source folder, keep the ones the set wants."""
    import glob as globmod

    paths = sorted(globmod.glob(os.path.join(spec["source_path"], spec["glob"])))
    if not paths:
        sys.exit(f"ERROR: no sidecars under {spec['source_path']}")

    kept, skipped_filter, skipped_status = [], 0, []
    for p in paths:
        with open(p) as fh:
            side = json.load(fh)
        if not spec["keep"](side):
            skipped_filter += 1
            continue
        # "success_repaired" is a success: the image generated after a repair
        # pass. Accept every success variant; the variant is kept in the manifest.
        status = (side.get("generation") or {}).get("status") or ""
        if not status.startswith("success"):
            skipped_status.append((side.get("id"), status or "<missing>"))
            continue
        side["_sidecar_path"] = p
        kept.append(side)

    eligible = len(paths) - skipped_filter
    print(f"  sidecars: {len(paths)} found, {skipped_filter} filtered out, "
          f"{len(kept)}/{eligible} eligible kept, "
          f"{len(skipped_status)} not generated")
    for sid, status in skipped_status:
        print(f"    ! skipped {sid}: generation.status={status}")
    return kept


def build_image(src, dst, manifest_only):
    """Write the derivative; return (width, height, bytes, sha256-of-source)."""
    from PIL import Image

    if manifest_only and os.path.exists(dst):
        with Image.open(dst) as im:
            w, h = im.size
        return w, h, os.path.getsize(dst), None

    with Image.open(src) as im:
        im.load()
        sw, sh = im.size
        tw = min(MAX_WIDTH, sw)
        th = round(sh * tw / sw)
        out = im.convert("RGB")
        if tw != sw:
            out = out.resize((tw, th), Image.LANCZOS)
        out.save(dst, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)

    digest = hashlib.sha256()
    with open(src, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return tw, th, os.path.getsize(dst), digest.hexdigest()[:16]


def build_set(spec, manifest_only=False):
    print(f"\n{spec['set_id']}")
    sides = load_sidecars(spec)

    out_dir = os.path.join(SETS_DIR, spec["set_id"])
    img_dir = os.path.join(out_dir, "images")
    os.makedirs(img_dir, exist_ok=True)

    # carry existing hashes over on a manifest-only rebuild
    old_hash = {}
    old_path = os.path.join(out_dir, "manifest.json")
    if os.path.exists(old_path):
        with open(old_path) as fh:
            for entry in json.load(fh).get("images", []):
                old_hash[entry["id"]] = entry.get("source_sha256")

    images, total_bytes = [], 0
    for i, side in enumerate(sides, 1):
        img_id = side["id"]
        src = os.path.join(spec["source_path"], side["image_file"])
        if not os.path.exists(src):
            sys.exit(f"ERROR: sidecar {img_id} points at missing image {src}")

        dst_name = f"{img_id}.jpg"
        w, h, nbytes, sha = build_image(src, os.path.join(img_dir, dst_name),
                                        manifest_only)
        total_bytes += nbytes

        entry = {
            "id": img_id,
            "file": dst_name,
            "width": w,
            "height": h,
            "bytes": nbytes,
            "label": spec["label_of"](side),
            "source_sha256": sha or old_hash.get(img_id),
            # When the file now on disk was generated (sidecar generation.timestamp,
            # ISO 8601 UTC). The rater counts a rating only if it postdates this,
            # so a regenerated image goes back into every rater's queue without
            # anyone editing the response Sheet.
            "generated_at": (side.get("generation") or {}).get("timestamp"),
        }
        entry.update(spec["meta_of"](side))
        images.append(entry)

        if i % 25 == 0 or i == len(sides):
            print(f"  {i}/{len(sides)} images")

    manifest = {
        "set_id": spec["set_id"],
        "title": spec["title"],
        "subtitle": spec["subtitle"],
        "version": spec["version"],
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "builder": "tools/build_sets.py",
        "source_path": spec["source_path"],
        "derivative": {"max_width": MAX_WIDTH, "format": "jpeg",
                       "quality": JPEG_QUALITY},
        "instructions": spec["instructions"],
        "schema_version": 1,
        "schema": spec["schema"],
        "count": len(images),
        "images": images,
    }
    with open(os.path.join(out_dir, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")

    print(f"  ✓ {len(images)} images, {total_bytes / 1024 / 1024:.1f} MB, "
          f"manifest written")
    return {"set_id": spec["set_id"], "title": spec["title"],
            "subtitle": spec["subtitle"], "count": len(images),
            "manifest": f"sets/{spec['set_id']}/manifest.json"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sets", nargs="*", help="set ids to build (default: all)")
    ap.add_argument("--manifest-only", action="store_true",
                    help="re-emit manifests without re-encoding images")
    args = ap.parse_args()

    wanted = args.sets or [s["set_id"] for s in SETS]
    unknown = set(wanted) - {s["set_id"] for s in SETS}
    if unknown:
        sys.exit(f"ERROR: unknown set(s): {', '.join(sorted(unknown))}")

    os.makedirs(SETS_DIR, exist_ok=True)
    index_path = os.path.join(SETS_DIR, "index.json")

    # keep entries for sets not rebuilt this run
    index = {}
    if os.path.exists(index_path):
        with open(index_path) as fh:
            for entry in json.load(fh).get("sets", []):
                index[entry["set_id"]] = entry

    for spec in SETS:
        if spec["set_id"] in wanted:
            index[spec["set_id"]] = build_set(spec, args.manifest_only)

    ordered = [index[s["set_id"]] for s in SETS if s["set_id"] in index]
    with open(index_path, "w") as fh:
        json.dump({"generated": datetime.now(timezone.utc)
                                .isoformat(timespec="seconds"),
                   "sets": ordered}, fh, indent=2)
        fh.write("\n")

    total = sum(e["count"] for e in ordered)
    print(f"\n✓ sets/index.json: {len(ordered)} sets, {total} images total")


if __name__ == "__main__":
    main()
