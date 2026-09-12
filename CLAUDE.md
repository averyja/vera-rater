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
tools/ingest_ratings.py   ratings -> qc/ratings_<date>.csv and the sidecar qc blocks
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
- Rater identity: any rater types their own short code (`requireKnownRater:
  false`). A blank code is still refused and codes are trimmed and lowercased,
  but a typo makes a new rater with its own progress. Accepted as a trade for
  a small pilot rather than a large release; `config.js` `raters` is now just
  a record of who a code belongs to, which nothing reads.
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
| `vpt_v5_revisions` | 33 edited candidates | `VPT_v1/stimulus_set_v5/qc/edits_review_20260909/FINAL_FOR_RATINGS_20260912/finals` |

**The MULTICAT images changed after the 2026-09-08 rating pass.** All 30 vapes
were regenerated with `openai/gpt-image-2.5-sunburst`, and `food_14`,
`object_04`, `object_11` and `object_practice_04` were regenerated after prompt
edits, in response to the raters' own comments (the "resting on air" ones, and
a rule that no vape stands diagonally). The derivatives here have been rebuilt
and match what is on OneDrive.

Then on 2026-09-09 afternoon a further 22 were regenerated with sunburst: the
5 a rater called unusable and the 17 borderlines, 12 of them with prompt
edits taken from the rater comments. 56 of the 150 rated images have been
replaced since the pass.

**scene_23 is a library aisle between stacks**, not the grocery aisle it was
(Jason, 2026-09-12). Two faults: `ad` rated it borderline and the image read as
a library anyway, and the item contradicted its own category constraint, which
forbids food or drink while the prompt asked for cartons, cans and bagged
goods. A grocery aisle is also food-heavy in a set where food is its own
category. It keeps the long-aisle composition and stays distinct from
`scene_12`, which is a reading room of tables and seating. Worth remembering
that the scene constraints forbid food, drink, people, screens showing a
picture, and any legible lettering.

**object_11 is a ballpoint pen on a pale grey office desk** (Jason,
2026-09-11). The original game controller failed three times, twice on
"resting on air", through contact-shadow wording, pose wording and a
stripped-back prompt. A brief stint as a second television remote was dropped
because it duplicated object_14 too closely, both being dark objects on dark
wood. All 30 object items are again distinct.

**object_practice_04 is an LED light bulb on the kitchen counter** (Jason,
2026-09-11), replacing the can opener, which failed twice on warped geometry
and "resting on air". It rests on its side: a bulb cannot balance upright on its
screw base, which the first two attempts had it doing. The first version described a frosted
envelope, a ribbed heat sink and visible filament strips together, which no
real bulb combines; Jason had the filament strips dropped and the description
cut back to shape, finish, size and base. Keep it plain.

Both had their qc blocks cleared, since those described images that no longer
exist.

**vape_18 is a second image of the Elf Bar BC5000**, not a 24th distinct
device. The North FT12000 failed six generations and the rater said to skip it,
so on 2026-09-10 the slot became a second Elf Bar scene (car console, against
vape_12's picnic table) and `seeds/reference_images.csv` points both ids at the
same device photo. Its `qc` block was cleared, since the old one described an
image that no longer exists.

**Regenerated images go back into the queue on their own.** Each manifest
image carries `generated_at`, the sidecar's `generation.timestamp`. The app
(`ratingIsCurrent` in `app.js`) counts a rating only if its `rated_at`
postdates that, so on resume a rater sees the images regenerated after they
rated them as unrated, with a note saying how many; the old rows stay in the
Sheet as history. `tools/ingest_ratings.py` applies the same rule and reports
how many rows it set aside. Nothing in the Sheet is edited. The 94 untouched
images and their 188 rows stand; the 112 rows on the 56 replaced images are
ignored by both until re-rated. The set is mixed-renderer in every category:
52 sunburst, 98 gpt-image-2, recorded per sidecar in `generation.model`.

### Rules for regenerating (Jason, 2026-09-10)

- **Never regenerate an image whose `qc.decision` is `accept`, and never edit
  its prompt.** Generation is a paid API call out of Jason's own budget, and a
  new `generated_at` also forces both raters to re-rate the image. Regenerate
  only what a rater marked `regenerate`, or what Jason names.
- If an accepted item's prompt and image have drifted apart, **roll the prompt
  back**, never regenerate the image. `generation.prompt_sent` records the text
  that made the image on disk; compare against it after stripping
  `REFERENCE_PREFIX`, which is prepended for any item with a device reference.
- Prompts **need not be one rigid formula** varying only by slot. Isolated
  post-hoc edits to fix realism or a visual fault are valid and expected;
  `edit_prompt.py` keeps them auditable. Do not propose regenerating a category
  to make prompts uniform.
- **A prompt technique proven on one or two items is not rolled out to the rest
  without asking.** Report the result and let Jason decide; a sweep means
  regenerating images to match.
- `edit_prompt.py --check` lists images older than their prompt. A stale
  *accepted* item is a prompt to revert; a stale `review`/`regenerate` item is
  legitimately awaiting regeneration.

Done on 2026-09-10: 25 accepted vape prompts were reverted to match their
images (`edits/revert_accepted_20260910.json`); no image was regenerated, and
all 27 accepted vape prompts now equal their `generation.prompt_sent`.
`vape_07` stays edited because it is on `review`.

Rebuild after regenerating a stimulus set:

```bash
python3 tools/build_sets.py                 # both sets
python3 tools/build_sets.py vpt_v5_vape     # one set
```

## Schemas

Each manifest carries its own schema, so an item change is a builder change,
not a front-end change.

- **multicat_v5** — Overall (U/B/X) + comment. A clean image is one keypress.
- **vpt_v5_vape** and **vpt_v5_revisions** — Overall, Pleasantness, Artifacts,
  Cue identifiable, Cue prominence (each 1–5), a flags row
  (V/D/L/T/M/**G/W/E**), comment. Both sets share `VPT_SCHEMA` in
  `build_sets.py` so a rating of a revision stays comparable with the rating of
  its original.

Keys: digits fill the highlighted row and move down; U/B/X and flag letters
work from any row; C comments, Escape leaves; Enter saves and advances; N next
unrated; ← → move; Z zoom; ? key list.

**Touch.** A phone has no Enter key, so every keyboard action also exists as a
button in `#actionbar` — Save & next, and back/forward arrows — wired to the
same functions the keys call so the two routes cannot drift. Below 760 px that
bar is fixed to the bottom of the screen, the item rows stack one control per
line, targets grow to 44 px on a coarse pointer, and the image panel is sticky
so it stays in view while the rows are scrolled and tapped. Zoom is the `zoom`
link in the image header or a tap on the image itself.

## The revision set and three new flags (Jason, 2026-09-12)

**`vpt_v5_revisions` is 33 edited candidates**, rated as a set of their own
rather than swapped into `vpt_v5_vape`. The production images on OneDrive are
untouched, the 120 ratings already collected on the 60 stay intact and
comparable, and nothing is promoted on the strength of a rating alone. The
candidates were aggregated out of six edit folders by
`stimulus_pipeline_v5/aggregate_edit_candidates.py`, which also writes the
sidecars this repo reads; `FINAL_FOR_RATINGS_20260912/README.md` beside them
carries the review notes, including the five that are recompositions rather
than edits and so have CONTROL twins that no longer match.

**Three flags were added to the VPT schema** for the faults the 2026-09-09 pass
kept describing in free text, so the next pass can count them:

| Key | Value | Label |
|---|---|---|
| G | `device_lighting` | Device lighting |
| W | `vapour_wrong` | Vapour looks wrong |
| E | `scene_error` | Scene or anatomy error |

Appended after the original five, which keep their positions and keys. G/W/E
are clear of every key `app.js` reserves (U B X, C, N, Z, ?, digits).

**No Google Form change was needed.** Flags are semicolon-joined into the single
`flags` field, verified in the browser: pressing G W E writes
`device_lighting;vapour_wrong;scene_error` into that one entry. Adding a
*separate* question would have needed a new Form field and a new entry id in
`config.js`; adding options to the flags row does not.

**Two distinctions the instructions now spell out**, because each new flag sits
next to an older one that means something else. `Vapour looks wrong` is vapour
that is present but unconvincing, against `Vapour missing`. `Scene or anatomy
error` is bodies, hands or objects being wrong, against `Scene mismatch`, which
is a scene that does not fit the brief.

**The schema change did not requeue anything.** `generated_at` and
`source_sha256` are identical for all 60 images in `vpt_v5_vape` before and
after, so no existing rating was invalidated. The `?v=` bump was deliberately
skipped: `app.js`, `styles.css` and `config.js` are unchanged, and manifests and
`sets/index.json` are already fetched with `?_=Date.now()`, so raters pick up
the new set and the new flags without a new script.

The candidate sidecars carry a `qc` block seeded with the five keys
`ingest_ratings.py` writes. Without it that script finds "no qc block at all"
and records nothing, silently.

## Backend status

Live and verified end to end on 2026-09-08: an anonymous POST is accepted
("Your response has been recorded"), rows reach the sheet with commas, escaped
quotes, semicolon-joined flags and MULTICAT's empty fields all intact, and the
site's own `progress()` reads them back in ~0.4 s with no rows skipped.

Two things to know when writing anything that reads the published CSV:

- **The published-CSV URL 307-redirects.** Follow redirects or you get an empty
  body and a silent false negative — `curl -L`, not bare `curl`. Browser
  `fetch` follows redirects on its own, so only scripts hit this.
- **The sheet caches for five minutes** (`cache-control: max-age=300`), so a
  row can take that long to become readable. That is the lag behind "Sent, not
  yet confirmed"; it is not a lost rating. A row that has not appeared after
  ten minutes is still most likely lag: on 2026-09-09 a save took about
  fifteen minutes to surface and arrived intact.
- **The published CSV serves more than one snapshot, and they disagree.**
  Cache-busted reads seconds apart have returned 453, 476 and 477 rows. A
  single read therefore undercounts silently, which for a QC pass means an
  image quietly looks unrated. `ingest_ratings.py` reads three times and takes
  the union (`--fetches N`), and prints the spread. Anything else written
  against this Sheet should do the same. The app's `progress()` does one read,
  so "Verify saves" can under-report; pressing it again is the fix.
- **Run the ingest when rating has stopped**, or the union is a moving target.

The sheet holds three fully blank rows (every field empty). They are harmless:
`ingest_ratings.py` counts them under "missing rater, set_id or image_id" and
prints them rather than dropping them silently.

## Feeding ratings back

`tools/ingest_ratings.py` reads the response Sheet (URL taken from
`config.js`, so there is one source of truth), writes `qc/ratings_<date>.csv`
beside each set, and fills the sidecar `qc` blocks.

```bash
python3 tools/ingest_ratings.py                # report only, writes nothing
python3 tools/ingest_ratings.py --write        # apply
python3 tools/ingest_ratings.py --csv rows.csv --set vpt_v5_vape
```

It fills `decision`, `raters`, `notes`, plus `cue_visible` and
`artifact_severity` where the set rates them. It leaves alone every qc key the
raters do not judge — MULTICAT's `no_people`, `no_text` and the rest, and VPT's
`control_clean` and `identity_match`, which needed the controls we dropped.

**It only writes qc keys that already exist in a sidecar.** A key that is not
there is reported and skipped, never created, because these files belong to
the stimulus pipelines and an invented key is a silent schema change.

QC policy lives in named constants at the top of the script:

- `DECISION_RULE = "worst"` — one rater can veto. Any Unusable makes the image
  `regenerate`; any Borderline makes it `review`; otherwise `accept`. The
  alternative is `"majority"`. Disagreements are listed in the run output and
  flagged in the CSV.
- `CUE_VISIBLE_TRUE_AT` / `CUE_VISIBLE_FALSE_AT` (3.5 / 2.5) — mean
  `cue_identifiable` above or below these sets `qc.cue_visible` true or false.
  In between it stays `None` on purpose, so a person looks rather than a
  threshold deciding a coin flip.
- `artifact_severity` is the mean across raters, rounded to one decimal.

Re-ratings are handled: the latest `rated_at` per (rater, set, image) wins.
Every row that does not become a rating is counted and printed with a reason.
Before writing it backs each sidecar up to `qc/sidecar_backup_<stamp>/`, and
because these files are on OneDrive it reads each one back after writing and
stops the run if the change did not persist.

## What is still open
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
  every deploy, or raters keep running the previous script from cache. That
  only busts the assets: `index.html` itself is cached by the browser for
  about ten minutes, so a rater mid-session can stay on the previous version
  that long. Tell raters to reload if a deploy has to reach them sooner.
- GitHub Pages reports the *previous* build as `built` for a while after a
  push. When checking a deploy, compare the build's commit to `HEAD`, not just
  its status.
