---
name: release
description: Cut a new release of the mobile app - bump the version on main, tag it, create the GitHub release and start the signed iOS (TestFlight) + Android (Play Internal) build. Use when the user says "release", "do a release", "release it", "ship it", "bump the version", "cut / tag a build", "push a new build to the stores" or similar.
---

# Release the mobile app

A release is: a `chore(release): bump version to X.Y.Z` commit on `main`
(`package.json` + `src-tauri/tauri.conf.json`), then a `vX.Y.Z` GitHub
release. Creating the release creates the tag, and the tag push runs
`.github/workflows/build-mobile.yml`, which builds and uploads the signed
iOS build to TestFlight and the Android build to Play Internal.

The user asking for a release **is** the permission to push the bump to
`main` and create the release. Don't ask again. Stop and ask only in the
cases listed under "Stop and ask".

Never stash, switch branches, commit or reset in the user's checkout:
it often holds uncommitted work on a feature branch. The bump commit is
built straight on top of `origin/main` with git plumbing, so the working
tree and the current branch are never touched.

Run everything from the repo root, in one shell (the steps share
variables).

## 1. See what ships

```bash
git fetch origin --tags
LAST=$(git describe --tags --abbrev=0 origin/main)
CUR=$(git show origin/main:package.json | sed -n 's/^  "version": "\(.*\)",$/\1/p')
git show origin/main:src-tauri/tauri.conf.json | grep -n '"version"'
git log --oneline "$LAST"..origin/main
```

- `CUR` must equal `LAST` without the `v`, and `tauri.conf.json` must
  carry the same version.
- The log is what this release ships. Keep it for the report.

## 2. Pick the version

Patch bump (`0.11.8` → `0.11.9`) unless the user asked for `minor`,
`major` or an exact version.

```bash
NEW=0.11.9   # computed from CUR
git ls-remote --exit-code --tags origin "refs/tags/v$NEW" && echo "TAG EXISTS"
```

## 3. Build the bump commit on origin/main

```bash
IDX=$(mktemp -u)
GIT_INDEX_FILE=$IDX git read-tree origin/main
for f in package.json src-tauri/tauri.conf.json; do
  blob=$(git show "origin/main:$f" \
    | sed "s/^  \"version\": \"$CUR\",\$/  \"version\": \"$NEW\",/" \
    | git hash-object -w --stdin)
  GIT_INDEX_FILE=$IDX git update-index --cacheinfo "100644,$blob,$f"
done
TREE=$(GIT_INDEX_FILE=$IDX git write-tree)
rm -f "$IDX"
COMMIT=$(printf 'chore(release): bump version to %s\n\nAssisted-by: Claude:<your model id>\n' "$NEW" \
  | git commit-tree "$TREE" -p origin/main)
git diff --stat origin/main "$COMMIT"
git diff origin/main "$COMMIT"
```

Replace `<your model id>` with your own model id (the repo's trailer
convention, see `docs/CONTRIBUTING.md`). The diff must be exactly the
two `"version"` lines, `CUR` → `NEW`. Anything else: stop.

## 4. Push, release, start the build

```bash
git push origin "$COMMIT":refs/heads/main
gh release create "v$NEW" --target "$COMMIT" --title "v$NEW" --generate-notes
git fetch origin main:main 2>/dev/null || true   # fast-forward local main when it isn't checked out
```

`--target "$COMMIT"` (not `main`) pins the tag to the bump commit even if
someone merges in between. If the push is rejected because `main` moved,
go back to step 1 and rebuild the commit on the new `origin/main`.

## 5. Check the build started

```bash
gh run list --workflow build-mobile.yml --branch "v$NEW" -L 1 \
  --json databaseId,status,headSha,url
```

The run can take a few seconds to show up; retry a few times. Check
`headSha` is `$COMMIT`. Don't wait for the build to finish (it takes a
long time) unless the user asks; `gh run view <id>` shows its state later.

## Report

- The version and the release URL.
- What ships: the PRs from the generated release notes (`gh release view v$NEW`).
- The build run URL.

## Stop and ask

- Nothing new since `LAST` (empty log, or only release bump commits).
- `package.json`, `tauri.conf.json` and the last tag disagree on the version.
- The tag `v$NEW` already exists.
- The bump diff contains anything besides the two version lines.
- A push or `gh` command is refused or fails for a reason other than
  `main` having moved.
