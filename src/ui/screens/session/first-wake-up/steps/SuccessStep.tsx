import { motion } from 'motion/react';
import { Box, Stack } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';

import RobotAvatar from '@/ui/design/RobotAvatar';
import { RADIUS, STATUS } from '@/ui/design/tokens';
import { Headline, PrimaryButton } from '../shared';

export default function SuccessStep({ robotName, onFinish }: { robotName?: string; onFinish: () => void }) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <Box sx={{ position: 'relative' }}>
        <motion.div
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 380, damping: 22 }}
        >
          <RobotAvatar size={96} />
        </motion.div>
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 520, damping: 18, delay: 0.18 }}
          style={{ position: 'absolute', right: -4, bottom: -4, display: 'flex' }}
        >
          <CheckCircleIcon
            sx={{ fontSize: 32, color: STATUS.success, bgcolor: 'background.default', borderRadius: RADIUS.circle }}
          />
        </motion.div>
      </Box>
      <Headline
        title={robotName ? `${robotName} is ready` : 'All set!'}
        caption="Everything checks out. Tap the orb whenever you're ready to start chatting."
      />
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <PrimaryButton startIcon={<AutoAwesomeRoundedIcon />} onClick={onFinish}>
          Start using Reachy
        </PrimaryButton>
      </Box>
    </Stack>
  );
}
