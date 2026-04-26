import { useState } from 'react';
import { Box, Button, Collapse, Divider, Stack, TextField, Typography } from '@mui/material';
import LinkIcon from '@mui/icons-material/Link';

interface ManualHostInputProps {
  onConnect: (host: string) => void;
}

/**
 * Fallback input when BLE discovery is unavailable or not cooperative.
 *
 * Accepts either a hostname (`reachy-mini.local`) or an IPv4 (`192.168.1.42`).
 * The path is a pragmatic escape hatch: on macOS, `.local` names resolve via
 * mDNS without any extra work, and power users often already know the robot
 * IP from their router.
 *
 * The widget is collapsed by default to keep the BLE path front-and-center.
 */
export default function ManualHostInput({ onConnect }: ManualHostInputProps) {
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState('reachy-mini.local');

  const handleSubmit = (): void => {
    const host = value.trim();
    if (!host) return;
    onConnect(host);
  };

  return (
    <Box>
      <Divider sx={{ my: 1 }}>
        <Button
          size="small"
          variant="text"
          onClick={() => setExpanded(v => !v)}
          sx={{ color: 'text.secondary' }}
        >
          {expanded ? 'Hide manual connect' : 'Or connect manually'}
        </Button>
      </Divider>

      <Collapse in={expanded} unmountOnExit>
        <Stack spacing={1.5} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Enter the robot hostname or IPv4 address. Useful when BLE is
            unavailable or you already know the address.
          </Typography>
          <TextField
            fullWidth
            size="small"
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="reachy-mini.local or 192.168.1.42"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            inputProps={{ inputMode: 'url' }}
            onKeyDown={e => {
              if (e.key === 'Enter') handleSubmit();
            }}
          />
          <Button
            variant="outlined"
            startIcon={<LinkIcon />}
            onClick={handleSubmit}
            disabled={value.trim().length === 0}
          >
            Connect
          </Button>
        </Stack>
      </Collapse>
    </Box>
  );
}
