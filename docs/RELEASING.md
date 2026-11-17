# Releasing the mobile app

How to ship a new version to TestFlight and Play Internal testing. Written
for maintainers and for agents asked to "do the release".

## Steps

1. **Pick the version.** Bump the patch (`0.11.5` → `0.11.6`) unless the
   maintainer asks for a minor. Play rejects a version it has already seen,
   so a version is never reused, even after a failed run.
2. **Bump it in the two places:**
   - `package.json` → `"version"`
   - `src-tauri/tauri.conf.json` → `"version"`

   Leave `src-tauri/Cargo.toml` alone: its version is not the app's.
3. **Commit on `main`**, on top of the latest `origin/main`, with nothing
   else in the commit:

   ```
   chore(release): bump version to X.Y.Z
   ```

   (plus the `Assisted-by:` trailer when an agent made it). Release commits
   are pushed straight to `main`, not through a PR.
4. **Tag that commit `vX.Y.Z`** and push the tag:

   ```bash
   git tag vX.Y.Z
   git push origin HEAD:main
   git push origin vX.Y.Z
   ```

   The tag push is the trigger: it starts `.github/workflows/build-mobile.yml`.
   Don't also start the workflow by hand: that would upload a second build.

## What the tag push runs

| Job | Result |
|---|---|
| `iOS (simulator)` | unsigned simulator `.app` |
| `Android (debug)` | debug APK |
| `iOS (signed, TestFlight)` | signed IPA uploaded to TestFlight |
| `Android (signed, Play Internal)` | signed AAB uploaded to Play Internal testing, as a draft |
| `Attach to GitHub Release` | creates the `vX.Y.Z` GitHub release (notes generated from the previous tag) and attaches the run's build artifacts (debug APK, simulator app, and the signed IPA if it is done by then) |

The run takes about 20 minutes. The version shown in the app, on the stores
and on the splash screen comes from the tag.

## After the run (a human does these)

- **Play Console:** Internal testing → review the draft release → roll it
  out.
- **TestFlight:** the build shows up once Apple has processed it.
  Hand it to testers.
- Promoting to production on either store is a separate, manual decision.

## Without a tag

`build-mobile.yml` can also be started by hand (Actions → Build mobile →
Run workflow) on any branch. By default it builds the simulator app and the
debug APK only. The `android_release` and `ios_release` inputs add the signed
uploads. The version then comes from `tauri.conf.json`, so bump it first.
0.11.5 was shipped this way. Prefer the tag: it also creates the GitHub
release and keeps a record of what shipped.

## When it fails

- **"Version code N has already been used" (Play):** that version already
  reached Play. Bump the patch and tag again; never move an existing tag.
- **A re-pushed tag** cancels the run still going for it (the workflow's
  `concurrency` group). That is expected.
- Native build problems: see "CI / native build gotchas" in
  [`AGENTS.md`](../AGENTS.md).
