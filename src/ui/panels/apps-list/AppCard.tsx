/**
 * App card.
 *
 * Visual mirror of the desktop app's `AppCard` (see
 * `reachy_mini_desktop_app/src/views/active-robot/application-store/
 * discover/components/AppCard.tsx`) so the two surfaces feel like
 * the same product. The mobile variant trims:
 *   - no install/uninstall flow (mobile only iframes)
 *   - no Private / Web type chips (we only ever embed)
 *   - a single full-width "Launch" button instead of the install/open
 *     branch (the app boots in an in-app iframe overlay, not in an
 *     external browser, so we deliberately avoid the
 *     `OpenInNew`-style external-link metaphor)
 *
 * The card is `React.memo`'d because we render it inside a virtualizer
 * (see `AppsTabView`), where avoiding re-renders on scroll matters
 * more than on the desktop's static grid.
 */
import { memo } from 'react';
import {
  Avatar,
  Box,
  Button,
  Chip,
  Typography,
} from '@mui/material';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import VerifiedIcon from '@mui/icons-material/Verified';

import type { AppEntry } from '@/apps/types';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

interface AppCardProps {
  app: AppEntry;
  onOpen: (app: AppEntry) => void;
}

/**
 * Cardinality-stable accessors for the optional bits that live in
 * `extra` on a normalized catalog entry. Centralised here so a
 * malformed payload (a Space without cardData, or with cardData of
 * the wrong shape) just renders the empty fallback instead of
 * blowing up the row.
 */
function readEmoji(app: AppEntry): string {
  const cardData = app.extra?.cardData as
    | { emoji?: string }
    | undefined;
  const isPythonApp = (app.extra?.isPythonApp as boolean | undefined) !== false;
  const raw = cardData?.emoji || (isPythonApp ? '📦' : '🌐');
  // Use spread-and-take-first so multi-codepoint emoji (e.g. flags,
  // skin-toned hands) are kept whole when the Space lists more than
  // one in `cardData.emoji` (some catalog entries do this).
  return [...raw][0] ?? '📦';
}

function readLastModified(app: AppEntry): string | null {
  const raw =
    (app.extra?.lastModified as string | number | undefined) ||
    (app.extra?.createdAt as string | number | undefined) ||
    null;
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function AppCardImpl({ app, onOpen }: AppCardProps) {
  const author = app.author;
  const emoji = readEmoji(app);
  const formattedDate = readLastModified(app);

  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={() => onOpen(app)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(app);
        }
      }}
      sx={(theme) => ({
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        // Stretch to fill the virtual row's full height. Without
        // this the card is content-sized, which means a card
        // with a 1-line description ends up shorter than one
        // with a 2-line description + date - and since the
        // virtualizer's row height is constant (`ROW_HEIGHT_PX`
        // in `AppsTabView`), the leftover empty space below
        // each card varies, producing visually inconsistent
        // gaps between cards. Filling the row keeps the gap
        // constant (= the row wrapper's `pb` gutter); the card
        // body already uses `flex: 1` to absorb the description
        // height variance internally, with the Launch button
        // pinned to the bottom via `mt: 'auto'`.
        height: '100%',
        minWidth: 0,
        borderRadius: '14px',
        position: 'relative',
        overflow: 'hidden',
        // White card on the grey canvas - same convention as
        // the robot cards in `ScanScreen` and the audio
        // controls in `ControlCard`.
        bgcolor: 'background.paper',
        border: `1px solid ${theme.palette.divider}`,
        cursor: 'pointer',
        // No hover effect: this is a mobile-first surface, the
        // primary-outlined Launch button at the bottom of each
        // card already advertises the affordance. Hover would
        // only fire on the desktop wrapper and create
        // inconsistency with touch (where there is none).
        '&:focus-visible': {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 2,
        },
        '&:active': {
          // Touch feedback: subtle press-down on tap so the
          // tap registers visually even before the iframe
          // overlay starts mounting.
          transform: 'scale(0.99)',
        },
        transition: theme.transitions.create('transform', {
          duration: theme.transitions.duration.shortest,
        }),
      })}
    >
      {/* Header: author + Official chip on the left, likes on the right.
          Mirrors the desktop's `Box` row above the divider. */}
      <Box
        sx={{
          width: '100%',
          px: 2,
          pt: 1.25,
          pb: 0,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            minWidth: 0,
            flex: 1,
          }}
        >
          {author && (
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.75,
                minWidth: 0,
              }}
      >
        <Avatar
                sx={(theme) => ({
                  width: 20,
                  height: 20,
                  bgcolor: app.isOfficial
                    ? 'primary.light'
                    : theme.palette.action.selected,
                  fontSize: TYPO.tiny,
                  fontWeight: FONT_WEIGHT.semibold,
                  color: app.isOfficial
                    ? theme.palette.primary.contrastText
                    : 'text.primary',
                  flexShrink: 0,
                })}
              >
                {author.charAt(0).toUpperCase()}
              </Avatar>
              <Typography
                sx={{
                  fontSize: TYPO.xs,
                  fontWeight: FONT_WEIGHT.medium,
                  color: 'text.secondary',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {author}
              </Typography>
            </Box>
          )}
          {app.isOfficial && (
            <Chip
              icon={<VerifiedIcon sx={{ fontSize: TYPO.xs }} />}
              label="Official"
              size="small"
              sx={{
                bgcolor: 'action.selected',
                color: 'primary.main',
                fontWeight: FONT_WEIGHT.semibold,
                fontSize: TYPO.micro,
                height: 18,
                flexShrink: 0,
                '& .MuiChip-icon': { color: 'primary.main', ml: 0.5 },
                '& .MuiChip-label': { px: 0.5 },
              }}
            />
          )}
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <FavoriteBorderIcon
            sx={{ fontSize: TYPO.lg, color: 'text.secondary' }}
          />
          <Typography
            sx={{
              fontSize: TYPO.sm,
              fontWeight: FONT_WEIGHT.semibold,
              color: 'text.secondary',
              lineHeight: 1,
            }}
          >
            {app.likes || 0}
          </Typography>
        </Box>
      </Box>

      {/* Divider, padded to the same horizontal inset as the desktop. */}
      <Box sx={{ px: 2, pt: 1, pb: 0 }}>
        <Box
          sx={(theme) => ({
            borderBottom: `1px solid ${theme.palette.divider}`,
          })}
        />
      </Box>

      {/* Body: name + description + date on the left, emoji on the right.
          Then the "Launch" button at the bottom. */}
      <Box
        sx={{
          px: 2,
          py: 2,
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          gap: 1.5,
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
          }}
        >
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              gap: 0.5,
              flex: 1,
              alignItems: 'flex-start',
              minWidth: 0,
            }}
          >
            <Typography
              sx={{
                fontSize: TYPO.lg,
                fontWeight: FONT_WEIGHT.bold,
                color: 'text.primary',
                letterSpacing: '-0.3px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                width: '100%',
              }}
            >
              {app.name}
            </Typography>

            <Typography
                sx={{
                fontSize: TYPO.sm,
                color: 'text.secondary',
                lineHeight: 1.5,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                textAlign: 'left',
                width: '100%',
              }}
            >
              {app.description || 'No description'}
            </Typography>

            {formattedDate && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <AccessTimeIcon
                  sx={{ fontSize: TYPO.sm, color: 'text.secondary' }}
                />
                <Typography
                  sx={{
                    fontSize: TYPO.tiny,
                    fontWeight: FONT_WEIGHT.medium,
                    color: 'text.secondary',
                  }}
                >
                  {formattedDate}
                </Typography>
              </Box>
            )}
          </Box>

          <Typography
            component="span"
            sx={{
              fontSize: 24,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            {emoji}
          </Typography>
        </Box>

        <Button
          variant="outlined"
          color="primary"
          size="small"
          startIcon={<PlayArrowOutlinedIcon sx={{ fontSize: TYPO.lg }} />}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(app);
          }}
          sx={{
            mt: 'auto',
            width: '100%',
            py: 1,
            fontSize: TYPO.sm,
            fontWeight: FONT_WEIGHT.semibold,
            textTransform: 'none',
            borderRadius: '10px',
            // Explicit outlined treatment: 1.5 px primary border,
            // transparent background. Override MUI's default
            // hover-fill (subtle alpha tint) so the button stays
            // outlined in every state - no "filled at rest /
            // tinted on hover" inconsistency that reads as
            // "wait, is this filled or outlined?".
            borderWidth: 1.5,
            bgcolor: 'transparent',
            '&:hover': {
              borderWidth: 1.5,
              bgcolor: 'transparent',
            },
            '&:active': {
              borderWidth: 1.5,
              bgcolor: 'transparent',
            },
          }}
        >
          Launch
        </Button>
      </Box>
    </Box>
  );
}

export default memo(AppCardImpl);
