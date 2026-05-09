/**
 * Bottom-of-screen audio controls bar.
 *
 *   SPEAKER             MICROPHONE
 *   ┌─────────────┐     ┌─────────────┐
 *   │ [🔊]  ●──●  │     │ [🎤]  ●──●  │
 *   └─────────────┘     └─────────────┘
 *
 * Pure layout component: 50/50 row of speaker + mic cards.
 * All audio plumbing (volume fetch / push, sound feedback) is
 * owned by the `useAudioVolumes` hook so the bar can be lifted
 * out of the conversation view as-is.
 */
import { Box, Stack } from '@mui/material';

import AudioControlCard from '@/ui/widgets/audio-controls/AudioControlCard';
import { useAudioVolumes } from '@/ui/widgets/audio-controls/useAudioVolumes';
import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';

interface AudioControlsBarProps {
  /**
   * Slice of the session handle the bar needs - typed via
   * `Pick` so the dependency surface is explicit at the call
   * site and the bar can be unit-tested with a fake.
   */
  session: Pick<
    RobotSessionHandle,
    | 'getSpeakerVolume'
    | 'setSpeakerVolume'
    | 'getMicrophoneVolume'
    | 'setMicrophoneVolume'
    | 'playSound'
  >;
  /**
   * When true, the bar performs the initial volume fetch and
   * the cards are interactable. Set this to `true` once the
   * session is past the bring-up phase (typically
   * `hasReachedReady`).
   */
  isLive: boolean;
}

export default function AudioControlsBar({
  session,
  isLive,
}: AudioControlsBarProps) {
  const volumes = useAudioVolumes({ session, enabled: isLive });

  return (
    <Stack direction="row" spacing={1.25} sx={{ width: '100%' }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <AudioControlCard
          kind="speaker"
          value={volumes.speakerVolume}
          onChange={volumes.setSpeakerVolume}
          onToggleMute={volumes.toggleSpeakerMute}
          disabled={!isLive}
        />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <AudioControlCard
          kind="microphone"
          value={volumes.microphoneVolume}
          onChange={volumes.setMicrophoneVolume}
          onToggleMute={volumes.toggleMicrophoneMute}
          disabled={!isLive}
        />
      </Box>
    </Stack>
  );
}
