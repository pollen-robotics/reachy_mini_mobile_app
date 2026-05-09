/**
 * Reactive view of the Hugging Face account behind the current
 * token (avatar URL + canonical username), via TanStack Query.
 *
 * Hits `/api/whoami-v2` once per (token, mount) and caches the
 * result for the rest of the session - the profile rarely moves
 * within a single app run, so we keep `staleTime: Infinity` and
 * skip the focus-refetch dance. The auth gate already validated
 * the token before letting the user in, so a 4xx here is a
 * surprise we surface as "no profile" rather than an error
 * banner: the fallback avatar (initial of the username we
 * already have in memory) keeps the top bar functional.
 *
 * This hook is read-only and intentionally separate from
 * `useRemoteHfToken` (which owns the token lifecycle) and
 * `validateHfToken` (which is a one-shot pre-flight at sign-in
 * time). Splitting them keeps each concern testable and avoids
 * coupling the OAuth path to the avatar fetch.
 */
import { useQuery } from '@tanstack/react-query';

export interface HfProfile {
  username: string | null;
  /** Fully-qualified avatar URL ready to drop into an `<img>` `src`. */
  avatarUrl: string | null;
}

interface WhoamiV2Response {
  name?: string;
  fullname?: string;
  /**
   * The HF whoami payload sometimes returns a path-relative URL
   * (`/avatars/abc.svg`) and sometimes an absolute one. We
   * normalise to absolute in `fetchHfProfile` so the consumer
   * never has to.
   */
  avatarUrl?: string;
}

const HF_BASE = 'https://huggingface.co';
const REQUEST_TIMEOUT_MS = 8000;

function absolutiseAvatarUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  if (raw.startsWith('/')) return `${HF_BASE}${raw}`;
  return `${HF_BASE}/${raw}`;
}

async function fetchHfProfile(token: string): Promise<HfProfile> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(`${HF_BASE}/api/whoami-v2`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`HF whoami HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as WhoamiV2Response;
    return {
      username: data.name ?? data.fullname ?? null,
      avatarUrl: absolutiseAvatarUrl(data.avatarUrl),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function useHfProfile(token: string | null): HfProfile {
  const query = useQuery({
    queryKey: ['hf-profile', token] as const,
    queryFn: () => {
      if (!token) throw new Error('No HF token');
      return fetchHfProfile(token);
    },
    enabled: !!token,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  return query.data ?? { username: null, avatarUrl: null };
}
