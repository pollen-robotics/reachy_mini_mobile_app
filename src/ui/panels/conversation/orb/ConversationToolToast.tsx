/**
 * Tool-call toast: small pill that surfaces the label of the tool the
 * model just invoked ("antennas", "head wobble", …) and auto-dismisses
 * after a short delay.
 *
 * Driven by the engine via `options.onToolToast`. The hook owner
 * (`ConversePanel`) keeps the latest toast in React state along with
 * an auto-dismiss timer; this component is purely presentational.
 */
import { useRef } from 'react';
import { Box, useTheme } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineRounded';

export interface ConversationToolToastProps {
  label: string | null;
  /** `"error"` renders the pill as a failure (error palette + warning
   *  icon) so a failed tool call - e.g. a camera error behind `look` -
   *  is visibly surfaced instead of silently fading out. */
  variant?: 'info' | 'error';
}

export function ConversationToolToast({
  label,
  variant = 'info',
}: ConversationToolToastProps) {
  const theme = useTheme();
  const visible = Boolean(label);
  // Keep the last non-null label on screen through the fade-out. The
  // pill dismisses by toggling `data-visible` to false, which runs a
  // 0.22s CSS opacity/transform transition. If we cleared the text
  // the instant `label` went null, the icon would linger alone for
  // that fade window ("icon + text" → "icon only" → gone). Retaining
  // the text means the whole pill (icon + text) fades out as one unit.
  const lastLabelRef = useRef('');
  const lastVariantRef = useRef<'info' | 'error'>('info');
  if (label) {
    lastLabelRef.current = label;
    lastVariantRef.current = variant;
  }
  const text = label ?? lastLabelRef.current;
  const shownVariant = label ? variant : lastVariantRef.current;
  const isError = shownVariant === 'error';

  const sx = isError
    ? {
        bgcolor: theme.palette.error.main,
        border: `1px solid ${theme.palette.error.main}`,
        color: theme.palette.error.contrastText,
      }
    : {
        bgcolor: theme.palette.action.hover,
        border: `1px solid ${theme.palette.divider}`,
        color: theme.palette.text.primary,
      };

  return (
    <Box
      role="status"
      aria-live={isError ? 'assertive' : 'polite'}
      className="convo-tool-toast"
      data-visible={visible ? 'true' : 'false'}
      sx={sx}
    >
      {isError ? (
        <ErrorOutlineIcon className="convo-tool-toast__icon" fontSize="inherit" />
      ) : (
        <AutoAwesomeIcon className="convo-tool-toast__icon" fontSize="inherit" />
      )}
      <span>{text}</span>
    </Box>
  );
}
