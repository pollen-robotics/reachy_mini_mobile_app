//! Loopback OAuth callback receiver.
//!
//! Why this exists
//! ───────────────
//! The mobile app's "remote" mode needs to obtain a HuggingFace
//! access token without going through the robot daemon (which is, by
//! definition, unreachable in remote mode). RFC 8252 ("OAuth 2.0 for
//! Native Apps") describes the canonical pattern: open the system
//! browser, let it redirect back to a loopback HTTP server the app
//! itself runs.
//!
//! HuggingFace already has a registered redirect URI we can reuse
//! (`http://localhost:8000/api/hf-auth/oauth/callback`, registered
//! against client `71146982-…` — Pollen's reachy-mini OAuth app).
//! That redirect was originally meant for the daemon when it runs in
//! "Lite" mode on a host machine; on a phone or laptop with no
//! daemon running locally, port 8000 is free, so we hijack the same
//! URL for the mobile app's OAuth flow. No HF-side change needed.
//!
//! Lifecycle
//! ─────────
//! Frontend calls `start_oauth_callback` → spawns a tokio task that:
//!   1. Binds to `127.0.0.1:8000`.
//!   2. Accepts ONE connection that targets the callback path.
//!   3. Parses query params, returns a small HTML page to the
//!      browser ("you can close this tab"), and closes.
//!   4. Resolves with `{code, state}` so the frontend can finish
//!      the PKCE exchange (token endpoint POST) itself.
//!
//! `cancel_oauth_callback` exists as an escape hatch when the user
//! gives up: it drops the listener so the port frees up immediately
//! and a future attempt won't fail with "Address already in use".

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
/// Path component the OAuth flow sends the browser to. Same caveat:
/// matches the registered redirect URI exactly.
const CALLBACK_PATH: &str = "/api/hf-auth/oauth/callback";
/// Hard wall on how long we'll keep the listener alive waiting for
/// the user to complete the browser flow. Anything longer almost
/// certainly means the user closed the tab; surface an error so we
/// can release the port instead of hogging it forever.
const FLOW_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum OAuthError {
    #[error("oauth callback already in flight")]
    AlreadyRunning,
    #[error("could not bind {addr}: {detail}")]
    Bind { addr: String, detail: String },
    #[error("oauth flow timed out")]
    Timeout,
    #[error("oauth flow cancelled")]
    Cancelled,
    #[error("oauth provider returned error: {error} (description: {description:?})")]
    Provider {
        error: String,
        description: Option<String>,
    },
    #[error("oauth callback missing 'code' parameter")]
    MissingCode,
    #[error("oauth callback state mismatch: expected {expected:?}, got {got:?}")]
    StateMismatch {
        expected: Option<String>,
        got: Option<String>,
    },
    #[error("internal error: {0}")]
    Internal(String),
}

/// Result handed back to the frontend when the loopback flow
/// resolves successfully. `state` is opaque to us (we only verify
/// it matches what the caller passed, never interpret it).
#[derive(Debug, Serialize)]
pub struct OAuthCallback {
    pub code: String,
    pub state: Option<String>,
}

/// Single in-flight slot. `Some(_)` means a listener task is alive
/// somewhere and holding port 8000; subsequent calls bail with
/// `AlreadyRunning` rather than racing two binds.
static IN_FLIGHT: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

/// Returns one of:
///   - the captured callback parameters,
///   - `Cancelled` if `cancel_oauth_callback` was invoked,
///   - `Timeout` if the user never finishes the browser flow.
#[tauri::command]
pub async fn start_oauth_callback(
    expected_state: Option<String>,
) -> Result<OAuthCallback, OAuthError> {
    // Reserve the slot first. If we cannot, fail fast: trying to
    // bind on a busy port would block until the previous listener
    // drops, which obscures the real "user spammed Sign in" cause.
    let cancel_tx = {
        let mut slot = IN_FLIGHT.lock().map_err(|e| OAuthError::Internal(e.to_string()))?;
        if slot.is_some() {
            return Err(OAuthError::AlreadyRunning);
        }
        let (tx, rx) = oneshot::channel::<()>();
        *slot = Some(tx);
        rx
    };

    // From this point on we MUST clear the slot before returning,
    // success or not, so a follow-up `start_oauth_callback` works.
    let result = run_listener(expected_state, cancel_tx).await;

    {
        let mut slot = IN_FLIGHT.lock().map_err(|e| OAuthError::Internal(e.to_string()))?;
        *slot = None;
    }

    result
}

#[tauri::command]
pub fn cancel_oauth_callback() -> Result<(), OAuthError> {
    let mut slot = IN_FLIGHT
        .lock()
        .map_err(|e| OAuthError::Internal(e.to_string()))?;
    // Dropping the sender closes the oneshot; the listener task's
    // select! arm wakes up on the closed-channel signal and exits
    // with `Cancelled`. We don't care if the receiver was already
    // dropped (race with success) — that just means there's nothing
    // to cancel any more.
    *slot = None;
    Ok(())
}

async fn run_listener(
    expected_state: Option<String>,
    mut cancel_rx: oneshot::Receiver<()>,
) -> Result<OAuthCallback, OAuthError> {
    let addr = format!("127.0.0.1:{LOOPBACK_PORT}");
    let listener = TcpListener::bind(&addr).await.map_err(|e| OAuthError::Bind {
        addr: addr.clone(),
        detail: e.to_string(),
    })?;

    tracing::info!(target: "oauth", "loopback bound on {addr}, waiting for browser callback");

    // We accept multiple connections in case the browser hits
    // favicon.ico or DevTools probes the page before the real
    // callback lands. We only return for a request that targets
    // CALLBACK_PATH; everything else gets a 404 and we keep going.
    let captured = loop {
        tokio::select! {
            _ = (&mut cancel_rx) => {
                tracing::info!(target: "oauth", "loopback cancelled by app");
                return Err(OAuthError::Cancelled);
            }
            res = timeout(FLOW_TIMEOUT, listener.accept()) => {
                let accepted = match res {
                    Err(_) => return Err(OAuthError::Timeout),
                    Ok(Ok(c)) => c,
                    Ok(Err(e)) => return Err(OAuthError::Internal(format!(
                        "accept failed: {e}"
                    ))),
                };
                let (mut socket, _peer) = accepted;
                let request_line = match read_request_line(&mut socket).await {
                    Ok(line) => line,
                    Err(e) => {
                        tracing::warn!(
                            target: "oauth",
                            "drop loopback conn: {e}"
                        );
                        let _ = socket.shutdown().await;
                        continue;
                    }
                };

                let url_target = parse_request_target(&request_line);
                if !url_target
                    .as_deref()
                    .map(|t| t.starts_with(CALLBACK_PATH))
                    .unwrap_or(false)
                {
                    let _ = write_response(&mut socket, 404, "Not Found", "Not the OAuth callback path.").await;
                    continue;
                }

                let target = url_target.unwrap();
                let params = parse_query(&target);

                if let Some(err) = params.iter().find(|(k, _)| k == "error") {
                    let description = params
                        .iter()
                        .find(|(k, _)| k == "error_description")
                        .map(|(_, v)| v.clone());
                    let _ = write_response(
                        &mut socket,
                        400,
                        "Bad Request",
                        "Sign-in failed. You can close this tab and try again.",
                    )
                    .await;
                    return Err(OAuthError::Provider {
                        error: err.1.clone(),
                        description,
                    });
                }

                let code = params
                    .iter()
                    .find(|(k, _)| k == "code")
                    .map(|(_, v)| v.clone());
                let state = params
                    .iter()
                    .find(|(k, _)| k == "state")
                    .map(|(_, v)| v.clone());

                if let Some(expected) = expected_state.as_ref() {
                    if state.as_deref() != Some(expected.as_str()) {
                        let _ = write_response(
                            &mut socket,
                            400,
                            "Bad Request",
                            "Invalid OAuth state. You can close this tab.",
                        )
                        .await;
                        return Err(OAuthError::StateMismatch {
                            expected: Some(expected.clone()),
                            got: state,
                        });
                    }
                }

                let code = match code {
                    Some(c) => c,
                    None => {
                        let _ = write_response(
                            &mut socket,
                            400,
                            "Bad Request",
                            "Missing 'code' in OAuth callback.",
                        )
                        .await;
                        return Err(OAuthError::MissingCode);
                    }
                };

                let _ = write_response(
                    &mut socket,
                    200,
                    "OK",
                    "Sign-in complete. You can close this tab and return to Reachy Mini.",
                )
                .await;
                let _ = socket.shutdown().await;
                break OAuthCallback { code, state };
            }
        }
    };

    Ok(captured)
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

fn parse_query(target: &str) -> Vec<(String, String)> {
    let q = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    q.split('&')
        .filter_map(|kv| {
            let (k, v) = kv.split_once('=')?;
            Some((url_decode(k), url_decode(v)))
        })
        .collect()
}

fn url_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push(((h * 16 + l) as u8) as char);
                    i += 3;
                } else {
                    out.push(bytes[i] as char);
                    i += 1;
                }
            }
            b => {
                out.push(b as char);
                i += 1;
            }
        }
    }
    out
}

async fn write_response(
    socket: &mut tokio::net::TcpStream,
    status: u16,
    reason: &str,
    body_text: &str,
) -> IoResult<()> {
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Reachy Mini sign-in</title>\
<style>body{{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:480px;margin:6rem auto;padding:2rem;text-align:center;color:#222}}h1{{font-size:1.25rem}}p{{color:#555;line-height:1.5}}</style></head>\
<body><h1>Reachy Mini</h1><p>{body_text}</p></body></html>"
    );
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
        len = body.len()
    );
    socket.write_all(response.as_bytes()).await
}
