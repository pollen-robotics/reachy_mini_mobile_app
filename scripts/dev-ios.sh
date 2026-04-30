#!/usr/bin/env bash
# Wrap `tauri ios dev` with a sensible default flow:
#   - auto-detect the Mac's current LAN IPv4 so the iPhone can reach
#     the Vite dev server (Tauri's `--host` value),
#   - let Tauri pick the only connected device automatically,
#   - tee stdout to /tmp/tauri-ios-dev.log so JS logs forwarded by
#     `tauri-plugin-log` survive between sessions for grep/tail.
#
# Usage:
#   yarn ios:dev                # auto IP, auto device
#   yarn ios:dev --host 1.2.3.4 # override (extra args pass through)
set -euo pipefail

LOG_FILE="${TAURI_IOS_DEV_LOG:-/tmp/tauri-ios-dev.log}"

detect_lan_ip() {
  for iface in en0 en1 en2 en3 en4; do
    ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
    [ -n "$ip" ] && echo "$ip" && return 0
  done
  return 1
}

# Don't override an explicit --host already passed by the caller.
extra_args=("$@")
has_host=0
for a in "${extra_args[@]:-}"; do
  case "$a" in --host|--host=*) has_host=1; break ;; esac
done

if [ "$has_host" -eq 0 ]; then
  if ip="$(detect_lan_ip)"; then
    extra_args+=(--host "$ip")
    echo "[dev-ios] LAN IP: $ip"
  else
    echo "[dev-ios] no LAN IPv4 detected, falling back to Tauri's prompt"
    extra_args+=(--host)
  fi
fi

echo "[dev-ios] log file: $LOG_FILE"
exec yarn tauri ios dev "${extra_args[@]}" 2>&1 | tee "$LOG_FILE"
