# iOS setup runbook

End-to-end procedure to get a real build of `reachy_mini_mobile_app`
running on a physical iPhone, starting from a blank macOS machine.

This is a one-time setup. After it's done, the day-to-day loop is just
`yarn ios:dev`.

> **Tip**: read this top-to-bottom once before doing anything. The
> ordering matters - several steps depend on previous ones being done.

---

## 0. Prerequisites checklist

- [ ] macOS with admin (sudo) rights
- [ ] An Apple ID (the free one is enough for sideloading on your own
      iPhone, valid 7 days; the paid Developer Program at $99/year is
      needed for TestFlight + 1-year provisioning)
- [ ] A USB-C or Lightning cable (the very first install must be wired,
      Wi-Fi debugging is enabled afterwards)
- [ ] Node 20+, Yarn, Rust 1.77+ already installed (this repo's `package.json`
      and `Cargo.toml` enforce the minimums)

Already verified on this machine (Tuesday April 28, 2026):

| Tool | Version | Status |
|---|---|---|
| Rust | 1.91 + iOS targets installed | OK |
| Tauri CLI | 2.10.1 | OK |
| Node | 24.11.1 | OK |
| Yarn | 1.22.22 | OK |
| CocoaPods | installed | OK |
| **Xcode** | **NOT INSTALLED** (only Command Line Tools) | **Blocker, see step 1** |

---

## 1. Install Xcode (one-time, ~30 min)

Tauri iOS needs the **full Xcode**, not just the Command Line Tools.

1. Open the Mac App Store, search "Xcode", click Install.
2. Wait for the ~10 GB download.
3. Launch Xcode once so it can finalise its first-launch setup, then
   close it.

Then run the bootstrap script (it switches `xcode-select`, accepts the
license, runs the first-launch installers, and runs `pod install`):

```bash
cd reachy_mini_mobile_app
./scripts/bootstrap-ios.sh
```

Sanity check that you have a working iOS SDK:

```bash
xcodebuild -version          # should print Xcode 16.x or newer
xcrun --sdk iphoneos --show-sdk-version
```

---

## 2. Sign in with your Apple ID in Xcode

Xcode signs builds with the certificate of an Apple ID stored in its
preferences.

1. Xcode -> Settings... -> Accounts -> `+` -> Apple ID
2. Sign in with your Apple ID (the free one is fine for now)
3. Close Settings

---

## 3. Configure signing for the target

Open the workspace:

```bash
open src-tauri/gen/apple/reachy_mini_mobile_app.xcodeproj
```

In Xcode's left sidebar, click the blue project icon at the top
(`reachy_mini_mobile_app`), then in the editor:

1. Select the target `reachy_mini_mobile_app_iOS`
2. Click the **Signing & Capabilities** tab
3. Tick **Automatically manage signing**
4. Pick your Team in the dropdown (your free Apple ID appears as
   `Personal Team`)
5. The default bundle identifier is `com.tfrere.reachymini.app`
   (configured in `tauri.conf.json` and propagated to the Xcode
   project). If you fork this repo and want your own identifier,
   change `identifier` in `tauri.conf.json` AND
   `PRODUCT_BUNDLE_IDENTIFIER` in `src-tauri/gen/apple/project.yml`
   AND in `src-tauri/gen/apple/reachy_mini_mobile_app.xcodeproj/project.pbxproj`
   (both `debug` and `release` configs).

Xcode should now show a green checkmark next to your Team. If it still
complains:

- "No profiles for ... were found" -> click "Try Again"; if that fails,
  uncheck and re-check "Automatically manage signing"
- "Personal Team has reached the maximum number of provisioning
  profiles" -> revoke unused ones in Xcode > Settings > Accounts >
  Manage Certificates

---

## 4. Pair your iPhone (USB only, one-time)

1. Connect the iPhone with a USB cable
2. On the phone: tap **Trust This Computer**, enter passcode
3. On the phone: **Settings -> Privacy & Security -> Developer Mode -> ON**
4. The phone reboots; after re-unlocking, confirm the prompt

The first pairing must be wired; afterwards Wi-Fi debugging is fine
(see step 7).

---

## 5. First build & install (USB)

From the project root:

```bash
yarn tauri ios dev --open
```

What this does:

1. Starts Vite (`yarn dev`) on `http://localhost:1420`
2. Cross-compiles the Rust crate for `aarch64-apple-ios`
3. Builds the Xcode project and installs it on the connected device
4. Streams `RUST_LOG=info` logs back to the terminal

If it works: you should see the Reachy Mini icon on your iPhone within
a couple of minutes.

If it doesn't (likely scenarios are listed in the **Troubleshooting**
section below).

---

## 6. After install: trust the developer profile (free Apple ID only)

The first time the app launches, iOS shows
"Untrusted Enterprise Developer". On the phone:

**Settings -> General -> VPN & Device Management -> Apple Development:
your-apple-id@example.com -> Trust**

After that the app launches normally. With a free Apple ID, the
provisioning profile expires after **7 days**: re-run `yarn tauri ios dev`
to re-sign and re-install.

---

## 7. Wi-Fi debugging (cable-free dev loop)

Once the iPhone is paired and the app is installed once:

1. Keep the iPhone on the **same Wi-Fi** as the Mac
2. Xcode -> Window -> Devices and Simulators -> select your iPhone ->
   tick **Connect via network**
3. The cable is no longer needed for subsequent `yarn tauri ios dev` runs

Wi-Fi debugging is slower than USB by 10-30s per install but otherwise
identical.

---

## 8. Day-to-day commands

```bash
yarn ios:dev      # tauri ios dev --open  (debug build, hot reload via Vite)
yarn ios:build    # tauri ios build       (release archive)
```

To rebuild only the Rust side without going through Xcode (faster
iteration on Rust commands):

```bash
cargo build --target aarch64-apple-ios --manifest-path src-tauri/Cargo.toml
```

---

## Troubleshooting

### Rust cross-compile errors for `btleplug-patch`

The `[patch.crates-io]` in `src-tauri/Cargo.toml` swaps `btleplug` for a
local copy in `btleplug-patch/`. iOS support in upstream btleplug uses
`CoreBluetooth`, so it should compile.

If you see linker errors mentioning `IOBluetooth` or `CBCentralManager`,
make sure `Info.plist` already has both `NSBluetoothAlwaysUsageDescription`
and `NSBluetoothPeripheralUsageDescription` (it does, in this repo).

If a specific symbol is missing for `aarch64-apple-ios`, the patch may
need to feature-gate the offending code with `#[cfg(not(target_os = "ios"))]`.
Open the file printed in the linker error and gate accordingly.

### "Module 'TauriPlugins' not found" or similar Pod error

```bash
cd src-tauri/gen/apple
pod deintegrate
pod install
```

Then rebuild from Xcode (Product > Clean Build Folder, then Run).

### Microphone never prompts for permission

`Info.plist` already declares `NSMicrophoneUsageDescription`. If the
prompt still doesn't appear:

- Confirm the iframe `<iframe>` element has `allow="microphone"` (it
  must include both `microphone` and `camera` if camera ever lands)
- WKWebView only grants `getUserMedia` over `https://` origins. The
  Tauri host page is `tauri.localhost`, which is allowed by iOS, but
  the iframe inside it must also be HTTPS (the HF Space `*.hf.space`
  is, so this is fine in production)

### Local Network prompt never appears

Add the Bonjour services your code actually browses to `Info.plist`
under `NSBonjourServices`. Today the app does **no mDNS** (BLE-first
discovery, then WebRTC), so this should not trigger.

### "ld: framework 'XXX' not found" during Xcode link

Likely a stale `gen/apple/`. Regenerate it:

```bash
rm -rf src-tauri/gen/apple
yarn tauri ios init
# then re-apply our manual tweaks (see "Re-init checklist" below)
```

### Re-init checklist

If you ever have to re-run `yarn tauri ios init`, verify these stay
correct after regeneration:

- `Info.plist` contains the four privacy keys:
  `NSBluetoothAlwaysUsageDescription`,
  `NSBluetoothPeripheralUsageDescription`,
  `NSLocalNetworkUsageDescription`,
  `NSMicrophoneUsageDescription`,
  plus `NSAppTransportSecurity > NSAllowsLocalNetworking = true`
- `project.yml` has `deploymentTarget.iOS: 14.0` (BLE plugin minimum)
- `tauri.conf.json` `app.security.csp` still contains
  `frame-src https://*.hf.space` and `media-src 'self' blob: mediastream:`

---

## TestFlight (later, optional)

When you want to share the app with someone who isn't standing next to
your Mac:

1. Enrol in the **Apple Developer Program** ($99/year,
   <https://developer.apple.com/programs/>). The enrolment review takes
   anywhere from a few hours to a few days.
2. In App Store Connect, create a new app with the same Bundle ID as in
   step 3 above.
3. Switch your team in Xcode to the paid Developer team (vs Personal Team).
4. `yarn tauri ios build` then in Xcode: Product > Archive
5. Distribute via App Store Connect -> TestFlight; invite your testers
   by email.

Until TestFlight is set up, distribution is limited to devices physically
plugged into your Mac.
