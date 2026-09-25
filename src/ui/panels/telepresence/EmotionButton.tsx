/**
 * Small smiley in the top bar: opens a menu of a few calm emotions the
 * robot can play while the operator drives. Head control is handed to the
 * move while it plays (see `useTelepresence.playEmotion`).
 */
import { useState } from 'react';
import { CircularProgress, IconButton, Menu, MenuItem, Typography } from '@mui/material';
import SentimentSatisfiedAltRoundedIcon from '@mui/icons-material/SentimentSatisfiedAltRounded';

import { TELEPRESENCE_EMOTIONS, type TelepresenceHandle } from '@/features/telepresence';
import { TYPO } from '@/ui/design/tokens';

import { glassIconButtonSx } from './glass';

export default function EmotionButton({
  telepresence,
  disabled,
}: {
  telepresence: TelepresenceHandle;
  disabled: boolean;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const playing = telepresence.emotionPlaying !== null;

  return (
    <>
      <IconButton
        aria-label="Play an emotion"
        disabled={disabled || playing}
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={glassIconButtonSx}
      >
        {playing ? <CircularProgress size={18} color="inherit" /> : <SentimentSatisfiedAltRoundedIcon />}
      </IconButton>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        // Above the full-screen telepresence layer (1250).
        sx={{ zIndex: 1280 }}
      >
        {TELEPRESENCE_EMOTIONS.map((emotion) => (
          <MenuItem
            key={emotion.id}
            onClick={() => {
              setAnchor(null);
              telepresence.playEmotion(emotion);
            }}
          >
            <Typography sx={{ fontSize: TYPO.md }}>
              {emotion.emoji}&nbsp;&nbsp;{emotion.label}
            </Typography>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
