# Shell helpers for on-device tests of the Reachy Mini app.
# Usage: source scripts/agent-testing/helpers.sh
#
# Env: ADB_SERIAL (phone), REACHY_HOST (default reachy-mini.local), plus
# what cdp.py reads. Robot probes use the daemon's REST API, LAN only.

_AT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REACHY_HOST="${REACHY_HOST:-reachy-mini.local}"
R="http://$REACHY_HOST:8000"

# CDP driver with a timeout, so a dozing WebView can't hang a test.
T() { timeout 20 python3 "$_AT_DIR/cdp.py" "$@"; }

# Keep the phone awake between steps (a dozing screen freezes the WebView;
# the lock screen itself needs a human).
wake() { adb ${ADB_SERIAL:+-s "$ADB_SERIAL"} shell input keyevent KEYCODE_WAKEUP; }

# --- what the app shows ---------------------------------------------------
# RTT chip in the top bar ("5 ms"); missing or "0 ms" while (re)connecting.
rtt() { T eval "document.body.innerText.match(/\d+ ms/)?.[0] ?? 'NO RTT'"; }
# Text of the open bottom sheet (robot app sheet), or "(no sheet)".
sheet() { T eval "(()=>{const d=document.querySelector('.MuiDrawer-paper'); return d? d.innerText.replace(/\n+/g,' | ').slice(0,${1:-240}):'(no sheet)'})()"; }
# Buttons of the open sheet, "[off]" when disabled.
sheet_buttons() { T eval "[...document.querySelectorAll('.MuiDrawer-paper button')].map(b=>b.innerText+(b.disabled?'[off]':'')).join(', ')"; }
# The launcher's "On your robot" panel.
panel() { T eval "(()=>{const h=[...document.querySelectorAll('p')].find(p=>p.innerText==='On your robot'); return h? h.parentElement.parentElement.innerText.replace(/\n+/g,' | '):'none'})()"; }
# Text of an open confirmation dialog.
dialog() { T eval "(()=>{const d=document.querySelector('.MuiDialog-paper'); return d? d.innerText.replace(/\n+/g,' | '):'no dialog'})()"; }
close_sheet() { T tap ".MuiBackdrop-root" >/dev/null 2>&1; sleep 1; }

# --- what the robot says --------------------------------------------------
# Running app as (name, state, error head), or None.
slot() { curl -s -m 5 "$R/api/apps/current-app-status" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d and (d["info"]["name"], d["state"], (d["error"] or "")[:60]))'; }
installed() { curl -s -m 10 "$R/api/apps/list-available/installed" | python3 -c "import json,sys; print([a['name'] for a in json.load(sys.stdin)])"; }
lock() { curl -s -m 5 "$R/api/daemon/robot-app-lock-status"; echo; }
# Wait until no app holds the slot (null, or a clean "done").
wait_idle() { for _ in $(seq 1 15); do curl -s -m 5 "$R/api/apps/current-app-status" | grep -qE '^null$|"state":"done"' && return 0; sleep 2; done; return 1; }
