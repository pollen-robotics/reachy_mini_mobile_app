/**
 * Sticker-avatar generation client.
 *
 * Bridges the personality authoring UI to the Reachy Sticker Generator
 * Space (`STICKER_API_URL`). The flow has three stages, each surfaced
 * to the UI as a `StickerStatus`:
 *
 *   1. `crafting`   - an LLM turns the persona (name + tagline +
 *                     instructions) into a short, concrete VISUAL theme
 *                     ("noir detective in a trench coat"), which is a
 *                     far better sticker prompt than the raw system
 *                     prompt. Best-effort: falls back to the name when
 *                     no HF token is present or the call fails.
 *   2. `queued` /
 *      `generating` - the sticker Space renders the character (~1 min,
 *                     2 concurrent slots server-side). We expose the
 *                     queue size so the UI can show a waiting position.
 *   3. `done`        - the resulting image is fetched and inlined as a
 *                     data URI so it persists in localStorage offline
 *                     (no dependency on the Space staying up). SVG is
 *                     preferred (vector, matches the built-in avatars);
 *                     PNG is the fallback.
 *
 * CORS: the Space serves no `Access-Control-Allow-Origin`, so every
 * request goes through `@tauri-apps/plugin-http` (proxied by the Rust
 * runtime). The host is allow-listed in
 * `src-tauri/capabilities/default.json`.
 */
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

import { readHfTokenFromStorage } from '@/features/conversation/engine/hf-token';
import { STICKER_API_URL } from '@/shared/env';

import type { CustomPersonalityInput } from './types';
import { routerChatCompletion } from '@/features/hf';

/**
 * Crop margin (per side, as a fraction of the subject) requested from the
 * sticker Space. The built-in persona avatars carry generous whitespace in
 * their viewBox (subject ~70% of the frame, head top-weighted), and
 * `PersonaAvatar` renders them oversized (`imageScale` ~1.4) so the head
 * lands centred with antennas spilling above the disc. The Space's default
 * crop is tight (~2%), which makes a sticker fill the disc edge-to-edge and
 * look "too big" next to the built-ins. ~0.2 reframes it to match.
 */
const STICKER_AVATAR_PADDING = 0.2;

/** Sticker Space origin without a trailing slash, so request paths can be
 *  appended directly (the env value may or may not carry one). */
const STICKER_BASE = STICKER_API_URL.replace(/\/$/, '');

/** Text model used to craft the visual theme. Small + widely served
 *  on the HF router; overridable for tuning without a code change. */
export const STICKER_AVATAR_MODEL: string =
  (import.meta.env.VITE_REACHY_STICKER_THEME_MODEL as string | undefined) ??
  'Qwen/Qwen2.5-7B-Instruct';

/** UI-facing lifecycle of a single avatar generation. */
export type StickerStatus =
  | 'idle'
  | 'crafting'
  | 'queued'
  | 'generating'
  | 'done'
  | 'error';

export interface StickerAvatarResult {
  /** Inlined image, ready to drop into `Personality.avatar`. */
  dataUri: string;
  /** Which representation we inlined. */
  format: 'svg' | 'png';
  /** The visual theme actually sent to the sticker API. */
  theme: string;
}

/** Thrown when the sticker Space is overloaded (429/503). Surfaced as
 *  a distinct, retry-friendly state in the UI rather than a generic
 *  failure. */
export class StickerOverloadedError extends Error {
  constructor(message = 'The sticker service is busy. Try again in a minute.') {
    super(message);
    this.name = 'StickerOverloadedError';
  }
}

/**
 * Response shape of `/api/generate` (and of a poll on `/api/jobs/{id}`).
 *
 * The current backend answers synchronously: the image URLs are present
 * right away. A future async/queue backend may instead hand back a job
 * handle (`job_id`/`status_url`, no image yet) that we poll until the
 * image URLs appear. A payload is "ready" once it carries an image URL.
 */
interface StickerJob {
  id?: string;
  prompt?: string;
  png_url?: string;
  svg_url?: string | null;
  /** Async backend only: handle + status to poll until ready. */
  job_id?: string;
  status_url?: string;
  status?: string;
  queue_size?: number;
  detail?: string;
}

/** Resolve a (possibly relative) sticker URL against the Space host. */
function absoluteUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${STICKER_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * Auth header for the sticker Space. The Space is private on HF, so
 * `*.hf.space` requests must carry the user's HF token as a bearer to
 * get past HF's access proxy. Harmless when the Space is public (the
 * FastAPI routes themselves don't check it). Omitted when no token is
 * in session - the caller then surfaces a sign-in prompt on the 401.
 */
function stickerAuthHeaders(): Record<string, string> {
  const token = readHfTokenFromStorage();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Base64-encode raw bytes in chunks (avoids the arg-count blow-up of
 *  `String.fromCharCode(...hugeArray)` on large PNGs). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** UTF-8-safe base64 of a string (SVG markup can carry non-ASCII). */
function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/**
 * Poll the sticker Space's queue length. Best-effort: returns 0 on any
 * failure so the UI degrades to "no position shown" rather than
 * erroring.
 */
export async function fetchStickerQueueSize(signal?: AbortSignal): Promise<number> {
  try {
    const res = await tauriFetch(`${STICKER_BASE}/api/queue`, {
      method: 'GET',
      headers: stickerAuthHeaders(),
      signal,
    });
    if (!res.ok) return 0;
    const data = (await res.json()) as { queue_size?: number };
    return typeof data.queue_size === 'number' ? data.queue_size : 0;
  } catch {
    return 0;
  }
}

/**
 * Turn a persona into a short visual sticker theme via an LLM.
 *
 * Returns a concise, concrete look (e.g. "cheerful pirate captain with
 * an eyepatch"). Always resolves: on any problem (no token, network,
 * empty completion) it falls back to a heuristic derived from the
 * persona name so generation can still proceed.
 */
export async function craftStickerTheme(
  persona: Pick<CustomPersonalityInput, 'name' | 'tagline' | 'instructions'>,
  signal?: AbortSignal,
): Promise<string> {
  const fallback = heuristicTheme(persona);
  const token = readHfTokenFromStorage();
  if (!token) return fallback;

  const userBlock = [
    `Name: ${persona.name || '(unnamed)'}`,
    persona.tagline ? `Tagline: ${persona.tagline}` : '',
    persona.instructions ? `Personality: ${persona.instructions}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    // Provider-rotating round-trip so a single overloaded provider doesn't
    // force the heuristic fallback while another one could have answered.
    const res = await routerChatCompletion({
      baseModel: STICKER_AVATAR_MODEL,
      hfToken: token,
      signal,
      body: {
        max_tokens: 30,
        temperature: 0.7,
        messages: [
          {
            role: 'system',
            content:
              'You turn a chatbot persona into a SHORT visual description ' +
              'for a cute robot sticker. Reply with 3 to 8 words describing ' +
              'the character look only (outfit, props, vibe). No name, no ' +
              'quotes, no punctuation, no explanation. Example: "noir ' +
              'detective in a trench coat and fedora".',
          },
          { role: 'user', content: userBlock },
        ],
      },
    });
    if (!res.ok) return fallback;
    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = payload.choices?.[0]?.message?.content ?? '';
    const cleaned = cleanTheme(raw);
    return cleaned || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Generate a sticker avatar for a visual theme and inline it as a data
 * URI. Reports progress via `onStatus` (`queued`/`generating`).
 *
 * Transport-agnostic on purpose, so the shipped app survives a server-side
 * move from the current synchronous endpoint to an async/queue backend
 * WITHOUT an app update: the `POST` either returns the finished image
 * (current behaviour) or a job handle that we then poll until it resolves.
 * The image bytes are fetched separately and base64-inlined so the result
 * survives offline.
 */
export async function generateStickerAvatar(
  theme: string,
  opts: { signal?: AbortSignal; onStatus?: (status: StickerStatus, queueSize: number) => void } = {},
): Promise<StickerAvatarResult> {
  const { signal, onStatus } = opts;
  const prompt = theme.trim();
  if (!prompt) throw new Error('Empty sticker theme');

  const queueSize = await fetchStickerQueueSize(signal);
  onStatus?.(queueSize > 0 ? 'queued' : 'generating', queueSize);

  const res = await tauriFetch(`${STICKER_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...stickerAuthHeaders() },
    signal,
    body: JSON.stringify({ prompt, kind: 'character', padding: STICKER_AVATAR_PADDING }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { detail?: string }).detail ?? '';
    } catch {
      /* body wasn't JSON */
    }
    if (res.status === 429 || res.status === 503 || /overloaded/i.test(detail)) {
      throw new StickerOverloadedError(detail || undefined);
    }
    throw new Error(detail || `Sticker generation failed (${res.status})`);
  }

  const payload = (await res.json()) as StickerJob;

  // Synchronous backend (current): the image URLs are already here.
  // Async backend (future): poll the job handle until they appear.
  const data = hasStickerImage(payload)
    ? payload
    : await pollStickerJob(payload, { signal, onStatus });

  return inlineStickerResult(data, prompt, signal);
}

/** A payload is usable once it exposes at least one image URL. */
function hasStickerImage(job: StickerJob): boolean {
  return Boolean(job.png_url || job.svg_url);
}

/** Resolve after `ms`, or reject early if `signal` aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/**
 * Poll an async sticker job until it produces an image. Follows the
 * server-provided `status_url` when present (so the server keeps full
 * control of its routes), else falls back to `/api/jobs/{job_id}`.
 */
async function pollStickerJob(
  handle: StickerJob,
  opts: { signal?: AbortSignal; onStatus?: (status: StickerStatus, queueSize: number) => void },
): Promise<StickerJob> {
  const { signal, onStatus } = opts;
  const url = handle.status_url
    ? absoluteUrl(handle.status_url)
    : `${STICKER_BASE}/api/jobs/${handle.job_id}`;

  const POLL_INTERVAL_MS = 3000;
  const TIMEOUT_MS = 5 * 60 * 1000;
  const startedAt = Date.now();

  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (Date.now() - startedAt > TIMEOUT_MS) {
      throw new Error('Sticker generation timed out');
    }

    const res = await tauriFetch(url, {
      method: 'GET',
      headers: stickerAuthHeaders(),
      signal,
    });
    if (res.status === 429 || res.status === 503) throw new StickerOverloadedError();
    if (!res.ok) throw new Error(`Sticker job poll failed (${res.status})`);

    const data = (await res.json()) as StickerJob;
    if (hasStickerImage(data)) return data;
    if (data.status === 'failed' || data.status === 'canceled') {
      if (/overloaded/i.test(data.detail ?? '')) throw new StickerOverloadedError(data.detail);
      throw new Error(data.detail || 'Sticker generation failed');
    }

    const size = typeof data.queue_size === 'number' ? data.queue_size : 0;
    onStatus?.(size > 0 ? 'queued' : 'generating', size);

    await delay(POLL_INTERVAL_MS, signal);
  }
}

/**
 * Fetch the generated image(s) and inline as a data URI. Prefers the
 * vector SVG (crisp at any size, matches the built-in avatars); falls
 * back to the PNG.
 */
async function inlineStickerResult(
  data: StickerJob,
  prompt: string,
  signal?: AbortSignal,
): Promise<StickerAvatarResult> {
  if (data.svg_url) {
    try {
      const svgRes = await tauriFetch(absoluteUrl(data.svg_url), {
        method: 'GET',
        headers: stickerAuthHeaders(),
        signal,
      });
      if (svgRes.ok) {
        const svg = await svgRes.text();
        if (svg.includes('<svg')) {
          return {
            dataUri: `data:image/svg+xml;base64,${utf8ToBase64(svg)}`,
            format: 'svg',
            theme: prompt,
          };
        }
      }
    } catch {
      /* fall through to PNG */
    }
  }

  if (!data.png_url) throw new Error('Sticker result missing image URL');
  const pngRes = await tauriFetch(absoluteUrl(data.png_url), {
    method: 'GET',
    headers: stickerAuthHeaders(),
    signal,
  });
  if (!pngRes.ok) throw new Error('Failed to fetch generated sticker image');
  const bytes = new Uint8Array(await pngRes.arrayBuffer());
  return {
    dataUri: `data:image/png;base64,${bytesToBase64(bytes)}`,
    format: 'png',
    theme: prompt,
  };
}

/** Strip the LLM output down to a clean, short, comma-free theme. */
function cleanTheme(raw: string): string {
  return raw
    .split('\n')[0]
    .replace(/^["'`\s]+|["'`.\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 10)
    .join(' ');
}

/** Deterministic fallback theme when the LLM is unavailable. */
function heuristicTheme(
  persona: Pick<CustomPersonalityInput, 'name' | 'tagline'>,
): string {
  const base = (persona.name || persona.tagline || 'friendly robot').trim();
  return base.slice(0, 60);
}
