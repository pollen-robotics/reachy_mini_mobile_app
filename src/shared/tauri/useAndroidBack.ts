import { useEffect, useRef } from 'react';

import { pushBackHandler, type BackHandler } from './androidBack';

/**
 * While `active`, the Android Back key calls `onBack` (typically: close
 * this sheet or dialog) instead of closing the app. See `androidBack.ts`.
 */
export function useAndroidBack(active: boolean, onBack: BackHandler): void {
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  });
  useEffect(() => {
    if (!active) return;
    return pushBackHandler(info => onBackRef.current(info));
  }, [active]);
}
