//! Loopback OAuth bridge for in-app ASWebAuthenticationSession.
//!
//! Why this exists
//! ───────────────
//! Apple's App Store Review rejects OAuth flows that hand the user off
//! to Safari for sign-in ("poor UX" per their guidelines). The approved
//! pattern on iOS is `ASWebAuthenticationSession`, which intercepts a
//! *custom URL scheme* (e.g. `reachymini://oauth/callback`) and keeps
//! the user inside the app for the duration of the round-trip.
//!
//! HuggingFace's OAuth client `71146982-...` is registered with exactly
//! one redirect URI (`http://localhost:8000/api/hf-auth/oauth/callback`,
//! originally provisioned for the daemon's loopback flow). We don't want
//! to ask HF to register an additional `reachymini://` redirect, so this
//! module acts as a *bridge*:
//!
//!   1. Frontend calls [`start_oauth_bridge`] which binds `127.0.0.1:8000`
//!      and spawns a tokio task that waits for ONE HTTP request matching
//!      `/api/hf-auth/oauth/callback`.
//!   2. Frontend opens `ASWebAuthenticationSession` (via
//!      `tauri-plugin-auth-session`) pointing at HF's `/oauth/authorize`
//!      with `redirect_uri=http://localhost:8000/...` and
//!      `callbackUrlScheme=reachymini`. The user signs in.
//!   3. HF redirects the embedded WebView to `http://localhost:8000/...`,
//!      which lands on our loopback.
//!   4. The loopback responds with `HTTP/1.1 302 Found` and
//!      `Location: reachymini://oauth/callback?<same query>` -- a
//!      blind passthrough of HF's query string.
//!   5. The embedded WebView attempts to navigate to `reachymini://`,
//!      `ASWebAuthenticationSession` intercepts the scheme and resolves
//!      the plugin promise with the full URL.
//!   6. Frontend parses `code`+`state` from that URL, validates `state`,
//!      and exchanges the code for a token.
//!
//! Parsing & state validation happen entirely on the frontend now. This
//! bridge is intentionally dumb: it doesn't read the params, it just
//! mirrors them onto the scheme. That keeps the surface tiny and avoids
//! the "validate twice, drift between languages" trap.
//!
//! Android and the user-gesture rule
//! ─────────────────────────────────
//! Step 5 is NOT guaranteed on Android: browsers may block a gesture-less
//! scheme launch (e.g. a silent re-auth runs the whole redirect chain
//! with zero taps in the tab) and render the 302 body instead. So the
//! body is a tappable interstitial re-firing the scheme URL (a tap is a
//! real gesture), and the bridge keeps the relayed callback for
//! [`take_oauth_callback`] so the frontend can finish the exchange even
//! if the user just closes the tab. iOS/macOS never see any of this:
//! `ASWebAuthenticationSession` intercepts `Location` before rendering.
//!
//! Lifecycle
//! ─────────
//! `start_oauth_bridge` returns once the bind succeeded, then the
//! listener task lives in the background. It exits after the first
//! callback hit, on cancellation, or on [`FLOW_TIMEOUT`]. The slot
//! is released in all three cases so a follow-up sign-in works.

use std::io::Result as IoResult;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::time::timeout;

/// Loopback port we bind to. Must match the redirect URI HF has
/// registered for the OAuth client we reuse. See module docs.
const LOOPBACK_PORT: u16 = 8000;
/// Path component the OAuth flow sends the browser to. Must match the
/// registered redirect URI exactly.
const CALLBACK_PATH: &str = "/api/hf-auth/oauth/callback";
/// Custom URL scheme `ASWebAuthenticationSession` (and the matching
/// Chrome Custom Tabs intent filter on Android) listens for. The
/// hostname (`oauth`) and path (`/callback`) are arbitrary and only
/// chosen for readability in logs.
const SCHEME_REDIRECT_PREFIX: &str = "reachymini://oauth/callback";
/// Hard wall on how long we'll hold port 8000 waiting for the browser
/// callback. Anything longer almost certainly means the user dropped
/// the auth sheet; release the port so a retry can rebind.
const FLOW_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum OAuthError {
    #[error("oauth bridge already in flight")]
    AlreadyRunning,
    #[error("could not bind {addr}: {detail}")]
    Bind { addr: String, detail: String },
    #[error("internal error: {0}")]
    Internal(String),
}

/// Single in-flight slot. `Some(_)` means a listener task is alive
/// somewhere and holding port 8000; subsequent `start_oauth_bridge`
/// calls bail with `AlreadyRunning` instead of racing the bind.
///
/// The held value is a sender that, when dropped, signals the task
/// to abort via its `oneshot::Receiver` arm. `cancel_oauth_bridge`
/// just drops the slot's content for that effect.
static IN_FLIGHT: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

/// Last relayed callback URL; Android rescue path, see module docs.
static CAPTURED_CALLBACK: Mutex<Option<String>> = Mutex::new(None);

/// Bind the loopback bridge and spawn its listener task.
///
/// Returns synchronously after the bind succeeds so the caller can
/// open the auth session immediately without racing on port 8000.
/// The listener task lives in the background and exits on:
///   - the first matching callback hit (302 sent, success),
///   - drop of the in-flight sender (cancellation),
///   - `FLOW_TIMEOUT` elapsing without a hit.
///
#[tauri::command]
pub async fn start_oauth_bridge() -> Result<(), OAuthError> {
    let cancel_rx = {
        let mut slot = IN_FLIGHT
            .lock()
            .map_err(|e| OAuthError::Internal(e.to_string()))?;
        if slot.is_some() {
            return Err(OAuthError::AlreadyRunning);
        }
        let (tx, rx) = oneshot::channel::<()>();
        *slot = Some(tx);
        rx
    };

    // Clear any stale capture from a previous flow.
    if let Ok(mut captured) = CAPTURED_CALLBACK.lock() {
        *captured = None;
    }

    // Bind synchronously: callers want immediate feedback if port 8000
    // is taken (another sign-in racing, or some other localhost service
    // squatting the port). Doing this inside the spawned task would
    // turn a deterministic failure into a silent hang from the JS
    // side's point of view.
    let addr = format!("127.0.0.1:{LOOPBACK_PORT}");
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            release_slot();
            return Err(OAuthError::Bind {
                addr,
                detail: e.to_string(),
            });
        }
    };

    tracing::info!(
        target: "oauth",
        "bridge bound on {addr}, waiting for HF callback to relay onto {SCHEME_REDIRECT_PREFIX}",
    );

    tokio::spawn(async move {
        let outcome = run_bridge(listener, cancel_rx).await;
        match outcome {
            Ok(()) => tracing::info!(
                target: "oauth",
                "bridge relayed callback to {SCHEME_REDIRECT_PREFIX}",
            ),
            Err(reason) => tracing::warn!(target: "oauth", "bridge exited: {reason}"),
        }
        release_slot();
    });

    Ok(())
}

/// Abort an in-flight bridge. Safe to call when no bridge is running
/// (no-op). Used as both the user-pressed-cancel hook and as a finally
/// cleanup from the frontend after the auth-session promise resolves
/// (so we release port 8000 even if the user cancelled the auth sheet
/// before HF ever fired the redirect).
#[tauri::command]
pub fn cancel_oauth_bridge() -> Result<(), OAuthError> {
    release_slot();
    Ok(())
}

/// Consume the captured callback URL (take-once). `cancel_oauth_bridge`
/// deliberately leaves it: the frontend's `finally` runs before the
/// rescue read.
#[tauri::command]
pub fn take_oauth_callback() -> Option<String> {
    CAPTURED_CALLBACK
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())
}

fn release_slot() {
    if let Ok(mut slot) = IN_FLIGHT.lock() {
        // Dropping the sender closes the oneshot; the listener task's
        // `select!` arm wakes up on the closed-channel signal and exits.
        // If the slot was already empty (race between success and
        // cancel) this is a no-op.
        *slot = None;
    }
}

async fn run_bridge(
    listener: TcpListener,
    mut cancel_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    // We accept multiple connections in case the browser hits
    // `/favicon.ico` or DevTools probes the page before the real
    // callback lands. We only return for a request that targets
    // CALLBACK_PATH; everything else gets a 404 and we keep going.
    loop {
        tokio::select! {
            _ = (&mut cancel_rx) => {
                return Err("cancelled".to_string());
            }
            res = timeout(FLOW_TIMEOUT, listener.accept()) => {
                let accepted = match res {
                    Err(_) => return Err("timed out".to_string()),
                    Ok(Ok(c)) => c,
                    Ok(Err(e)) => return Err(format!("accept failed: {e}")),
                };
                let (mut socket, _peer) = accepted;
                let request_line = match read_request_line(&mut socket).await {
                    Ok(line) => line,
                    Err(e) => {
                        tracing::warn!(target: "oauth", "drop bridge conn: {e}");
                        let _ = socket.shutdown().await;
                        continue;
                    }
                };

                let url_target = parse_request_target(&request_line);
                let target = match url_target {
                    Some(t) if t.starts_with(CALLBACK_PATH) => t,
                    _ => {
                        let _ = write_404(&mut socket).await;
                        let _ = socket.shutdown().await;
                        continue;
                    }
                };

                // Mirror the original query (or empty) onto the scheme.
                // We don't parse `code`/`state` here: the auth-session
                // plugin delivers the full URL to JS, which validates
                // state and exchanges the code in one place.
                let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
                let location = if query.is_empty() {
                    SCHEME_REDIRECT_PREFIX.to_string()
                } else {
                    format!("{SCHEME_REDIRECT_PREFIX}?{query}")
                };

                // Capture before responding so a fast tab-close can't
                // race it.
                if let Ok(mut captured) = CAPTURED_CALLBACK.lock() {
                    *captured = Some(location.clone());
                }

                let _ = write_302(&mut socket, &location).await;
                let _ = socket.shutdown().await;
                return Ok(());
            }
        }
    }
}

/// Pull the first line from the request (`GET /path?... HTTP/1.1`),
/// keeping the read window short so a stalled client cannot wedge us.
async fn read_request_line(socket: &mut tokio::net::TcpStream) -> IoResult<String> {
    let mut buf = vec![0u8; 4096];
    let read_fut = socket.read(&mut buf);
    let n = timeout(Duration::from_secs(5), read_fut)
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "request read timed out"))??;
    let head = String::from_utf8_lossy(&buf[..n]);
    Ok(head
        .lines()
        .next()
        .map(|s| s.to_string())
        .unwrap_or_default())
}

fn parse_request_target(request_line: &str) -> Option<String> {
    // request line format: METHOD SP TARGET SP HTTP-VERSION
    let mut parts = request_line.split_whitespace();
    parts.next()?; // method
    parts.next().map(|s| s.to_string())
}

async fn write_302(socket: &mut tokio::net::TcpStream, location: &str) -> IoResult<()> {
    // Body = the Android interstitial (see module docs). No JS
    // auto-redirect: it would be as gesture-less as the 302 it replaces.
    let href = html_escape_attr(location);
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
<title>Reachy Mini</title><style>\
body{{font-family:sans-serif;text-align:center;padding:20vh 24px}}\
a{{display:inline-block;padding:14px 28px;background:#ff9d00;color:#fff;border-radius:999px;text-decoration:none}}\
</style></head><body>\
<h1>Almost done</h1>\
<p>Tap the button below to return to the app and finish signing in.</p>\
<a href=\"{href}\">Open Reachy Mini</a>\
</body></html>"
    );
    let response = format!(
        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {len}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        len = body.len()
    );
    socket.write_all(response.as_bytes()).await
}

/// HTML attribute escaping for the interstitial's `href` (the query
/// comes straight from HF's redirect, so treat it as untrusted).
fn html_escape_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

async fn write_404(socket: &mut tokio::net::TcpStream) -> IoResult<()> {
    let body = "Not the OAuth callback path.";
    let response = format!(
        "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
        len = body.len()
    );
    socket.write_all(response.as_bytes()).await
}
