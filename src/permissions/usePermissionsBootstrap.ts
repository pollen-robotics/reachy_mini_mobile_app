/**
 * Tracks whether the up-front permissions onboarding has been shown
 * (and presumably accepted) on this device.
 *
 * The flag is purposefully bumped only on the **screen completion**,
 * not on the actual permission grant: iOS gives us no reliable way to
 * recheck a `getUserMedia` decision without re-prompting, so once the
 * user has seen the explainer and tapped "Continue" we trust their
 * choice forever (they can flip permissions back on in iOS Settings ->
 * Reachy Mini if they ever change their mind).
 *
 * Rationale for the version suffix: bumping it is the migration knob
 * if we later need to reshow the onboarding (e.g. we add a new
 * permission, or restate why we need the mic).
 */
import { useCallback, useEffect, useState } from 'react';

// v2: bump from v1 to force-reshow the screen on devices that had
// already accepted the v1 cascade. iOS WKWebView persists localStorage
// across `xcrun devicectl device install`, so a fresh debug install
// alone wouldn't have re-prompted the user for the LAN-candidate
// unlock; the bump is the canonical invalidation knob.
const STORAGE_KEY = 'reachy.permissions.bootstrapped.v2';

function readFlag(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeFlag(value: boolean): void {
  try {
    if (value) {
      localStorage.setItem(STORAGE_KEY, '1');
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* noop - localStorage may be unavailable in some WKWebView edge cases */
  }
}

export interface PermissionsBootstrapState {
  bootstrapped: boolean;
  markBootstrapped: () => void;
  /** Test/debug helper - clears the flag so the screen reshows. */
  reset: () => void;
}

export function usePermissionsBootstrap(): PermissionsBootstrapState {
  const [bootstrapped, setBootstrapped] = useState<boolean>(() => readFlag());

  // Cheap belt-and-braces: the App component might mount before
  // localStorage is fully ready in some Tauri/WKWebView edge cases.
  // A second read on mount keeps us honest without forcing a render
  // delay on the steady state.
  useEffect(() => {
    const fresh = readFlag();
    if (fresh !== bootstrapped) {
      setBootstrapped(fresh);
    }
  }, [bootstrapped]);

  const markBootstrapped = useCallback(() => {
    writeFlag(true);
    setBootstrapped(true);
  }, []);

  const reset = useCallback(() => {
    writeFlag(false);
    setBootstrapped(false);
  }, []);

  return { bootstrapped, markBootstrapped, reset };
}
