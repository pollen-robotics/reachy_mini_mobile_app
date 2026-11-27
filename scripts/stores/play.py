#!/usr/bin/env python3
"""Google Play tracks for the Android app, through the Play Developer API.

Every change goes through an "edit" (Play's transaction): with --dry-run the
edit is validated by Play and then deleted, so nothing changes on the store.

    play.py status
    play.py check-access
    play.py complete-draft --track internal [--version-code N]
    play.py promote --from internal --to production [--version-code N] [--rollout 0.1]
    play.py rollout --track production --fraction 0.5      (1 completes it)
    play.py halt    --track production
    play.py resume  --track production

Credentials: PLAY_SERVICE_ACCOUNT_JSON (the service account's JSON key).
Package: PLAY_PACKAGE, default com.pollenrobotics.reachymini.
In CI the arguments can come from STORE_ARGS (split like a shell would).
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import shlex
import sys
import time

from google.auth.transport.requests import AuthorizedSession
from google.oauth2 import service_account

API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications'
SCOPE = 'https://www.googleapis.com/auth/androidpublisher'
DEFAULT_PACKAGE = 'com.pollenrobotics.reachymini'


class PlayError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f'HTTP {status}: {body}')
        self.status = status
        self.body = body


class Play:
    def __init__(self, package: str):
        raw = os.environ.get('PLAY_SERVICE_ACCOUNT_JSON')
        if not raw:
            sys.exit('PLAY_SERVICE_ACCOUNT_JSON is not set')
        info = json.loads(raw)
        self.account = info.get('client_email', '?')
        creds = service_account.Credentials.from_service_account_info(info, scopes=[SCOPE])
        self.http = AuthorizedSession(creds)
        self.base = f'{API}/{package}'

    def call(self, method: str, path: str, body: dict | None = None, params: dict | None = None) -> dict:
        res = self.http.request(method, f'{self.base}{path}', json=body, params=params, timeout=60)
        if res.status_code >= 400:
            raise PlayError(res.status_code, res.text)
        return res.json() if res.text else {}


class Edit:
    """One Play edit. Commit it, or validate and delete it on a dry run."""

    def __init__(self, play: Play):
        self.play = play
        self.id = play.call('POST', '/edits', {})['id']

    def tracks(self) -> list[dict]:
        return self.play.call('GET', f'/edits/{self.id}/tracks').get('tracks', [])

    def track(self, name: str) -> dict:
        return self.play.call('GET', f'/edits/{self.id}/tracks/{name}')

    def set_releases(self, name: str, releases: list[dict]) -> None:
        self.play.call('PUT', f'/edits/{self.id}/tracks/{name}', {'track': name, 'releases': releases})

    def finish(self, dry_run: bool, send_for_review: bool = True) -> None:
        params = None if send_for_review else {'changesNotSentForReview': 'true'}
        if dry_run:
            try:
                self.play.call('POST', f'/edits/{self.id}:validate', params=params)
                print('Dry run: Play validated the change. Nothing was committed.')
            finally:
                self.discard()
            return
        self.play.call('POST', f'/edits/{self.id}:commit', params=params)
        print('Committed.')

    def discard(self) -> None:
        try:
            self.play.call('DELETE', f'/edits/{self.id}')
        except PlayError as err:
            print(f'(could not delete edit {self.id}: {err})')


# --- formatting ---------------------------------------------------------------

def describe(release: dict) -> str:
    codes = ','.join(release.get('versionCodes', [])) or '-'
    status = release.get('status', '?')
    if 'userFraction' in release:
        status += f" {release['userFraction'] * 100:g}%"
    return f"{release.get('name', '?')} (code {codes}) {status}"


def summary(text: str) -> None:
    print(text)
    path = os.environ.get('GITHUB_STEP_SUMMARY')
    if path:
        with open(path, 'a', encoding='utf-8') as fh:
            fh.write(text + '\n')


def show_plan(track: str, before: list[dict], after: list[dict]) -> None:
    print(f'Track {track}:')
    print('  before: ' + ('; '.join(describe(r) for r in before) or 'empty'))
    print('  after:  ' + ('; '.join(describe(r) for r in after) or 'empty'))


# --- release helpers ----------------------------------------------------------

def newest(releases: list[dict], statuses: tuple[str, ...], version_code: str | None) -> dict | None:
    picked = [
        r for r in releases
        if r.get('status') in statuses and (version_code is None or version_code in r.get('versionCodes', []))
    ]
    picked.sort(key=lambda r: max((int(c) for c in r.get('versionCodes', ['0'])), default=0), reverse=True)
    return picked[0] if picked else None


def as_status(release: dict, status: str, fraction: float | None = None) -> dict:
    out = copy.deepcopy(release)
    out['status'] = status
    out.pop('userFraction', None)
    if fraction is not None:
        out['userFraction'] = fraction
    return out


def check_fraction(value: float) -> float:
    if not 0 < value <= 1:
        sys.exit('rollout fraction must be in (0, 1]')
    return value


# --- commands -----------------------------------------------------------------

def cmd_status(play: Play, _args) -> None:
    edit = Edit(play)
    try:
        tracks = edit.tracks()
    finally:
        edit.discard()
    lines = ['### Google Play', '', '| Track | Releases |', '|---|---|']
    for t in sorted(tracks, key=lambda t: t['track']):
        releases = t.get('releases', [])
        lines.append(f"| {t['track']} | {'<br>'.join(describe(r) for r in releases) or 'empty'} |")
    summary('\n'.join(lines) + '\n')


def cmd_check_access(play: Play, _args) -> None:
    """Exercise each permission the release flow needs, without changing anything."""
    results: list[tuple[str, str]] = []

    def probe(label: str, fn) -> bool:
        try:
            fn()
            results.append((label, 'OK'))
            return True
        except PlayError as err:
            results.append((label, f'HTTP {err.status}: {err.body.strip()[:300]}'))
            return False

    edit_box: dict = {}
    if probe('open an edit (read tracks)', lambda: edit_box.setdefault('edit', Edit(play))):
        edit: Edit = edit_box['edit']
        try:
            tracks = {t['track']: t.get('releases', []) for t in edit.tracks()}
            source = newest(tracks.get('internal', []), ('completed', 'draft', 'inProgress'), None)
            if source is None:
                results.append(('write a testing / production track', 'skipped: internal track is empty'))
            else:
                # Same release, re-written to internal: a no-op write on a testing track.
                probe('write the internal track (no-op)', lambda: edit.set_releases('internal', tracks['internal']))
                # The internal release as a production draft, validated then discarded.
                probe(
                    'stage a production release (validated, discarded)',
                    lambda: edit.set_releases('production', tracks.get('production', []) + [as_status(source, 'draft')]),
                )
                probe('validate the edit', lambda: play.call('POST', f'/edits/{edit.id}:validate'))
        finally:
            edit.discard()

    lines = [f'### Google Play access ({play.account})', '', '| Check | Result |', '|---|---|']
    lines += [f'| {label} | {result} |' for label, result in results]
    summary('\n'.join(lines) + '\n')
    if any(r != 'OK' and not r.startswith('skipped') for _, r in results):
        sys.exit(1)


def cmd_complete_draft(play: Play, args) -> None:
    edit = Edit(play)
    try:
        releases = edit.track(args.track).get('releases', [])
        draft = newest(releases, ('draft',), args.version_code)
        if draft is None:
            sys.exit(f'No draft release on {args.track}' + (f' with code {args.version_code}' if args.version_code else ''))
        after = [as_status(draft, 'completed')]
        show_plan(args.track, releases, after)
        edit.set_releases(args.track, after)
        edit.finish(args.dry_run)
    except BaseException:
        edit.discard()
        raise


def cmd_promote(play: Play, args) -> None:
    fraction = check_fraction(args.rollout)
    if args.notes and len(args.notes) > 500:
        sys.exit(f'--notes is {len(args.notes)} characters, Play allows 500')
    edit = Edit(play)
    try:
        source_releases = edit.track(args.source).get('releases', [])
        source = newest(source_releases, ('completed', 'inProgress'), args.version_code)
        if source is None:
            sys.exit(f'Nothing live on {args.source}' + (f' with code {args.version_code}' if args.version_code else ''))
        before = edit.track(args.target).get('releases', [])
        codes = set(source.get('versionCodes', []))
        if any(codes & set(r.get('versionCodes', [])) for r in before if r.get('status') != 'draft'):
            sys.exit(f"{describe(source)} is already on {args.target}")
        promoted = as_status(source, 'completed') if fraction >= 1 else as_status(source, 'inProgress', fraction)
        if args.notes:
            promoted['releaseNotes'] = [{'language': args.notes_language, 'text': args.notes}]
        if fraction >= 1:
            after = [promoted]
        else:
            # A staged rollout: the current completed release keeps serving
            # everyone outside the rollout fraction.
            serving = newest(before, ('completed',), None)
            after = ([serving] if serving else []) + [promoted]
        show_plan(args.target, before, after)
        edit.set_releases(args.target, after)
        edit.finish(args.dry_run)
    except BaseException:
        edit.discard()
        raise


def cmd_rollout(play: Play, args) -> None:
    fraction = check_fraction(args.fraction)
    edit = Edit(play)
    try:
        before = edit.track(args.track).get('releases', [])
        staged = newest(before, ('inProgress', 'halted'), None)
        if staged is None:
            sys.exit(f'No staged rollout on {args.track}')
        if fraction >= 1:
            after = [as_status(staged, 'completed')]
        else:
            after = [r for r in before if r is not staged and r.get('status') == 'completed']
            after.append(as_status(staged, 'inProgress', fraction))
        show_plan(args.track, before, after)
        edit.set_releases(args.track, after)
        edit.finish(args.dry_run)
    except BaseException:
        edit.discard()
        raise


def cmd_halt_resume(play: Play, args, halt: bool) -> None:
    edit = Edit(play)
    try:
        before = edit.track(args.track).get('releases', [])
        staged = newest(before, ('inProgress',) if halt else ('halted',), None)
        if staged is None:
            sys.exit(f"No {'running' if halt else 'halted'} rollout on {args.track}")
        new = as_status(staged, 'halted' if halt else 'inProgress', staged.get('userFraction'))
        after = [new if r is staged else r for r in before]
        show_plan(args.track, before, after)
        edit.set_releases(args.track, after)
        edit.finish(args.dry_run)
    except BaseException:
        edit.discard()
        raise


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--package', default=os.environ.get('PLAY_PACKAGE', DEFAULT_PACKAGE))
    parser.add_argument('--dry-run', action='store_true', help='validate with Play, then discard')
    # Accepted after the command too: `promote ... --dry-run`.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--dry-run', action='store_true', default=argparse.SUPPRESS)
    sub = parser.add_subparsers(dest='cmd', required=True)
    sub.add_parser('status')
    sub.add_parser('check-access')
    p = sub.add_parser('complete-draft', parents=[common])
    p.add_argument('--track', default='internal')
    p.add_argument('--version-code')
    p = sub.add_parser('promote', parents=[common])
    p.add_argument('--from', dest='source', required=True)
    p.add_argument('--to', dest='target', required=True)
    p.add_argument('--version-code')
    p.add_argument('--rollout', type=float, default=1.0, help='fraction of users, 1 = everyone')
    p.add_argument('--notes', help="What's new, at most 500 characters")
    p.add_argument('--notes-language', default='en-US')
    p = sub.add_parser('rollout', parents=[common])
    p.add_argument('--track', default='production')
    p.add_argument('--fraction', type=float, required=True)
    for name in ('halt', 'resume'):
        sub.add_parser(name, parents=[common]).add_argument('--track', default='production')
    args = parser.parse_args(argv)

    play = Play(args.package)
    handlers = {
        'status': cmd_status,
        'check-access': cmd_check_access,
        'complete-draft': cmd_complete_draft,
        'promote': cmd_promote,
        'rollout': cmd_rollout,
        'halt': lambda p, a: cmd_halt_resume(p, a, halt=True),
        'resume': lambda p, a: cmd_halt_resume(p, a, halt=False),
    }
    # Play keeps one open edit per app: another client opening or deleting
    # one (the upload job, a status run) deletes ours. Nothing was committed
    # then, so the whole command can run again.
    for attempt in range(3):
        try:
            handlers[args.cmd](play, args)
            return
        except PlayError as err:
            if 'This Edit has been deleted' in err.body and attempt < 2:
                print('Another client replaced the edit; retrying in 15 s.')
                time.sleep(15)
                continue
            sys.exit(f'Play API error: {err}')


if __name__ == '__main__':
    main(sys.argv[1:] or shlex.split(os.environ.get('STORE_ARGS', '')))
