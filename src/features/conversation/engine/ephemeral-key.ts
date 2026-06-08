/**
 * OpenAI Realtime ephemeral key acquisition.
 *
 * What this replaces
 * ------------------
 * Until 2026-05 the mobile shell baked a long-lived OpenAI API key
 * into the bundle (`VITE_OPENAI_API_KEY` -> `BUILD_TIME_OPENAI_KEY`
 * in `settings.ts`). That key was extractable from any shipped
 * IPA / APK and violated OpenAI's terms of service for distributed
 * clients. This module is the replacement:
 *
 *   1. Phone holds an HF token (acquired via the in-app
 *      `ASWebAuthenticationSession` OAuth flow on iOS, stored at
 *      `localStorage.remote_hf_token` and mirrored into
 *      `sessionStorage.hf_token` for the SDK).
 *   2. We POST that HF token as `Authorization: Bearer <hf_token>`
 *      to the Reachy Mini website's `/api/openai/ephemeral`
 *      endpoint.
 *   3. The website server validates the HF token via
 *      `whoami-v2`, rate-limits per HF user, then mints a
 *      short-lived (~10 min) OpenAI Realtime client secret using
 *      the master `OPENAI_API_KEY` that stays in the Space's
 *      secrets.
 *   4. We return the `ek_…` value to the caller, who uses it as
 *      the `Authorization: Bearer` for the
 *      `POST /v1/realtime/calls` GA handshake.
 *
 * Caching
 * -------
 * Ephemeral keys are issued with a default ~10-minute lifetime.
 * The OpenAI Realtime API only consumes the key once, during the
 * SDP handshake; once the WebRTC tunnel is established the
 * conversation runs over the data channel and doesn't re-auth.
 *
 * In practice each call to `mintEphemeralKey()` corresponds to
 * one conversation start (the engine's `runConversationParts`
 * path), and reconnects from the bridge naturally hit this
 * module again. We still keep a tiny in-memory cache with a 60-
 * second safety buffer so a transparent reconnect in rapid
 * succession (e.g. an ICE blip immediately after the SDP exchange)
 * can reuse a still-valid key and skip the network round-trip.
 *
 * Refresh strategy
 * ----------------
 * If the OpenAI handshake ever rejects a key (401 / 403) - which
 * the cache should make rare - the caller should request a fresh
 * one. We expose `invalidateEphemeralKey()` for that path.
 *
 * Error surface
 * -------------
 * - No HF token in storage -> `EphemeralKeyError('hf_token_missing')`
 *   so the engine can fall back to the "Sign in to Hugging Face"
 *   path rather than the legacy "Add OpenAI key in settings".
 * - Network or upstream failure -> `EphemeralKeyError('mint_failed')`
 *   with the HTTP status attached for diagnostics.
 */
import { WEBSITE_API_URL } from "@/shared/env";
import { readHfTokenFromStorage } from "./hf-token";

export type EphemeralKeyReason = "hf_token_missing" | "mint_failed";

export class EphemeralKeyError extends Error {
  readonly reason: EphemeralKeyReason;
  readonly status?: number;

  constructor(reason: EphemeralKeyReason, message: string, status?: number) {
    super(message);
    this.name = "EphemeralKeyError";
    this.reason = reason;
    this.status = status;
  }
}

interface CachedEphemeral {
  value: string;
  expiresAt: number;
}

const MINT_ENDPOINT = `${WEBSITE_API_URL}/api/openai/ephemeral`;

// Safety buffer: refuse to reuse a cached key whose remaining
// lifetime is below this threshold. Picks a value comfortably
// above the worst-case handshake duration we've observed (1-2 s
// on a cold cellular network) so a cached key handed off to the
// bridge always survives long enough to complete the SDP
// exchange.
const CACHE_SAFETY_BUFFER_MS = 60 * 1000;

let cached: CachedEphemeral | null = null;

// `readHfTokenFromStorage` used to live here; it was hoisted to
// `./hf-token` so the HF realtime backend (which has no ephemeral-key
// concept) can read the token without dragging in the OpenAI minting
// logic. We re-use that single source of truth here.

/**
 * Mint a fresh OpenAI Realtime ephemeral key, or return a
 * still-valid cached one. The cache is invalidated automatically
 * when the remaining lifetime falls below `CACHE_SAFETY_BUFFER_MS`.
 *
 * Throws `EphemeralKeyError` on any failure - the caller is
 * expected to surface a user-facing message and abort the
 * conversation start (the bridge has no fallback path that
 * doesn't go through OpenAI).
 */
export async function mintEphemeralKey(): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt - now > CACHE_SAFETY_BUFFER_MS) {
    return cached.value;
  }
  cached = null;

  const hfToken = readHfTokenFromStorage();
  if (!hfToken) {
    throw new EphemeralKeyError(
      "hf_token_missing",
      "no HF token in sessionStorage; sign in to Hugging Face first",
    );
  }

  let response: Response;
  try {
    response = await fetch(MINT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hfToken}`,
        "Content-Type": "application/json",
      },
      // Empty body is fine: the server defaults to the
      // mobile-pinned model + voice (`gpt-realtime-2` + `cedar`).
      body: "{}",
    });
  } catch (err) {
    throw new EphemeralKeyError(
      "mint_failed",
      `network error reaching ${MINT_ENDPOINT}: ${(err as Error)?.message ?? "unknown"}`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new EphemeralKeyError(
      "mint_failed",
      `mint endpoint returned ${response.status}: ${text.slice(0, 200)}`,
      response.status,
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | { value?: unknown; expires_at?: unknown }
    | null;
  const value = typeof payload?.value === "string" ? payload.value : "";
  const expiresAt =
    typeof payload?.expires_at === "number" ? payload.expires_at * 1000 : 0;

  if (!value || expiresAt <= 0) {
    throw new EphemeralKeyError(
      "mint_failed",
      "mint endpoint returned malformed payload",
    );
  }

  cached = { value, expiresAt };
  // Log lifetime only - never the key value. Helps debug "the
  // bridge says 401" by confirming we minted a key whose lifetime
  // covered the handshake.
  const remainingSec = Math.round((expiresAt - now) / 1000);
  console.info(
    `[ephemeral-key] minted (length=${value.length}, ttl=${remainingSec}s)`,
  );
  return value;
}

/**
 * Drop the cached key so the next `mintEphemeralKey()` call hits
 * the network. Called by the bridge when a handshake fails with
 * 401/403 so a transient revocation (e.g. the server rotated the
 * master key) can recover on the next attempt without forcing
 * the user to re-sign-in.
 */
export function invalidateEphemeralKey(): void {
  cached = null;
}
