/**
 * Low-level HF Hub REST calls for Space like / unlike.
 *
 * Endpoints (confirmed against the public `huggingface_hub` client, see
 * `HfApi.like()` / `HfApi.unlike()` + PR #1254 discussion):
 *
 *   POST    https://huggingface.co/api/spaces/{owner}/{repo}/like
 *   DELETE  https://huggingface.co/api/spaces/{owner}/{repo}/like
 *   GET     https://huggingface.co/api/users/{username}/likes
 *
 * Auth model
 * ──────────
 * The HF backend currently **forbids `POST /like` for personal access
 * tokens (PAT)** as an anti-abuse measure (script-driven trending boost
 * incidents in the past). It is, however, allowed for **OAuth tokens**
 * obtained via the standard PKCE / device flows. The mobile app's
 * `oauthLoopback.ts` produces exactly that kind of token, so this
 * module is the right surface for the like UX.
 *
 * If the call hits a `403`, we surface that as `LikeForbiddenError`
 * so the UI can suggest signing in again (in case the user pasted a
 * PAT manually in dev mode).
 *
 * Unlike verb
 * ───────────
 * Both `DELETE /like` and `POST /unlike` exist server-side. We
 * standardise on `DELETE /like` because it is the modern, idempotent
 * form (Wauplin's note in PR #1254: "if we were to cement the unlike
 * in the hub_api, maybe a DELETE on the same endpoint would be
 * better").
 */
const HF_BASE = 'https://huggingface.co';

export class LikeForbiddenError extends Error {
  constructor(message = 'HF rejected the like (token is likely a PAT, not OAuth)') {
    super(message);
    this.name = 'LikeForbiddenError';
  }
}

/**
 * 401 from `/like`. Distinct from `LikeForbiddenError` (403) because
 * the remediation is different: 401 means the bearer wasn't accepted
 * at all (missing, expired, malformed), whereas 403 means the bearer
 * was authenticated but doesn't have permission (typically a PAT
 * hitting `POST /like`). UIs typically map this to "please sign in
 * again".
 */
export class LikeUnauthorizedError extends Error {
  constructor(message = 'HF rejected the bearer token (missing, expired, or malformed)') {
    super(message);
    this.name = 'LikeUnauthorizedError';
  }
}

/**
 * Parse `<owner>/<repo>` from an app id. The mobile app already
 * normalises every catalog entry to that shape (see `resolveAppId`
 * in `useApps.ts`), but we still defensively reject bare ids here:
 * a like call without an owner would 400 anyway and the failure
 * mode is much clearer at the call site.
 */
function splitRepoId(appId: string): { owner: string; repo: string } {
  const slash = appId.indexOf('/');
  if (slash <= 0 || slash === appId.length - 1) {
    throw new Error(
      `likesApi: expected "<owner>/<repo>" app id, got "${appId}"`,
    );
  }
  return {
    owner: appId.slice(0, slash),
    repo: appId.slice(slash + 1),
  };
}

async function callLikeEndpoint(
  method: 'POST' | 'DELETE',
  token: string,
  appId: string,
): Promise<void> {
  const { owner, repo } = splitRepoId(appId);
  const url = `${HF_BASE}/api/spaces/${encodeURIComponent(
    owner,
  )}/${encodeURIComponent(repo)}/like`;
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  // Idempotency note: `POST /like` returns 200 on first like AND on
  // re-like (already liked); `DELETE /like` returns 200 on first
  // unlike AND when nothing was liked. So we don't need to special-
  // case "already done" responses - they look like success.
  if (resp.ok) return;
  if (resp.status === 401) {
    throw new LikeUnauthorizedError();
  }
  if (resp.status === 403) {
    throw new LikeForbiddenError();
  }
  const body = await resp.text().catch(() => '');
  throw new Error(`HF ${method} /like HTTP ${resp.status}: ${body}`);
}

/** Like the given Space (`POST /api/spaces/{id}/like`). */
export function likeSpace(token: string, appId: string): Promise<void> {
  return callLikeEndpoint('POST', token, appId);
}

/** Unlike the given Space (`DELETE /api/spaces/{id}/like`). */
export function unlikeSpace(token: string, appId: string): Promise<void> {
  return callLikeEndpoint('DELETE', token, appId);
}

/**
 * Shape of a single entry in the `/api/users/{username}/likes` payload.
 * We only consume `repo.type` + `repo.id`; the rest (createdAt, etc.) is
 * dropped because the mobile app's "is liked?" check is binary.
 */
interface RawLikedRepoEntry {
  repo?: {
    type?: string;
    id?: string;
    name?: string;
  };
  // Some payload variants put the fields at the top level instead of
  // under `repo`. We accept both for forward compatibility.
  type?: string;
  id?: string;
  name?: string;
}

interface RawLikesPayload {
  totalCount?: number;
  visibleLikes?: RawLikedRepoEntry[];
  // Older revisions of the endpoint returned a bare array, defensive
  // path so we don't crash if the shape ever rolls back.
  [key: string]: unknown;
}

/**
 * Fetch the full set of Space ids the user has liked.
 *
 * Returns a `Set<string>` of `<owner>/<repo>` ids so callers can do
 * O(1) `has()` checks per tile. Only `repo.type === 'space'` entries
 * are kept; models and datasets are dropped because the mobile app
 * never surfaces them.
 *
 * If `totalCount > visibleLikes.length` (the catalog hid some likes,
 * e.g. private repos the user no longer has access to), we silently
 * ignore the gap: we'd rather under-mark a tile as "not liked yet"
 * and let the POST be a no-op than mis-paint the heart filled for a
 * repo the user can't actually like anymore.
 */
export async function fetchUserLikedSpaces(
  token: string,
  username: string,
): Promise<Set<string>> {
  const url = `${HF_BASE}/api/users/${encodeURIComponent(username)}/likes`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!resp.ok) {
    throw new Error(`HF GET /users/${username}/likes HTTP ${resp.status}`);
  }
  const payload = (await resp.json()) as RawLikesPayload | RawLikedRepoEntry[];
  const entries: RawLikedRepoEntry[] = Array.isArray(payload)
    ? payload
    : (payload.visibleLikes ?? []);
  const liked = new Set<string>();
  for (const e of entries) {
    const type = e.repo?.type ?? e.type;
    const id = e.repo?.id ?? e.repo?.name ?? e.id ?? e.name;
    if (type !== 'space') continue;
    if (typeof id !== 'string' || id.length === 0) continue;
    liked.add(id);
  }
  return liked;
}
