/**
 * App card.
 *
 * Visual mirror of the desktop app's `AppCard` (see
 * `reachy_mini_desktop_app/src/views/active-robot/application-store/
 * discover/components/AppCard.tsx`) so the two surfaces feel like
 * the same product. The mobile variant trims:
 *   - no install/uninstall flow (mobile only iframes)
 *   - no Private / Web type chips (we only ever embed)
 *   - a single full-width "Open" button instead of the install/open
 *     branch
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
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import VerifiedIcon from '@mui/icons-material/Verified';

import type { AppEntry } from '../../apps/types';
import { FONT_WEIGHT, RADIUS, TYPO } from '../../styles/tokens';

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
        minWidth: 0,
        borderRadius: RADIUS.xxl / 8,
        position: 'relative',
        overflow: 'hidden',
        bgcolor: 'background.paper',
        border: `1px solid ${theme.palette.divider}`,
        cursor: 'pointer',
        transition: theme.transitions.create(['transform', 'border-color'], {
          duration: theme.transitions.duration.short,
        }),
        '&:hover': {
          transform: 'translateY(-1px)',
          borderColor: 'primary.main',
        },
        '&:focus-visible': {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 2,
        },
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
          Then the "Open" button at the bottom. */}
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
          endIcon={<OpenInNewIcon sx={{ fontSize: TYPO.md }} />}
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
            borderRadius: RADIUS.lg / 8,
          }}
        >
          Open
        </Button>
      </Box>
    </Box>
  );
}

export default memo(AppCardImpl);
