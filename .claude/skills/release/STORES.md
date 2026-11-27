# Stores: what is where, and how to move a build

Everything here runs from GitHub Actions with the CI's own keys. No one
signs in to App Store Connect or the Play Console. The scripts are
`scripts/stores/play.py` and `scripts/stores/appstore.py`; `--help` lists
their commands.

## The pipeline

```
vX.Y.Z tag ──► build-mobile.yml ──► TestFlight ──► internal group (every build, automatic)
                                └──► Play internal track, rolled out (automatic)

store-promote.yml ──► Play: internal ─► production (or alpha / beta), at a %
                  └──► App Store: submit for App Review ─► released after approval
```

- A **tag** upload is rolled out on Play internal straight away. A
  `build-mobile.yml` run dispatched from a branch uploads a Play **draft**
  instead; roll it out with `play.py complete-draft --track internal`.
- Android `versionCode` = major·1 000 000 + minor·1 000 + patch
  (0.12.2 → 12002). The iOS build number grows with every upload
  (0.12.2 is build 108); `store-status` lists them.
- Ids: Play package `com.pollenrobotics.reachymini`, iOS bundle
  `com.pollen-robotics.reachy-mini`.
- Play tracks: `internal`, `alpha` (closed testing), `beta` (open
  testing), `production`.

## The two workflows

Both are `workflow_dispatch` and run the scripts as they are **on the ref
you dispatch** (`--ref main` by default). A script change must be pushed
before a run can use it.

**`store-status.yml`**: read-only, safe any time. It shows every track,
TestFlight build, beta group and App Store version, and checks the keys
can still do every promotion (a red row names the refused call, so a
missing role).

```bash
gh workflow run store-status.yml --ref main
R=$(gh run list --workflow store-status.yml -L 1 --json databaseId -q '.[0].databaseId')
gh run watch "$R" >/dev/null; gh run view "$R" --log | cut -f3- | grep -E '^\S+ \|'
```

**`store-promote.yml`**: inputs `store` (`play` | `appstore`), `args`
(the script's command line) and `apply` (default `false`).

- Job **Dry run** always runs first: Play validates the change and
  discards it; App Store writes are printed, not sent.
- Job **Apply** runs only with `apply=true`, in the `store-release`
  environment. That environment has **no required reviewer yet**, so an
  apply run goes through at once. Treat `apply=true` as the real thing.
- Play runs share the `play-edits` concurrency group: Play allows one
  open edit per app, and a second edit deletes the first ("This Edit has
  been deleted"). `play.py` retries that 3 times.

`args` is split like a shell would (`shlex`). Wrap text in double quotes
and keep `"` and `'` out of it. For release notes, write them to a file
and pass `$(cat file)`:

```bash
gh workflow run store-promote.yml --ref main -f store=play -f apply=true \
  -f args="promote --from internal --to production --version-code 12002 --rollout 1 --notes \"$(cat play_notes.txt)\""
gh workflow run store-promote.yml --ref main -f store=appstore -f apply=true \
  -f args="submit --version 0.12.2 --build 108 --notes \"$(cat appstore_notes.txt)\""
```

Read what a run did (the Apply job's own lines):

```bash
gh run view "$R" --json jobs -q '.jobs[]|.name+": "+.conclusion'
gh run view "$R" --log | grep -P '^Apply\t' | cut -f3- | sed 's/^[0-9T:.Z-]* //' \
  | grep -vE '^(##|\[command\]|  [A-Z_]+:)'
```

Then confirm with `store-status`: a run's own log is the script's
claim, the status table is the store's.

## Play (`play.py`)

| Command | Does |
|---|---|
| `status` | every track and its releases |
| `promote --from T --to T [--version-code N] [--rollout F] [--notes TEXT]` | copies the newest live release of one track to another. `--rollout 1` (default) = everyone; below 1 = staged, the current production release keeps serving the rest. Refuses if that code is already live on the target |
| `rollout --track T --fraction F` | raise a staged rollout (1 completes it) |
| `halt` / `resume` `--track T` | stop / restart a staged rollout |
| `complete-draft --track T [--version-code N]` | roll out a draft upload |

- `--notes` sets "What's new" (en-US, 500 characters max). Without it
  Play shows the previous release's notes; the CI upload carries none.
- Production updates go through Google's review before users get them,
  then publish on their own.
- A release at 100 % cannot be halted, only replaced by a newer build. A
  staged rollout (e.g. 0.1 = 10 %) can be halted, then raised with
  `rollout`.
- Promoting the same code again to production while it is still rolling
  out gets a 403 ("complete the rollout first"); `promote` refuses it
  up front.

## App Store (`appstore.py`)

| Command | Does |
|---|---|
| `status` | TestFlight builds, beta groups, App Store versions |
| `testflight --group NAME [--version] [--build] [--notes]` | add a build to a TestFlight group (external groups go through Beta App Review) |
| `submit --version X.Y.Z --notes TEXT [--build N] [--phased] [--manual-release]` | renames the version being prepared (or creates one), attaches the build, sets What's New in every localization, optionally a 7-day phased release, then submits for App Review |
| `release --version` | release an approved version held with `--manual-release` |
| `phased --version --state ACTIVE\|PAUSED\|COMPLETE` | drive a phased release |
| `age-rating [--set QUESTION=VALUE ...]` | list the age-rating answers of the version being prepared; `--set` answers one |

- Without `--manual-release` the version goes out on its own once Apple
  approves it (`AFTER_APPROVAL`). Review usually takes 24 to 48 hours.
- If Apple refuses the review submission, the error now lists the real
  blockers (`associatedErrors`): an unanswered age-rating question, a
  missing screenshot, export compliance, etc. `submit` can be rerun as
  is once they are fixed: it reuses the version and the open review
  submission.
- Age rating: Apple added questions in 2026 (social media since
  September). An unanswered one blocks every submission. Answering is a
  declaration in Pollen's name, so **the user decides each answer**;
  `age-rating` shows the questions, then set what they chose. Answered so
  far: `socialMedia=false` (2026-11-27: no feed, posts or likes between
  users). Still unanswered and not yet required at that date:
  `datingAndRelationships`, `sharedLocation`, `socialMediaAgeRestricted`.
- Builds set `ITSAppUsesNonExemptEncryption = NO`, so export compliance
  is never asked.

## Release notes

Each store's notes cover what changed **since the version that store
serves in production**, which differs between stores (check
`store-status`). List the user-facing commits:

```bash
git log --no-merges --format='%s' vLIVE..vNEW | grep -E '^(feat|fix)'
```

- Users' words, no internals (CI, deps, refactors), no `"` or `'`.
- Play: 500 characters max, short bullets. App Store: a few grouped
  sections are fine.
- The user writes the notes or approves yours word for word.
- Not every published version has a tag (there is no `v0.11.5`): take
  the closest older tag and say the list may include a little more.

## What needs the user's explicit ask

Per version and per channel, in their own words:

- anything past internal testing: alpha / beta / production, an external
  TestFlight group, an App Review submission, a release;
- the rollout percentage (or phased / not phased) and the notes text;
- any age-rating or other compliance answer.

Dry runs and `store-status` need no ask. Run a dry run first and show its
plan unless the user already asked for the exact move.

## Known build breakages

- **AGP 9 / API 36** (Tauri 2.12): CI regenerates `gen/android` with
  AGP 9, which needs every Tauri plugin's Android library at
  `compileSdk = 36` and with no `targetSdk`. Local builds keep the old
  `gen/` (AGP 8) and don't show it. `tauri-plugin-blec`,
  `tauri-plugin-keep-screen-on` and `tauri-plugin-sharekit` are vendored
  under `src-tauri/vendor/` and patched in `[patch.crates-io]` for this.
  A new plugin with Android code needs the same check.
- If the GitHub MCP server fails to connect, `gh` does everything above.
