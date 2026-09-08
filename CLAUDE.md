# vera-rater — working notes and handoff (2026-09-08)

Stimulus-QC rating site for the VERA study (PI Jason Avery). A static page on
GitHub Pages at <https://averyja.github.io/vera-rater/>, serving `main` root.
The redesign described in `docs/REDESIGN_2026-09-06.md` is **built**; what
follows is the state of the built system.

## Layout

```
index.html          shell: set picker, rating screen, done, error
app.js              schema-driven rating engine (keyboard, resume, progress)
backend.js          storage adapter — 'local' and 'googleForm'
config.js           the only file to edit to change backend or raters
styles.css          palette and layout
sets/index.json     the active sets
sets/<id>/manifest.json   schema + image list for one set
sets/<id>/images/*.jpg    1400 px derivatives
tools/build_sets.py       rebuilds derivatives and manifests from the sidecars
tools/form_fields.py      reads a Google Form's entry ids into config.js shape
assets/             logo and icons, derived from the logo PNG
docs/               LOCAL ONLY, gitignored — redesign report, mockup,
                    Google backend setup. Kept off GitHub because the repo is
                    public; these are working documents, not published ones.
```

## Decisions made (Jason, 2026-09-08)

- **Backend: Google Form → linked Sheet**, chosen over REDCap+Cloudflare for
  now because it needs no external project. Setup is `docs/BACKEND_GOOGLE.md`.
  REDCap remains the intended destination; `backend.js` is an adapter, so the
  swap is one new adapter plus `config.js`, with no change to the rating page.
- **Repo stays public**, with `robots.txt` and a `noindex` meta so the stimuli
  are not indexed. They remain fetchable by anyone with a URL.
- **CONTROL images excluded** — 60 VAPE only. This drops the report's paired
  VAPE-vs-CONTROL pleasantness batch check.
- Rater identity: issued short codes, listed in `config.js` under `raters`.
  An unlisted code is refused.
- Overall wording: Usable / Borderline / Unusable. Accent: slate blue on light.
- Legacy `images/` and `manifest.json` removed from the tree; history keeps
  them, and commit `928ad75` is tagged **`legacy-2026-04`**.

## Deviations from the report

- Small icons (16/32/48) use the **brain silhouette**, not the VERA plate. The
  plate is 440×212, so in a square it becomes an illegible bar at 16 px; the
  brain reads at every size. 180 px and up use the full mark on paper ground.
- Derivatives are **1400 px** wide, not 1600. Measured: 1400/q85 is ~165 KB per
  image and 42 MB for all 210, against ~56 MB at 1600 with no visible gain on
  the judgements the schemas ask for.

## The sets

Both source sets live on OneDrive, not in this repo, and are unchanged by the
rater. `tools/build_sets.py` reads their **sidecars** (never `index.csv`, which
is stale for VPT) and writes the derivatives and manifests.

| Set | Rated | Source |
|---|---|---|
| `multicat_v5` | 150 (30 × face, food, object, scene, vape) | `multicat_localizer/multicat_v5_pipeline/set/images` |
| `vpt_v5_vape` | 60 VAPE (30 SOLO, 30 SOCIAL) | `VPT_v1/stimulus_set_v5/images`, filtered `condition=VAPE` |

`vape_01`, `vape_02` and `vape_03` in MULTICAT carry
`generation.status = success_repaired`. They are complete images and **are**
rated; the builder accepts any `success*` status and records the variant in the
manifest as `generation_status`.

Rebuild after regenerating a stimulus set:

```bash
python3 tools/build_sets.py                 # both sets
python3 tools/build_sets.py vpt_v5_vape     # one set
```

## Schemas

Each manifest carries its own schema, so an item change is a builder change,
not a front-end change.

- **multicat_v5** — Overall (U/B/X) + comment. A clean image is one keypress.
- **vpt_v5_vape** — Overall, Pleasantness, Artifacts, Cue identifiable, Cue
  prominence (each 1–5), a flags row (V/D/L/T/M), comment.

Keys: digits fill the highlighted row and move down; U/B/X and flag letters
work from any row; C comments, Escape leaves; Enter saves and advances; N next
unrated; ← → move; Z zoom; ? key list.

## What is still open

- The Google Form does not exist yet. Until `config.js` names one, the site
  runs `backend: 'local'` — ratings stay in the browser and reach no server.
- `ingest_ratings.py` (pull ratings back into the sidecars' `qc` blocks and
  `qc/ratings_<date>.csv`) is not written. Report phase 7, about 3 hours.
- The April Sheet has not been exported to
  `stimulus_set_v5/qc/legacy_ratings_2026-04.csv`, and the Apps Script
  deployment has not been retired in the Apps Script console. Delete any
  installable trigger there whatever else happens.
- Pilot with two raters (report phase 6) has not run.

## Constraints

- Nothing in this repo may hold a secret. The repo is public; a REDCap token
  would need the Cloudflare Worker the report describes.
- Do not re-create a watcher, installable trigger, or anything that runs as
  Jason's Google identity.
- Bump the `?v=` query on the `<script>` and `<link>` tags in `index.html` on
  every deploy, or raters keep running the previous script from cache.
