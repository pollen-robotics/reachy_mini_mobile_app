#!/usr/bin/env python3
"""TestFlight and App Store releases for the iOS app, through the App Store Connect API.

    appstore.py status
    appstore.py check-access
    appstore.py testflight --group NAME [--version X.Y.Z] [--build N] [--notes TEXT]
    appstore.py submit --version X.Y.Z --notes TEXT [--build N] [--phased] [--manual-release]
    appstore.py release --version X.Y.Z          (after approval, with a manual release)
    appstore.py phased --version X.Y.Z --state ACTIVE|PAUSED|COMPLETE

With --dry-run every read runs and every write is printed instead of sent.

Credentials: ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_BASE64 (base64 of the .p8).
App: ASC_APP_ID (numeric App Store Connect id).
In CI the arguments can come from STORE_ARGS (split like a shell would).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shlex
import sys
import time

import jwt
import requests

API = 'https://api.appstoreconnect.apple.com'
# Versions App Store Connect still lets us edit before a submission.
EDITABLE_STATES = {
    'PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED',
    'INVALID_BINARY', 'DEVELOPER_REMOVED_FROM_SALE',
}


class AscError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f'HTTP {status}: {body}')
        self.status = status
        self.body = body

    def short(self) -> str:
        try:
            errors = json.loads(self.body).get('errors', [])
            text = '; '.join(f"{e.get('code')}: {e.get('detail') or e.get('title')}" for e in errors)
        except ValueError:
            text = self.body
        return f'HTTP {self.status}: {text.strip()[:300]}'


class Asc:
    def __init__(self, dry_run: bool):
        missing = [v for v in ('ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_BASE64', 'ASC_APP_ID') if not os.environ.get(v)]
        if missing:
            sys.exit(f"Missing environment: {', '.join(missing)}")
        self.key_id = os.environ['ASC_KEY_ID']
        self.issuer = os.environ['ASC_ISSUER_ID']
        self.key = base64.b64decode(os.environ['ASC_KEY_BASE64']).decode()
        self.app_id = os.environ['ASC_APP_ID']
        self.dry_run = dry_run
        self.http = requests.Session()
        self._token = ''
        self._token_exp = 0.0

    def token(self) -> str:
        now = time.time()
        if now > self._token_exp - 60:
            self._token_exp = now + 15 * 60
            self._token = jwt.encode(
                {'iss': self.issuer, 'iat': int(now), 'exp': int(self._token_exp), 'aud': 'appstoreconnect-v1'},
                self.key, algorithm='ES256', headers={'kid': self.key_id, 'typ': 'JWT'},
            )
        return self._token

    def request(self, method: str, path: str, body: dict | None = None, params: dict | None = None) -> dict:
        res = self.http.request(
            method, f'{API}{path}', json=body, params=params, timeout=60,
            headers={'Authorization': f'Bearer {self.token()}'},
        )
        if res.status_code >= 400:
            raise AscError(res.status_code, res.text)
        return res.json() if res.text else {}

    def get(self, path: str, **params) -> dict:
        return self.request('GET', path, params=params or None)

    def write(self, method: str, path: str, body: dict, what: str) -> dict:
        """A change on the store. Printed instead of sent on a dry run."""
        if self.dry_run:
            print(f'[dry run] would {what}: {method} {path} {json.dumps(body)}')
            return {'data': {'id': 'dry-run', 'attributes': {}}}
        print(f'{what}: {method} {path}')
        return self.request(method, path, body)


def ref(kind: str, id_: str) -> dict:
    return {'data': {'type': kind, 'id': id_}}


def summary(text: str) -> None:
    print(text)
    path = os.environ.get('GITHUB_STEP_SUMMARY')
    if path:
        with open(path, 'a', encoding='utf-8') as fh:
            fh.write(text + '\n')


def included_map(payload: dict) -> dict[tuple[str, str], dict]:
    return {(i['type'], i['id']): i for i in payload.get('included', [])}


def rel_id(item: dict, name: str) -> str | None:
    data = item.get('relationships', {}).get(name, {}).get('data')
    return data['id'] if data else None


# --- lookups ------------------------------------------------------------------

def builds(asc: Asc, limit: int = 15, **filters) -> list[dict]:
    """Recent builds, newest first, each with `marketing` (X.Y.Z) and `beta` (states)."""
    params = {
        'filter[app]': asc.app_id, 'sort': '-uploadedDate', 'limit': limit,
        'include': 'preReleaseVersion,buildBetaDetail',
    }
    params.update(filters)
    payload = asc.get('/v1/builds', **params)
    inc = included_map(payload)
    out = []
    for b in payload.get('data', []):
        pre = inc.get(('preReleaseVersions', rel_id(b, 'preReleaseVersion') or ''), {})
        beta = inc.get(('buildBetaDetails', rel_id(b, 'buildBetaDetail') or ''), {})
        b['marketing'] = pre.get('attributes', {}).get('version', '?')
        b['beta'] = beta.get('attributes', {})
        out.append(b)
    return out


def pick_build(asc: Asc, version: str | None, number: str | None) -> dict:
    filters = {'filter[processingState]': 'VALID', 'filter[expired]': 'false'}
    if version:
        filters['filter[preReleaseVersion.version]'] = version
    if number:
        filters['filter[version]'] = number
    found = builds(asc, limit=5, **filters)
    if not found:
        sys.exit(f'No processed build for version={version or "any"} build={number or "latest"}')
    b = found[0]
    print(f"Build: {b['marketing']} ({b['attributes']['version']}), uploaded {b['attributes'].get('uploadedDate')}")
    return b


def beta_groups(asc: Asc) -> list[dict]:
    return asc.get(f'/v1/apps/{asc.app_id}/betaGroups', limit=50).get('data', [])


def store_versions(asc: Asc) -> tuple[list[dict], dict]:
    payload = asc.get(
        f'/v1/apps/{asc.app_id}/appStoreVersions', limit=10,
        include='build,appStoreVersionPhasedRelease', **{'filter[platform]': 'IOS'},
    )
    versions = sorted(payload.get('data', []), key=lambda v: v['attributes'].get('createdDate', ''), reverse=True)
    return versions, included_map(payload)


def version_state(v: dict) -> str:
    a = v['attributes']
    return a.get('appVersionState') or a.get('appStoreState') or '?'


def find_version(asc: Asc, version: str) -> dict:
    versions, _ = store_versions(asc)
    for v in versions:
        if v['attributes'].get('versionString') == version:
            return v
    sys.exit(f'No App Store version {version}')


# --- commands -----------------------------------------------------------------

def cmd_status(asc: Asc, _args) -> None:
    app = asc.get(f'/v1/apps/{asc.app_id}')['data']['attributes']
    lines = [f"### App Store Connect: {app.get('name')} ({app.get('bundleId')})", '']

    lines += ['**Recent builds**', '', '| Version | Build | Uploaded | Processing | Internal | External |', '|---|---|---|---|---|---|']
    for b in builds(asc, limit=8):
        a = b['attributes']
        lines.append(
            f"| {b['marketing']} | {a['version']} | {a.get('uploadedDate', '')[:16]} | {a.get('processingState')}"
            f"{' (expired)' if a.get('expired') else ''} | {b['beta'].get('internalBuildState', '-')} "
            f"| {b['beta'].get('externalBuildState', '-')} |"
        )

    lines += ['', '**TestFlight groups**', '', '| Group | Kind | Latest build |', '|---|---|---|']
    for g in beta_groups(asc):
        a = g['attributes']
        latest = builds(asc, limit=1, **{'filter[betaGroups]': g['id']})
        shown = f"{latest[0]['marketing']} ({latest[0]['attributes']['version']})" if latest else 'none'
        kind = 'internal' if a.get('isInternalGroup') else 'external'
        if a.get('hasAccessToAllBuilds'):
            kind += ', all builds'
        lines.append(f"| {a.get('name')} | {kind} | {shown} |")

    versions, inc = store_versions(asc)
    lines += ['', '**App Store versions**', '', '| Version | State | Build | Release | Phased |', '|---|---|---|---|---|']
    for v in versions[:5]:
        a = v['attributes']
        build = inc.get(('builds', rel_id(v, 'build') or ''), {}).get('attributes', {}).get('version', '-')
        phased = inc.get(('appStoreVersionPhasedReleases', rel_id(v, 'appStoreVersionPhasedRelease') or ''), {})
        pa = phased.get('attributes', {})
        phased_txt = f"{pa.get('phasedReleaseState')} day {pa.get('currentDayNumber')}" if pa else '-'
        lines.append(f"| {a.get('versionString')} | {version_state(v)} | {build} | {a.get('releaseType')} | {phased_txt} |")

    subs = asc.get('/v1/reviewSubmissions', limit=5, **{'filter[app]': asc.app_id}).get('data', [])
    lines += ['', '**Review submissions**', '', '| State | Submitted |', '|---|---|']
    for s in subs:
        lines.append(f"| {s['attributes'].get('state')} | {s['attributes'].get('submittedDate') or '-'} |")
    summary('\n'.join(lines) + '\n')


def cmd_check_access(asc: Asc, _args) -> None:
    """Exercise each permission the release flow needs. Writes are empty PATCHes: no change."""
    results: list[tuple[str, str]] = []

    def probe(label: str, fn, ok_statuses: tuple[int, ...] = ()) -> None:
        try:
            fn()
            results.append((label, 'OK'))
        except AscError as err:
            # An error other than 403 means the role got past the permission check.
            verdict = 'OK (allowed; ' if err.status in ok_statuses else ''
            results.append((label, f'{verdict}{err.short()}{")" if verdict else ""}'))

    probe('read the app', lambda: asc.get(f'/v1/apps/{asc.app_id}'))
    probe('read builds', lambda: builds(asc, limit=1))
    groups: list[dict] = []
    probe('read TestFlight groups', lambda: groups.extend(beta_groups(asc)))
    versions: list[dict] = []
    probe('read App Store versions', lambda: versions.extend(store_versions(asc)[0]))
    probe('read review submissions', lambda: asc.get('/v1/reviewSubmissions', limit=1, **{'filter[app]': asc.app_id}))

    def empty_patch(kind: str, id_: str) -> None:
        asc.request('PATCH', f'/v1/{kind}/{id_}', {'data': {'type': kind, 'id': id_, 'attributes': {}}})

    probe('edit the app (empty PATCH)', lambda: empty_patch('apps', asc.app_id), (409, 422))
    for g in groups[:1] + [g for g in groups if not g['attributes'].get('isInternalGroup')][:1]:
        kind = 'internal' if g['attributes'].get('isInternalGroup') else 'external'
        probe(f"edit {kind} TestFlight group '{g['attributes'].get('name')}' (empty PATCH)",
              lambda g=g: empty_patch('betaGroups', g['id']), (409, 422))
    if not any(not g['attributes'].get('isInternalGroup') for g in groups):
        results.append(('edit an external TestFlight group', 'skipped: no external group'))
    if versions:
        v = versions[0]
        probe(f"edit App Store version {v['attributes'].get('versionString')} ({version_state(v)}, empty PATCH)",
              lambda: empty_patch('appStoreVersions', v['id']), (409, 422))
    else:
        results.append(('edit an App Store version', 'skipped: none yet'))

    lines = [f'### App Store Connect access (key {asc.key_id})', '', '| Check | Result |', '|---|---|']
    lines += [f'| {label} | {result} |' for label, result in results]
    summary('\n'.join(lines) + '\n')
    if any(not r.startswith(('OK', 'skipped')) for _, r in results):
        sys.exit(1)


def cmd_testflight(asc: Asc, args) -> None:
    build = pick_build(asc, args.version, args.build)
    group = next((g for g in beta_groups(asc) if g['attributes'].get('name') == args.group), None)
    if group is None:
        sys.exit(f"No TestFlight group named '{args.group}'")
    external = not group['attributes'].get('isInternalGroup')

    if args.notes:
        locs = asc.get(f"/v1/builds/{build['id']}/betaBuildLocalizations").get('data', [])
        for loc in locs:
            asc.write('PATCH', f"/v1/betaBuildLocalizations/{loc['id']}", {'data': {
                'type': 'betaBuildLocalizations', 'id': loc['id'], 'attributes': {'whatsNew': args.notes}}},
                f"set What to Test ({loc['attributes'].get('locale')})")
        if not locs:
            asc.write('POST', '/v1/betaBuildLocalizations', {'data': {
                'type': 'betaBuildLocalizations', 'attributes': {'locale': 'en-US', 'whatsNew': args.notes},
                'relationships': {'build': ref('builds', build['id'])}}}, 'set What to Test (en-US)')

    asc.write('POST', f"/v1/betaGroups/{group['id']}/relationships/builds",
              {'data': [{'type': 'builds', 'id': build['id']}]}, f"add the build to '{args.group}'")

    if external:
        sub = asc.get(f"/v1/builds/{build['id']}/betaAppReviewSubmission").get('data')
        if sub:
            print(f"Beta review: already {sub['attributes'].get('betaReviewState')}")
        else:
            asc.write('POST', '/v1/betaAppReviewSubmissions', {'data': {
                'type': 'betaAppReviewSubmissions', 'relationships': {'build': ref('builds', build['id'])}}},
                'submit the build for beta review')


def cmd_submit(asc: Asc, args) -> None:
    build = pick_build(asc, args.version, args.build)
    versions, _ = store_versions(asc)
    target = next((v for v in versions if v['attributes'].get('versionString') == args.version), None)
    editable = next((v for v in versions if version_state(v) in EDITABLE_STATES), None)
    release_type = 'MANUAL' if args.manual_release else 'AFTER_APPROVAL'

    if target is not None and version_state(target) not in EDITABLE_STATES:
        sys.exit(f'Version {args.version} is {version_state(target)}: nothing to submit')
    if target is None and editable is not None:
        # App Store Connect keeps one editable version: rename it.
        target = editable
        asc.write('PATCH', f"/v1/appStoreVersions/{target['id']}", {'data': {
            'type': 'appStoreVersions', 'id': target['id'],
            'attributes': {'versionString': args.version, 'releaseType': release_type}}},
            f"rename editable version {editable['attributes'].get('versionString')} to {args.version}")
    elif target is None:
        target = asc.write('POST', '/v1/appStoreVersions', {'data': {
            'type': 'appStoreVersions',
            'attributes': {'platform': 'IOS', 'versionString': args.version, 'releaseType': release_type},
            'relationships': {'app': ref('apps', asc.app_id)}}}, f'create version {args.version}')['data']
    else:
        asc.write('PATCH', f"/v1/appStoreVersions/{target['id']}", {'data': {
            'type': 'appStoreVersions', 'id': target['id'], 'attributes': {'releaseType': release_type}}},
            f'set release type {release_type}')
    vid = target['id']

    asc.write('PATCH', f'/v1/appStoreVersions/{vid}/relationships/build', ref('builds', build['id']),
              f"attach build {build['attributes']['version']}")

    locs = [] if vid == 'dry-run' else asc.get(f'/v1/appStoreVersions/{vid}/appStoreVersionLocalizations').get('data', [])
    for loc in locs:
        asc.write('PATCH', f"/v1/appStoreVersionLocalizations/{loc['id']}", {'data': {
            'type': 'appStoreVersionLocalizations', 'id': loc['id'], 'attributes': {'whatsNew': args.notes}}},
            f"set What's New ({loc['attributes'].get('locale')})")

    if args.phased:
        phased = None if vid == 'dry-run' else asc.get(f'/v1/appStoreVersions/{vid}/appStoreVersionPhasedRelease').get('data')
        if not phased:
            asc.write('POST', '/v1/appStoreVersionPhasedReleases', {'data': {
                'type': 'appStoreVersionPhasedReleases', 'attributes': {'phasedReleaseState': 'INACTIVE'},
                'relationships': {'appStoreVersion': ref('appStoreVersions', vid)}}}, 'turn on phased release')

    open_subs = asc.get('/v1/reviewSubmissions', **{
        'filter[app]': asc.app_id, 'filter[platform]': 'IOS', 'filter[state]': 'READY_FOR_REVIEW'}).get('data', [])
    sub = open_subs[0] if open_subs else asc.write('POST', '/v1/reviewSubmissions', {'data': {
        'type': 'reviewSubmissions', 'attributes': {'platform': 'IOS'},
        'relationships': {'app': ref('apps', asc.app_id)}}}, 'open a review submission')['data']
    asc.write('POST', '/v1/reviewSubmissionItems', {'data': {
        'type': 'reviewSubmissionItems', 'relationships': {
            'reviewSubmission': ref('reviewSubmissions', sub['id']),
            'appStoreVersion': ref('appStoreVersions', vid)}}}, f'add version {args.version} to it')
    asc.write('PATCH', f"/v1/reviewSubmissions/{sub['id']}", {'data': {
        'type': 'reviewSubmissions', 'id': sub['id'], 'attributes': {'submitted': True}}}, 'submit for App Review')


def cmd_release(asc: Asc, args) -> None:
    v = find_version(asc, args.version)
    if version_state(v) != 'PENDING_DEVELOPER_RELEASE':
        sys.exit(f'Version {args.version} is {version_state(v)}, not waiting for a manual release')
    asc.write('POST', '/v1/appStoreVersionReleaseRequests', {'data': {
        'type': 'appStoreVersionReleaseRequests',
        'relationships': {'appStoreVersion': ref('appStoreVersions', v['id'])}}}, f'release {args.version}')


def cmd_phased(asc: Asc, args) -> None:
    v = find_version(asc, args.version)
    phased = asc.get(f"/v1/appStoreVersions/{v['id']}/appStoreVersionPhasedRelease").get('data')
    if not phased:
        sys.exit(f'Version {args.version} has no phased release')
    asc.write('PATCH', f"/v1/appStoreVersionPhasedReleases/{phased['id']}", {'data': {
        'type': 'appStoreVersionPhasedReleases', 'id': phased['id'],
        'attributes': {'phasedReleaseState': args.state}}}, f'set phased release {args.state}')


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--dry-run', action='store_true', help='print writes instead of sending them')
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--dry-run', action='store_true', default=argparse.SUPPRESS)
    sub = parser.add_subparsers(dest='cmd', required=True)
    sub.add_parser('status')
    sub.add_parser('check-access')
    p = sub.add_parser('testflight', parents=[common])
    p.add_argument('--group', required=True)
    p.add_argument('--version')
    p.add_argument('--build')
    p.add_argument('--notes')
    p = sub.add_parser('submit', parents=[common])
    p.add_argument('--version', required=True)
    p.add_argument('--build')
    p.add_argument('--notes', required=True, help="What's New, for every localization")
    p.add_argument('--phased', action='store_true')
    p.add_argument('--manual-release', action='store_true', help='hold the approved version for `release`')
    p = sub.add_parser('release', parents=[common])
    p.add_argument('--version', required=True)
    p = sub.add_parser('phased', parents=[common])
    p.add_argument('--version', required=True)
    p.add_argument('--state', required=True, choices=['ACTIVE', 'PAUSED', 'COMPLETE'])
    args = parser.parse_args(argv)

    asc = Asc(args.dry_run)
    handlers = {
        'status': cmd_status, 'check-access': cmd_check_access, 'testflight': cmd_testflight,
        'submit': cmd_submit, 'release': cmd_release, 'phased': cmd_phased,
    }
    try:
        handlers[args.cmd](asc, args)
    except AscError as err:
        sys.exit(f'App Store Connect error: {err.short()}')


if __name__ == '__main__':
    main(sys.argv[1:] or shlex.split(os.environ.get('STORE_ARGS', '')))
