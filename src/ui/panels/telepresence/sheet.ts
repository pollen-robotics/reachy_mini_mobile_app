/**
 * Shared `<Drawer>` setup for the telepresence sheets (settings, emotions).
 *
 * Docked to the right edge of the landscape stage so the live video
 * keeps the left of the screen, and portalled INTO the stage: a drawer
 * left in `document.body` would render unrotated on a portrait phone.
 */
import type { DrawerProps } from '@mui/material';

import { RADIUS } from '@/ui/design/tokens';

import { STAGE_INSET, type StageContextValue } from './stage';

export function stageSheetProps({ container }: StageContextValue): Partial<DrawerProps> {
  return {
    anchor: 'right',
    container,
    // Above the full-screen telepresence layer (1250), below the
    // session transition covers (1300).
    sx: { zIndex: 1280 },
    slotProps: {
      paper: {
        sx: {
          width: 'min(400px, 60%)',
          borderTopLeftRadius: RADIUS.xxl,
          borderBottomLeftRadius: RADIUS.xxl,
          pt: `calc(${STAGE_INSET.top} + 16px)`,
          pb: `calc(${STAGE_INSET.bottom} + 16px)`,
          pl: 2.5,
          pr: `calc(${STAGE_INSET.right} + 20px)`,
        },
      },
      // Keep the live video readable beside the sheet.
      backdrop: { sx: { bgcolor: 'rgba(0,0,0,0.25)' } },
    },
  };
}
