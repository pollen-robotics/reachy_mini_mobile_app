/**
 * Terms-of-Service consent hook - the first-launch EULA gate
 * required by Apple guideline 5.1.1 (privacy / data collection
 * disclosure) and Google Play's UGC policy.
 *
 * What it tracks
 * ──────────────
 * Whether the user has accepted the **current** version of the
 * Terms of Service + Privacy Policy. The version number is part
 * of the contract: bumping `CURRENT_TOS_VERSION` invalidates the
 * stored acceptance and re-prompts every existing user the next
 * time they open the app. The store therefore persists not a
 * boolean but the integer version that was accepted.
 *
 *   Stored in localStorage  ->  parse to int  ->  compare to
 *   `CURRENT_TOS_VERSION`   ->  re-prompt if behind, otherwise
 *   silently let the app boot.
 *
 * Why a version number rather than a boolean
 * ──────────────────────────────────────────
 * Apple cares that the user has agreed to whatever the current
 * TOS says, not what an older revision said. Storing a boolean
 * locks us into "accepted forever, even if we change the deal";
 * storing the version cleanly handles material updates (new data
 * categories, OpenAI Realtime swap, etc.).
 *
 * Bump policy
 * ───────────
 * Bump `CURRENT_TOS_VERSION` only on **material** changes:
 * - new data category collected
 * - new third-party processor (e.g. swap of voice provider)
 * - new permission scope
 *
 * Cosmetic copy edits do NOT bump the version. Keep churn low so
 * we don't desensitise the user to the modal.
 */
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'reachy.consent.tosVersion';

/**
 * The TOS version users must currently agree to. v1 is the
 * baseline at first store submission. Subsequent bumps are part
 * of an explicit decision (see "Bump policy" in the file header).
 */
export const CURRENT_TOS_VERSION = 1 as const;

interface UseTosConsentReturn {
  /**
   * Whether the user has accepted the CURRENT version of the TOS.
   * Synchronously available at first render thanks to
   * `useState`'s lazy initializer reading localStorage on mount,
   * so the consumer can flip the modal on/off without a flash
   * during the first frame.
   */
  accepted: boolean;
  /** Mark the current TOS version as accepted. Persists. */
  accept: () => void;
  /**
   * Forget any previous acceptance. Used by a future "I want to
   * re-read the TOS" affordance in Settings. Not exposed in the
   * UI today; ships pre-wired so the future entry is one button.
   */
  reset: () => void;
}

function readStorage(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStorage(version: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(version));
  } catch {
    // localStorage may be unavailable (private mode on iOS, quota
    // exceeded). Silently fail; the in-memory state still
    // reflects acceptance for this session, so the user is not
    // re-prompted mid-session.
  }
}

export function useTosConsent(): UseTosConsentReturn {
  // Lazy initial state so we hit localStorage exactly once on
  // mount, not on every render. The hook itself is cheap and
  // mounted at the App root, so this matters less than for a
  // hot-path hook, but we keep the pattern consistent with the
  // siblings (`usePinnedApps`, `useHiddenAuthors`).
  const [acceptedVersion, setAcceptedVersion] = useState<number | null>(() =>
    readStorage(),
  );

  // Cross-tab / cross-WebView sync: if the user accepted in one
  // surface (e.g. the splash modal) and another tab is open
  // somehow, we don't want the modal to keep nagging.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setAcceptedVersion(readStorage());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const accept = useCallback((): void => {
    writeStorage(CURRENT_TOS_VERSION);
    setAcceptedVersion(CURRENT_TOS_VERSION);
  }, []);

  const reset = useCallback((): void => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // best-effort
    }
    setAcceptedVersion(null);
  }, []);

  const accepted: boolean =
    acceptedVersion !== null && acceptedVersion >= CURRENT_TOS_VERSION;

  return {
    accepted,
    accept,
    reset,
  };
}
