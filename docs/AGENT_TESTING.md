# Testing the app on a phone and a robot (for agents and contributors)

How an agent can test this app end to end on a real Android phone against a
real Reachy Mini:
- build a release APK and install it;
- drive the app over Chrome DevTools;
- check every step against the robot's own state.

Everything here was used to test the robot-apps feature
(`docs/ROBOT_APPS.md`) on a Fairphone 4 and a Poco M3.

The robot side (putting a daemon branch on the robot, reading its logs and
REST state) is in the daemon repo:
[`reachy_mini/docs/AGENT_TESTING.md`](https://github.com/pollen-robotics/reachy_mini/blob/main/docs/AGENT_TESTING.md).

Tools: `scripts/agent-testing/` (`pip install websocket-client`).

## 0. What only a human can do

Ask the user, and wait, for:
- **USB debugging:** accepting the "Allow USB debugging?" prompt on the
  phone. Until then `adb devices` shows `unauthorized`.
- **Unlocking the phone:** the lock screen. Never enter a PIN.
- **Consent screen:** "Accept and continue" (it's a terms acceptance).
- **Hugging Face sign-in:** in the app, and for the robot, the device-code
  approval (see the daemon guide).
- **Android permission prompts:** microphone on first connect. These are
  native dialogs: DevTools can't see or tap them. `adb exec-out screencap`
  can see them.
- **Keeping the screen on:** *Developer options → Stay awake*, a phone
  setting.

## 1. Phone setup

```bash
adb devices -l                     # "device", not "unauthorized"
export ADB_SERIAL=<serial>         # when several devices are attached
```

Some ROMs (MIUI) block `adb shell input tap/text`
(`INJECT_EVENTS`). The tools here tap through CDP touch events instead, so
it doesn't matter.

`adb shell am start` / `am force-stop` and `input keyevent KEYCODE_WAKEUP`
still work everywhere.

## 2. Build and install

```bash
scripts/agent-testing/android-setup.sh   # regenerates + patches src-tauri/gen/android, like CI
yarn tauri android build --apk --target aarch64
git checkout -- src-tauri/icons          # the setup resaves icons as RGBA
APK=src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
$ANDROID_HOME/build-tools/<version>/apksigner sign --ks ~/.android/debug.keystore \
  --ks-pass pass:android --key-pass pass:android --ks-key-alias androiddebugkey --out /tmp/app.apk "$APK"
adb install -r /tmp/app.apk               # -r keeps the sign-in
adb shell am start -n com.pollen_robotics.reachy_mini/.MainActivity
```

Test on a **release** build. A `tauri android dev` build's main thread is
busy enough to distort audio and timing.

Install problems:
- **`INSTALL_FAILED_VERSION_DOWNGRADE`:** the phone has a higher version.
  `-r -d` doesn't help for release builds. Uninstall first; that wipes the
  sign-in, so the user signs in again.
- **Sign-in hangs on "Waiting for Hugging Face…":** the Play Store build
  (`com.pollenrobotics.reachymini`) is also installed and claims
  `reachymini://`. `adb shell pm query-activities -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d reachymini://x`
  lists both. The user picks this build in the chooser, or disables the
  Play one.

## 3. Driving the app

```bash
source scripts/agent-testing/helpers.sh   # T, wake, rtt, sheet, sheet_buttons, panel, dialog, slot, installed, lock, wait_idle
T text                                    # what's on screen
T tap reachy_mini                         # tap by exact text or CSS selector
T tap 'button[aria-label="Start Wake Me Up"]'
T rpc "r.rpcCall('apps.status')"          # JSON-RPC on the live session
T logs 50                                 # console history
T redial                                  # simulate an SDK re-dial
T dcmon install; sleep 30; T dcmon read   # data-channel gaps > 1 s
```

Gotchas:
- **Screen off, nothing works.** When the screen dozes, the WebView stops
  laying out and taking input. Taps then miss, and elements report a zero
  size. Run `wake` between steps. If `adb shell dumpsys window | grep isKeyguardShowing`
  says true, ask the user to unlock.
- **The soft keyboard eats the next tap.** After typing, run
  `T eval "document.activeElement.blur()"` before tapping elsewhere.
- **Several SDK instances.** After an auto-reconnect the page holds more
  than one `ReachyMini` instance, and the old one has a closed data
  channel. `cdp.py rpc/redial/dcmon` pick the open one. Your own CDP code
  must do the same (`Runtime.queryObjects` on `ReachyMini.prototype`).
- **The console is lost on reload.** Grab `T logs` before restarting the
  app. Android's own log keeps what the WebView doesn't:
  - `adb logcat -d -v time | grep -E "has died|Force stopping|Recents"`
    shows app kills, including a user swiping the app away;
  - `adb shell dumpsys wifi` shows Wi-Fi drops and roams.
- **Screenshots:** `T shot out.png` is the WebView only.
  `adb exec-out screencap -p > out.png` is the real screen, including
  system dialogs.

## 4. Checking against the robot

Never trust the UI alone: after each step, read the robot's state.

```bash
slot        # running app: (name, state, error) or None
installed   # installed apps
lock        # who holds the robot (remote_session / local_app / free)
```

On the robot, also follow `journalctl -u reachy-mini-daemon -f` (see the
daemon guide). Before correlating, convert the clocks: the phone runs in
its own timezone, the robot's journal in the robot's.

## 5. Robot apps test matrix

Each step is driven from the phone and checked against the robot. Use a
small Python app (e.g. `cdeplanne/wake_me_up`), and keep the robot's volume
at 0.

| # | Scenario | Pass when |
|---|---|---|
| A | Connect, open Apps | RTT shown; "On your robot" lists `installed` minus the conversation app |
| B | Uninstall from the sheet | Confirmation dialog; sheet flips to "Install on Reachy"; `installed` drops it |
| C | Install from the "On Reachy" store | Live progress in the sheet; "Installed"; the tile flips Get → Open |
| D | Start, restart, stop | `slot` follows (running → running → None); RTT stays; no idle sleep after stop |
| E | Start another app while one runs | Dialog names both apps; `slot` switches |
| F | Talk tab while an app runs, then back to Apps | "Reachy is busy with X"; no `Stopping app` in the journal; app still running |
| G | `pkill -9` the app on the robot | Panel and sheet show "Crashed" with the exit code first; "Start again" works |
| H | Update (via `T rpc`): `check_update` → `update` ×2 at once → `start` during → wait | One job (second call: `started: false`, same `job_id`); `start` → `busy`; journal: 1 stop, 1 reinstall, 0 failed |
| I | Start a REST update, then tap Update on the phone | "Reachy is already installing or removing an app" |
| J | `am force-stop` the app while a robot app runs, wait 30 s, reconnect | App kept running; the panel shows it running; Stop works |
| K | `T redial` with a sheet open | "Reconnecting to Reachy…", actions disabled, a tap reaches nothing; all back after |
| L | Remove the package on the robot while the app runs, re-enter Apps | Row and sheet show it running with Stop / Restart, no Install; after Stop, Install |

Notes:
- **L needs a list refresh.** The phone re-reads the installed list only
  when the Apps tab opens, after its own jobs, and on reconnect, so switch
  tabs after a change made outside the app. The robot commands for G and L
  are in the daemon guide.
- **Watch for Wi-Fi blips.** A step that fails with "data channel not open"
  or an empty REST reply usually hit one. Check the journal for a re-dial
  before calling it a bug.

## 6. Reporting

Paste the matrix with results into the PR (see `docs/CONTRIBUTING.md`).
Add the device, the build (commit), the robot's daemon commit
(`direct_url.json`), and the journal lines behind any failure.
