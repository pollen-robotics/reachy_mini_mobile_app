# Contributing

PR and issue conventions for this repo. They mirror the daemon's
([reachy_mini `docs/contributing.md`](https://github.com/pollen-robotics/reachy_mini/blob/main/docs/contributing.md)),
adapted to the mobile app's toolchain. AI agents opening PRs here must
follow this document too.

## Code quality

Run the checks before pushing:

```bash
yarn typecheck        # tsc --noEmit
yarn lint             # eslint src
yarn test             # vitest run
cargo check           # from src-tauri/, for Rust-side changes
```

CI regenerates the native projects (`gen/apple`, `gen/android`) from
scratch on every build: fixes made inside `gen/` are wiped. Native build
fixes must be re-applied as post-init patch steps in
`.github/workflows/build-mobile.yml` (see `AGENTS.md` for the full
rationale and the list of existing patch steps).

## Issues and Pull Requests

Write concisely and get to the point. Issues, PR descriptions and review
comments are read by humans, so no walls of text, no feature tours, no
restating the diff in prose. If a sentence doesn't help the reader, cut it.

Search the open issues and pull requests first. Someone may already have
reported the bug, asked for the feature, or started the work. Comment
there rather than opening a duplicate.

If nothing matches, open an issue before writing the code. Describing the
problem there first gets you feedback on whether the change makes sense
and how to approach it. That is much cheaper than finding out on a
finished PR.

One PR = one issue. A problem spanning several concerns gets split into
unitary issues, one PR each. Mention the issue in the description
(`Closes #123`) so the two are linked.

The description must stand on its own: what's the problem, how to
reproduce it, what's the solution, and how you know it works. A reviewer
should not have to open the linked issue to follow the change. Drop the
reproduction when there's nothing to reproduce, as is usually the case
for a new feature.

Testing on physical devices is highly encouraged whenever it makes
sense: a physical phone over a simulator, and a physical Reachy Mini
over a simulated daemon. Paste the evidence (logs, screenshots,
recordings) and how to reproduce it as an annex below the main message.

Title the PR like a commit: `type(scope): what it does`, e.g.
`fix(auth): recover Android OAuth when Chrome blocks the scheme launch`.

Label every issue and every PR with the kind of change (`bug`,
`enhancement`, `feature`, `documentation`).

Each commit is one logical change, with a message saying what it does and
why. Commits are read individually, so each must stand on its own; squash
fixups and work-in-progress before asking for review. On a branch nobody
has reviewed yet, rewrite history freely and `git push --force-with-lease`.
Once review has started, stop rewriting, or reviewers lose their place.

## AI coding assistants

AI-assisted contributions are welcome, but the human author owns the
result: read the code, understand it, and answer review comments in your
own words.

We follow the Linux kernel convention from
[coding-assistants.rst](https://github.com/torvalds/linux/blob/master/Documentation/process/coding-assistants.rst).
Add one trailer per assisted commit:

```
Assisted-by: Claude:claude-opus-4-7
```

Append specialized analysis tools if you used any; don't list generic
ones like git or eslint.

Say it outside the commits as well: in a PR, tick the matching box in the
template's AI assistance section. "No AI involvement" is a perfectly good
answer; this is not a judgement on the contribution, it just tells
reviewers how to read it.

An assistant must **never** add a `Signed-off-by` trailer, since only a
human can certify the DCO. Keep agent and model names out of the PR
title too.
