/**
 * Pre-seed the Hugging Face access token from the URL fragment.
 *
 * History: when the conversation engine was hosted in an HF Space
 * iframe, the parent page couldn't redirect the iframe to
 * `huggingface.co/login` (X-Frame-Options blocks it). The mobile
 * shell already had a valid token from its own OAuth flow and
 * appended it to the iframe URL as `#hf_token=...`. The fragment
 * never travels over HTTP, so the token doesn't leak to the Space
 * backend or intermediate proxies.
 *
 * On the bundled mobile build the host writes the token directly
 * into `sessionStorage.hf_token` from `useRemoteHfToken`, so this
 * function is a no-op in practice. Kept for forward-compat with
 * the iframe deployment path.
 */
export function consumeTokenFromHash(): void {
  if (typeof window === 'undefined' || !window.location.hash) return;
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(hash);
  } catch {
    return;
  }
  const token = params.get('hf_token');
  if (!token) return;

  try {
    sessionStorage.setItem('hf_token', token);
  } catch (err) {
    console.warn('[main] could not persist pre-seeded HF token:', err);
  }

  // Remove the `hf_token` fragment but keep any other hash params
  // the app or SDK might care about (theme, embedded, …).
  params.delete('hf_token');
  const remaining = params.toString();
  const cleanUrl =
    window.location.pathname +
    window.location.search +
    (remaining ? `#${remaining}` : '');
  try {
    window.history.replaceState(null, '', cleanUrl);
  } catch {
    // replaceState can fail on ancient browsers; non-fatal.
  }
}

/**
 * Resolve when `window.ReachyMini` becomes available. Always
 * resolves immediately on the bundled build (the SDK is attached to
 * the global by `sdkBootstrap.ts` at module load), kept around for
 * the CDN-loaded Space deployment where the SDK arrives via a
 * `<script type="module">` and dispatches `reachymini:ready` on the
 * window when ready.
 */
export function whenReachyReady(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.ReachyMini) return Promise.resolve();
  return new Promise((resolve) => {
    window.addEventListener('reachymini:ready', () => resolve(), {
      once: true,
    });
  });
}
