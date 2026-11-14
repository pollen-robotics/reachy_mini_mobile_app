/**
 * Full-screen landscape frame for the telepresence tab (see `stage.ts`).
 *
 * On a portrait viewport the inner stage is sized to the swapped
 * viewport and turned a quarter clockwise; on a landscape one (desktop
 * preview, a tablet held sideways) it is laid out as-is.
 */
import { useMemo, useState } from 'react';
import { Box, useMediaQuery } from '@mui/material';

import { StageContext, stageInsetVars, type StageRotation } from './stage';

interface LandscapeStageProps {
  children: React.ReactNode;
}

export default function LandscapeStage({ children }: LandscapeStageProps) {
  const portrait = useMediaQuery('(orientation: portrait)', { noSsr: true });
  const rotation: StageRotation = portrait ? 90 : 0;
  // State, not a ref: the drawers need the node once it exists.
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ rotation, container }), [rotation, container]);

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        // Above the settings overlay (1200), below the connecting /
        // reconnecting / leaving / error covers (1300).
        zIndex: 1250,
        bgcolor: '#000',
        overflow: 'hidden',
        // Lets the stage size itself from this box with `cqw` / `cqh`.
        containerType: 'size',
      }}
    >
      <Box
        ref={setContainer}
        sx={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: rotation === 90 ? '100cqh' : '100cqw',
          height: rotation === 90 ? '100cqw' : '100cqh',
          transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
          overflow: 'hidden',
          ...stageInsetVars(rotation),
          // No text selection / callouts while thumbs are all over the screen.
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      >
        <StageContext.Provider value={value}>{children}</StageContext.Provider>
      </Box>
    </Box>
  );
}
