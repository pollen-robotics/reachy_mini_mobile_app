import { useEffect } from 'react';

import {
  acquireKeepScreenOn,
  releaseKeepScreenOn,
} from './keepScreenOn';

/**
 * Declarative keep-screen-on binding.
 *
 * Holds a refcount claim on the global keep-screen-on lock for as
 * long as `active` is true. The cleanup function releases the
 * claim on unmount or when `active` flips back to false, so the
 * system idle timer resumes its default behaviour without any
 * imperative bookkeeping at the call site.
 *
 * Usage:
 *
 *   const isConversing = ...;
 *   const isAppOpen = ...;
 *   useKeepScreenOn(isConversing || isAppOpen);
 *
 * Multiple subtrees can call this in parallel - the wrapper is
 * refcounted, so the screen only dims again once every consumer
 * has released its hold.
 */
export function useKeepScreenOn(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    void acquireKeepScreenOn();
    return () => {
      void releaseKeepScreenOn();
    };
  }, [active]);
}
