/**
 * The accessory on the NFC reader, for the conversation panel's badge.
 *
 * Fed by the session screen's `useNfcReader` and matched against the
 * personality catalog the phone holds for this robot.
 */
import { useEffect, useMemo, useState } from 'react';

import { usePersonalitiesCatalog } from '@/features/personalities';

import { describeAccessory, settleTag, type AccessoryView } from './accessory';
import type { NfcState, NfcTag } from './nfcState';

/** Bundled ids (`builtin:noir_detective`) until the robot's catalog replaces them. */
const BUNDLED_PREFIX = 'builtin:';

function robotName(id: string): string {
  return id.startsWith(BUNDLED_PREFIX) ? id.slice(BUNDLED_PREFIX.length) : id;
}

export interface AccessoryBadgeView extends AccessoryView {
  /** Display name of the personality a `known` accessory names. */
  personalityName: string | null;
}

export function useAccessory(readerState: NfcState, tag: NfcTag | null): AccessoryBadgeView {
  const catalog = usePersonalitiesCatalog();
  const [settled, setSettled] = useState<NfcTag | null>(null);
  useEffect(() => {
    setSettled(previous => settleTag(tag, previous));
  }, [tag]);

  return useMemo(() => {
    const names = new Map(catalog.map(p => [robotName(p.id), p.name]));
    const view = describeAccessory(readerState, settled, new Set(names.keys()));
    return {
      ...view,
      personalityName: view.personality ? (names.get(view.personality) ?? null) : null,
    };
  }, [catalog, readerState, settled]);
}

/** Robot name of a catalog id, to compare with an accessory's personality. */
export { robotName as accessoryPersonalityId };
