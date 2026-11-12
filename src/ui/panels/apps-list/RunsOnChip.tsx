/**
 * Where an app runs, as a small chip: the one distinction users need between
 * the two app kinds. Phone apps open inside this app (an iframe on the
 * phone); Reachy apps are installed on the robot and keep running when the
 * phone leaves. Shown by context (which store the tile sits in), not by the
 * catalog's `isPythonApp` flag: a few apps ship both kinds.
 */
import { Box } from '@mui/material';
import PhoneIphoneRoundedIcon from '@mui/icons-material/PhoneIphoneRounded';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';

import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

export type RunsOn = 'phone' | 'robot';

const LABEL: Record<RunsOn, string> = {
  phone: 'Runs on phone',
  robot: 'Runs on Reachy',
};

export default function RunsOnChip({ runsOn }: { runsOn: RunsOn }) {
  const Icon = runsOn === 'robot' ? SmartToyOutlinedIcon : PhoneIphoneRoundedIcon;
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.4,
        alignSelf: 'flex-start',
        px: 0.75,
        py: 0.15,
        borderRadius: `${RADIUS.pill}px`,
        border: 1,
        borderColor: runsOn === 'robot' ? 'primary.main' : 'divider',
        color: runsOn === 'robot' ? 'primary.main' : 'text.secondary',
        fontSize: TYPO.tiny,
        fontWeight: FONT_WEIGHT.semibold,
        whiteSpace: 'nowrap',
        lineHeight: 1.4,
      }}
    >
      <Icon sx={{ fontSize: TYPO.sm }} aria-hidden />
      {LABEL[runsOn]}
    </Box>
  );
}
