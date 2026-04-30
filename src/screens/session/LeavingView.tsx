/**
 * Granular teardown view.
 *
 * Replaces the previous featureless "Disconnecting…" spinner with a
 * minimal action checklist surfacing what the teardown runner is
 * doing right now. The sub-steps map 1:1 to the controller's
 * sequential `await`s:
 *
 *   1. Putting {robotName} to sleep   (waiting for goto_sleep)
 *   2. Closing connection             (engine endSession + DC close)
 *   3. Releasing Bluetooth            (LAN only; BLE GATT)
 *
 * Body chrome is intentionally pared down: no orb, no identity
 * block, no transport sub-line. The `SessionTopBar` already carries
 * the robot name + transport at the top of the screen, and the
 * first step's label ("Putting Bibi to sleep") is enough to
 * disambiguate which robot the user is leaving. Echoing
 * "via Hugging Face Central" / "via Wi-Fi · 192.168.1.42" inside
 * the body just added noise to a state that is purely "we're
 * winding down, here is the list of operations".
 *
 * The remaining spinner at the very top is kept tiny + muted: it's
 * a "we're alive, the screen isn't frozen" signal, nothing more.
 *
 * Composition contract
 * ────────────────────
 * Returns a fragment of *flat* children meant to be rendered inside
 * the same vertically-centred `<Stack>` as the running and failure
 * views. The parent (`RobotSessionScreen`) keeps that wrapper, so
 * cross-phase transitions (running → leaving → unmount) preserve
 * the column geometry without any visual jump.
 */
import { useMemo } from 'react';

import { CircularProgress } from '@mui/material';

import type { LeavingStep } from '../../session/useSessionController';

import { HandshakeStepList, type StepRow } from './HandshakeViews';

export function LeavingView({
  robotName,
  step,
  isLocal,
}: {
  robotName: string;
  step: LeavingStep;
  /** When false (remote target), the BLE-disconnect step is dropped
   *  - the runner skips it server-side, so listing it would hang
   *  on a row that never activates. */
  isLocal: boolean;
}) {
  // The visible sub-steps shown to the user. Mirrors the runner's
  // sequential `await`s exactly; `'pending'` and `'done'` are
  // controller-side bookkeeping states and don't get their own row.
  const visibleSteps = useMemo<
    readonly { id: LeavingStep; label: string }[]
  >(() => {
    const list: { id: LeavingStep; label: string }[] = [
      { id: 'putting-to-sleep', label: `Putting ${robotName} to sleep` },
      { id: 'closing-channel', label: 'Closing connection' },
    ];
    if (isLocal) {
      list.push({ id: 'releasing-bluetooth', label: 'Releasing Bluetooth' });
    }
    return list;
  }, [robotName, isLocal]);

  // Project the controller's `LeavingStep` onto the visible list so
  // we can hand a `StepRow[]` to the existing list renderer (same
  // visual idiom as the running / failure views).
  const stepRows = useMemo<readonly StepRow[]>(() => {
    const activeIndex =
      step === 'done'
        ? visibleSteps.length
        : step === 'pending'
          ? 0
          : Math.max(
              0,
              visibleSteps.findIndex((s) => s.id === step),
            );
    return visibleSteps.map((s, index): StepRow => {
      let status: StepRow['status'];
      if (index < activeIndex) status = 'completed';
      else if (index === activeIndex) status = 'active';
      else status = 'pending';
      return { label: s.label, detail: null, status };
    });
  }, [step, visibleSteps]);

  return (
    <>
      {/* Small grey spinner. We deliberately drop the running view's
          decorated orb here: teardown is a passive "wind-down", not
          a brand moment, and a 96 px ring with a pulse animation
          fights for attention against the per-step spinner that
          already lives inside the active row of the step list. A
          bare 18 px CircularProgress in `text.secondary` keeps the
          "things are happening" signal at the top of the column
          without the visual weight. */}
      <CircularProgress
        size={18}
        thickness={3.5}
        color="inherit"
        sx={{ color: 'text.secondary', opacity: 0.55 }}
      />
      <HandshakeStepList steps={stepRows} />
    </>
  );
}
