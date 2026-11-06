/**
 * The accessory on the NFC reader, for the conversation panel's badge.
 *
 * Fed by the session screen's `useNfcReader` and matched against the
 * personality catalog the phone holds for this robot.
 */
import { useMemo, useState } from 'react';

import { toRobotPersonalityName, usePersonalitiesCatalog } from '@/features/personalities';

import { describeAccessory, settleTag, type AccessoryView } from './accessory';
import type { NfcState, NfcTag } from './nfcState';

export interface AccessoryBadgeView extends AccessoryView {
  /** Display name of the personality a `known` accessory names. */
  personalityName: string | null;
}

export function useAccessory(readerState: NfcState, tag: NfcTag | null): AccessoryBadgeView {
  const catalog = usePersonalitiesCatalog();
  const [lastTag, setLastTag] = useState(tag);
  const [settled, setSettled] = useState(() => settleTag(tag, null));
  if (tag !== lastTag) {
    setLastTag(tag);
    setSettled(settleTag(tag, settled));
  }

  return useMemo(() => {
    const names = new Map(catalog.map(p => [toRobotPersonalityName(p.id), p.name]));
    const view = describeAccessory(readerState, settled, new Set(names.keys()));
    return {
      ...view,
      personalityName: view.personality ? (names.get(view.personality) ?? null) : null,
    };
  }, [catalog, readerState, settled]);
}
