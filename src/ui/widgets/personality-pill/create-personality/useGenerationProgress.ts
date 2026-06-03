/**
 * Drives the faux progress shown on the "Generate" button while the model
 * authors a persona. The real call duration is unknown, so this is purely
 * indicative: phrases advance on a fixed cadence (holding on the last one,
 * never looping) and the sliver eases toward ~92% so the wait reads as
 * "moving" without ever claiming completion (completion unmounts the button).
 */
import { useEffect, useState } from 'react';

import { GEN_STEPS } from './constants';

export interface GenerationProgress {
  /** Index into `GEN_STEPS` for the current status phrase. */
  step: number;
  /** 0..0.92 fill for the button's top progress sliver. */
  progress: number;
}

export function useGenerationProgress(active: boolean): GenerationProgress {
  const [step, setStep] = useState(0);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!active) {
      setStep(0);
      setProgress(0);
      return;
    }
    setStep(0);
    setProgress(0);
    const start = performance.now();
    const STEP_MS = 2200;
    const EST_MS = GEN_STEPS.length * STEP_MS;
    const id = window.setInterval(() => {
      const elapsed = performance.now() - start;
      // Advance through the phrases, then HOLD on the last one - never loop
      // back (a loop would imply "still on step 1" forever).
      setStep(Math.min(Math.floor(elapsed / STEP_MS), GEN_STEPS.length - 1));
      setProgress(Math.min(0.92, (elapsed / EST_MS) * 0.92));
    }, 90);
    return () => window.clearInterval(id);
  }, [active]);

  return { step, progress };
}
