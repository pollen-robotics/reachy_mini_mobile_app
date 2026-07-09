/**
 * Hugging Face token accessor for non-React conversation modules.
 *
 * The app obtains the token through the top-level HF sign-in flow and
 * mirrors it into `sessionStorage.hf_token` for the Reachy Mini SDK. The
 * realtime backend and vision provider both use the same source so a future
 * migration to OS keychain storage only has one feature-local seam to update.
 */
export function readHfTokenFromStorage(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem("hf_token");
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
