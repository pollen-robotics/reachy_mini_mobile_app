/**
 * Tool-call toast: small pill that surfaces the label of the tool the
 * model just invoked ("antennas", "head wobble", …) and auto-dismisses
 * after a short delay.
 *
 * Driven by the engine via `options.onToolToast`. The hook owner
 * (`ConversePanel`) keeps the latest toast in React state along with
 * an auto-dismiss timer; this component is purely presentational.
 */
import { Box, useTheme } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';

export interface ConversationToolToastProps {
  label: string | null;
}

export function ConversationToolToast({ label }: ConversationToolToastProps) {
  const theme = useTheme();
  const visible = Boolean(label);
  return (
    <Box
      role="status"
      aria-live="polite"
      className="convo-tool-toast"
      data-visible={visible ? 'true' : 'false'}
      sx={{
        bgcolor: theme.palette.action.hover,
        border: `1px solid ${theme.palette.divider}`,
        color: theme.palette.text.primary,
      }}
    >
      <AutoAwesomeIcon className="convo-tool-toast__icon" fontSize="inherit" />
      <span>{label ?? ''}</span>
    </Box>
  );
}
