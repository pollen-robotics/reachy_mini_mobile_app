/**
 * Small shared hooks for the first-wake-up steps.
 *
 * Each hardware step (motor / speaker / camera / mic) shares the same
 * troubleshooting toggle plumbing (a local view that hides the shared viz).
 * Factoring it here keeps the steps focused on their own hardware logic.
 *
 * Nav-locking while an emote plays is a wizard-shell concern, not a step one:
 * the shell owns the emote lifecycle (see `useStepEmotes`) and derives the lock
 * from `playingStep` directly.
 */
import { useCallback, useState } from 'react';

interface TroubleshootControls {
  /** Whether the troubleshooting view is currently shown. */
  trouble: boolean;
  /** Open the troubleshooting view (hides the shared persistent viz). */
  openTrouble: () => void;
  /** Close it and go back to the step. */
  closeTrouble: () => void;
}

/**
 * Local troubleshooting toggle shared by every hardware step. Opening hides
 * the shared persistent viz (the trouble view owns the whole column); closing
 * restores it - except for steps that manage their own stage (the camera step
 * keeps it hidden), which pass `restoreStageOnClose: false`.
 */
export function useTroubleshoot(
  onStageVisible: (visible: boolean) => void,
  { restoreStageOnClose = true }: { restoreStageOnClose?: boolean } = {},
): TroubleshootControls {
  const [trouble, setTrouble] = useState(false);
  const openTrouble = useCallback(() => {
    setTrouble(true);
    onStageVisible(false);
  }, [onStageVisible]);
  const closeTrouble = useCallback(() => {
    setTrouble(false);
    onStageVisible(restoreStageOnClose);
  }, [onStageVisible, restoreStageOnClose]);
  return { trouble, openTrouble, closeTrouble };
}
