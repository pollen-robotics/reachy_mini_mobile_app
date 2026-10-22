/**
 * AccessoryBadge - what is on the NFC reader, in the orb area.
 *
 * Mobile copy of the conversation app's "Accessory" badge group (the web UI
 * the desktop app shows), right-aligned like there:
 *
 *            ╭────╮  ACCESSORY
 *            │ 🎩 │  None
 *            ╰────╯
 *       [ Link personality ]
 *
 * Icon states, as on the web:
 *   - unavailable : greyed out, struck through (no reader)
 *   - none        : neutral (reader empty)
 *   - blank       : dashed outline (an accessory waiting for a personality)
 *   - known       : green (carries the personality running)
 *   - mismatch    : amber, names the other personality it carries
 *   - unknown     : neutral, "Unrecognized"
 *
 * "Link personality" writes the running personality onto a blank or
 * unrecognized accessory ("Relink" when it carries another one). Tapping
 * the badge itself opens Settings on the NFC section.
 */
import { useEffect, useState } from 'react';
import { Box, ButtonBase, Stack, Typography, alpha, useTheme } from '@mui/material';

import {
  canLinkAccessory,
  type AccessoryBadgeView,
  type AccessoryState,
  type LinkOutcome,
} from '@/features/nfc';
import { FONT_WEIGHT, RADIUS, STATUS, TYPO } from '@/ui/design/tokens';

const LABEL_BY_STATE: Record<AccessoryState, string> = {
  unavailable: 'Unavailable',
  none: 'None',
  blank: 'Blank',
  known: 'Linked',
  unknown: 'Unrecognized',
};

const DISC = 44;
/** How long the outcome of a link stays under the button. */
const MESSAGE_MS = 4_000;

interface AccessoryBadgeProps {
  accessory: AccessoryBadgeView;
  /** The personality running, as the robot names it. */
  activePersonality: string;
  /** Its display name, for the link messages. */
  activePersonalityName: string;
  /** False while the robot does not have the running personality yet (it
   *  goes over at the next conversation start): a tag naming it would read as
   *  unrecognized there until then. */
  canLink: boolean;
  onOpen: () => void;
  onLink: () => Promise<LinkOutcome>;
}

export function AccessoryBadge({
  accessory,
  activePersonality,
  activePersonalityName,
  canLink,
  onOpen,
  onLink,
}: AccessoryBadgeProps) {
  const theme = useTheme();
  const [linking, setLinking] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), MESSAGE_MS);
    return () => window.clearTimeout(timer);
  }, [message]);

  const { state } = accessory;
  // "Linked" would only repeat the personality band; the name earns its
  // place when the accessory carries another personality than the one running.
  const mismatch = state === 'known' && accessory.personality !== activePersonality;
  const label = mismatch
    ? (accessory.personalityName ?? LABEL_BY_STATE.known)
    : LABEL_BY_STATE[state];
  const tone = mismatch ? STATUS.warning : state === 'known' ? STATUS.success : null;
  const showLink = linking || canLinkAccessory(accessory, activePersonality);
  const accent = theme.palette.primary.main;

  const link = async (): Promise<void> => {
    setLinking(true);
    setMessage({ text: `Linking the accessory to "${activePersonalityName}"…`, error: false });
    const outcome = await onLink();
    setLinking(false);
    setMessage(
      outcome.ok
        ? {
            text: outcome.written
              ? `Accessory linked to "${activePersonalityName}".`
              : `This accessory already carries "${activePersonalityName}".`,
            error: false,
          }
        : { text: `Could not link the accessory: ${outcome.error}`, error: true }
    );
  };

  return (
    <Stack spacing={1} sx={{ alignItems: 'flex-end', maxWidth: 200 }}>
      <ButtonBase
        onClick={onOpen}
        aria-label={`Accessory: ${label}. Open NFC settings.`}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.25,
          maxWidth: '100%',
          p: 0.5,
          m: -0.5,
          borderRadius: `${RADIUS.lg}px`,
          textAlign: 'right',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <Box
          sx={{
            width: DISC,
            height: DISC,
            flexShrink: 0,
            display: 'grid',
            placeItems: 'center',
            borderRadius: '50%',
            color: tone ?? 'text.secondary',
            bgcolor: tone ? alpha(tone, 0.16) : 'action.hover',
            border:
              state === 'blank'
                ? `2px dashed ${theme.palette.text.disabled}`
                : `1px solid ${tone ? alpha(tone, 0.55) : theme.palette.divider}`,
            opacity: state === 'unavailable' ? 0.55 : 1,
          }}
        >
          {/* Same hat as the web badge. */}
          <Box
            component="svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            sx={{ width: 24, height: 24 }}
          >
            <path d="M4 13a8 8 0 0 1 16 0" />
            <rect x="2" y="13" width="20" height="6" rx="2" />
            <path d="M9 16h6" />
            {state === 'unavailable' && <path d="M4 20 20 4" />}
          </Box>
        </Box>
        <Stack sx={{ minWidth: 0, alignItems: 'flex-end', gap: 0.25 }}>
          {/* Same eyebrow as the personality band's "Personality". */}
          <Typography
            component="span"
            sx={{
              fontSize: TYPO.micro,
              fontWeight: FONT_WEIGHT.medium,
              color: 'text.secondary',
              opacity: 0.7,
              textTransform: 'uppercase',
              letterSpacing: '0.8px',
              lineHeight: 1.1,
            }}
          >
            Accessory
          </Typography>
          <Typography
            component="span"
            sx={{
              maxWidth: '100%',
              fontSize: 16,
              fontWeight: FONT_WEIGHT.semibold,
              lineHeight: 1.2,
              color: 'text.primary',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {label}
          </Typography>
        </Stack>
      </ButtonBase>

      {showLink && (
        <Box
          component="button"
          type="button"
          onClick={() => void link()}
          disabled={linking || !canLink}
          sx={{
            appearance: 'none',
            font: 'inherit',
            maxWidth: '100%',
            minHeight: 34,
            px: 1.75,
            py: 0.75,
            borderRadius: `${RADIUS.sm}px`,
            border: `1px solid ${alpha(accent, 0.42)}`,
            bgcolor: alpha(accent, 0.16),
            color: 'primary.main',
            fontSize: TYPO.sm,
            fontWeight: FONT_WEIGHT.bold,
            lineHeight: 1.2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            cursor: linking ? 'wait' : canLink ? 'pointer' : 'default',
            opacity: linking || !canLink ? 0.65 : 1,
            transition: 'background-color 0.15s ease, opacity 0.15s ease',
            WebkitTapHighlightColor: 'transparent',
            '&:active': { bgcolor: alpha(accent, 0.24) },
          }}
        >
          {mismatch ? 'Relink personality' : 'Link personality'}
        </Box>
      )}

      {showLink && !canLink && !linking && (
        <Typography
          sx={{ fontSize: TYPO.xs, lineHeight: 1.35, textAlign: 'right', color: 'text.secondary' }}
        >
          Start a conversation once so Reachy gets "{activePersonalityName}", then link it.
        </Typography>
      )}

      {message && (
        <Typography
          role="status"
          sx={{
            fontSize: TYPO.xs,
            lineHeight: 1.35,
            textAlign: 'right',
            color: message.error ? 'error.main' : 'text.secondary',
          }}
        >
          {message.text}
        </Typography>
      )}
    </Stack>
  );
}
