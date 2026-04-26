//! Tauri commands exposed to the frontend.
//!
//! Two commands only:
//!
//! * [`daemon_fetch`] - HTTP round-trip to the robot daemon via `reqwest`,
//!   so the WebView never has to speak `http://` itself (which would be
//!   blocked by the mixed-content policy on iOS/Android).
//! * [`local_ips`] - IPv4 addresses of the device, used to tell whether the
//!   phone is on the same subnet as the robot we just connected to over BLE.
//!
//! Everything BLE-related is handled on the TS side via
//! `tauri-plugin-blec`. See `src/ble/useBleSession.ts`.

use std::collections::HashMap;
use std::time::Duration;

use local_ip_address::list_afinet_netifas;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// JSON-serializable error surfaced to the frontend.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum CommandError {
    #[error("invalid HTTP method: {0}")]
    InvalidMethod(String),
    #[error("request failed: {0}")]
    Request(String),
    #[error("response body read failed: {0}")]
    Body(String),
    #[error("network enumeration failed: {0}")]
    Network(String),
}

/// Payload sent by the frontend when proxying a daemon call.
#[derive(Debug, Deserialize)]
pub struct DaemonRequest {
    /// Bare host or `host:port` (no scheme). The daemon always listens on
    /// HTTP so we hard-code the protocol and default port.
    pub host: String,
    /// Path starting with `/`, e.g. `/api/daemon/status`.
    pub path: String,
    /// Uppercase verb. Defaults to `GET` if omitted.
    #[serde(default)]
    pub method: Option<String>,
    /// Optional JSON body (stringified on the frontend side).
    #[serde(default)]
    pub body: Option<String>,
    /// Optional extra headers.
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    /// Per-request timeout in milliseconds. Defaults to 5000.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// Structured response. We do NOT try to parse JSON here - the frontend
/// owns the schema knowledge and can handle both OK and error responses.
#[derive(Debug, Serialize)]
pub struct DaemonResponse {
    pub status: u16,
    pub ok: bool,
    pub body: String,
}

const DEFAULT_DAEMON_PORT: u16 = 8000;
const DEFAULT_TIMEOUT_MS: u64 = 5000;

/// Proxy an HTTP request to the robot daemon.
///
/// Mobile WebViews refuse plain-HTTP calls from our HTTPS-origin frontend
/// (mixed content). Going through `reqwest` on the Rust side both fixes
/// that and gives us a natural place to enforce per-request timeouts.
#[tauri::command]
pub async fn daemon_fetch(req: DaemonRequest) -> Result<DaemonResponse, CommandError> {
    let method = req
        .method
        .as_deref()
        .unwrap_or("GET")
        .parse::<Method>()
        .map_err(|e| CommandError::InvalidMethod(e.to_string()))?;

    // Accept `host`, `host:port`, or a stray scheme prefix. Fall back to 8000.
    let host = req
        .host
        .trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    let url = if host.contains(':') {
        format!("http://{}{}", host, req.path)
    } else {
        format!("http://{}:{}{}", host, DEFAULT_DAEMON_PORT, req.path)
    };

    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| CommandError::Request(e.to_string()))?;

    let mut builder = client.request(method, &url);

    if let Some(headers) = req.headers {
        for (k, v) in headers {
            builder = builder.header(k, v);
        }
    }

    if let Some(body) = req.body {
        builder = builder
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body);
    }

    let response = builder
        .send()
        .await
        .map_err(|e| CommandError::Request(e.to_string()))?;

    let status = response.status().as_u16();
    let ok = response.status().is_success();
    let body = response
        .text()
        .await
        .map_err(|e| CommandError::Body(e.to_string()))?;

    Ok(DaemonResponse { status, ok, body })
}

/// Local IPv4 addresses, keyed by interface name.
///
/// Useful for two things on the frontend:
///   1. Tell whether the device is on the same `/24` as the robot IP we
///      just read over BLE, so we can skip a "join this WiFi" prompt.
///   2. Display a debug banner in the dashboard screen.
///
/// We deliberately filter to IPv4: the daemon advertises IPv4 addresses in
/// its BLE `NETWORK_STATUS` characteristic, and the subnet comparison is
/// trivial on /24 while it would require CIDR math for IPv6.
#[tauri::command]
pub fn local_ips() -> Result<Vec<LocalInterface>, CommandError> {
    let raw = list_afinet_netifas().map_err(|e| CommandError::Network(e.to_string()))?;
    Ok(raw
        .into_iter()
        .filter_map(|(name, addr)| match addr {
            std::net::IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_unspecified() => {
                Some(LocalInterface {
                    name,
                    ip: v4.to_string(),
                })
            }
            _ => None,
        })
        .collect())
}

#[derive(Debug, Serialize)]
pub struct LocalInterface {
    pub name: String,
    pub ip: String,
}
