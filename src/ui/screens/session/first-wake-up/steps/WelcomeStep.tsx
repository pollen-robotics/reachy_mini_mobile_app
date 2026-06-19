import { Box, Stack } from '@mui/material';

import { Headline, PrimaryButton } from '../shared';

export default function WelcomeStep({ robotName, onNext }: { robotName?: string; onNext: () => void }) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <Headline
        title={robotName ? `Say hello to ${robotName}` : 'Say hello to your Reachy'}
        caption="It's awake! Let's run a quick check together to make sure it can hear, move, speak and see."
      />
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <PrimaryButton onClick={onNext}>Let's go</PrimaryButton>
      </Box>
    </Stack>
  );
}
