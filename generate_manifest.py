"""
generate_manifest.py
────────────────────
Run this script once from inside your vera-rater folder to build
the manifest.json file that tells the rater which images exist.

Usage:
    python generate_manifest.py

It will scan the `images/` subfolder and write `manifest.json`.
"""

import os
import json

IMAGES_DIR = "images"
OUTPUT_FILE = "manifest.json"
EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}

def main():
    if not os.path.isdir(IMAGES_DIR):
        print(f"ERROR: '{IMAGES_DIR}' folder not found. "
              f"Run this script from inside the vera-rater folder.")
        return

    files = sorted(
        f for f in os.listdir(IMAGES_DIR)
        if os.path.splitext(f)[1].lower() in EXTENSIONS
    )

    if not files:
        print(f"No image files found in '{IMAGES_DIR}/'.")
        return

    with open(OUTPUT_FILE, "w") as fh:
        json.dump(files, fh, indent=2)

    print(f"✓ Written {len(files)} filenames to {OUTPUT_FILE}")
    print(f"  First: {files[0]}")
    print(f"  Last:  {files[-1]}")

if __name__ == "__main__":
    main()
