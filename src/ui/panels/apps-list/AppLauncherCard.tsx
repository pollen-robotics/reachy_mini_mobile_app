/**
 * Launcher card - the "Pinned" view's big tile.
 *
 * Unlike the icon-dock `AppPinnedTile` (glyph + caption only) and the
 * store's `AppCompactTile` (glyph + meta + pin/launch footer), this is
 * a launcher-first card: the WHOLE card is the tap target (open the
 * app), and it foregrounds identity + a short description so the
 * curated set reads like a home screen of "things my Reachy can do".
 *
 * Visual contract (rendered two-up in a grid): centered, plate-less.
 * The app icon IS the illustration (no inner box), and the official
 * check is a faint cue tucked into the card's top-right corner.
 *
 *   ┌────────────┬─┐
 *   │      🎵      ✓│  icon (large, centered) + faint corner check
 *   │              │
 *   │ Dance Party  │   name (bold, 1 line, centered)
 *   │  Groove to   │   description (2-line clamp, centered)
 *   │  your music  │
 *   └──────────────┘
 *
 * Edit mode (driven by the launcher header's Edit/Done toggle) swaps
 * the tap-to-open for an iOS-style jiggle + a `✕` unpin badge, reusing
 * the same choreography vocabulary as `AppPinnedTile` so the two
 * surfaces feel of a piece.
 */
import { memo, useMemo, type KeyboardEvent, type MouseEvent } from 'react';
import { Box, IconButton, Typography, alpha } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import VerifiedOutlinedIcon from '@mui/icons-material/VerifiedOutlined';

import type { AppEntry } from '@/features/apps/types';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';
import AppIcon from './AppIcon';

/** Stable per-id 32-bit hash (mirrors `AppPinnedTile.tileSeed`) so a
 *  card picks the same jiggle phase/variant on every Edit toggle. */
function tileSeed(id: string): number {
  let s = 0;
  for (let i = 0; i < id.length; i++) {
    s = (s * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(s);
}

interface AppLauncherCardProps {
  app: AppEntry;
  /** Plays the pop-in keyframe when the card just landed (fresh pin). */
  isNew?: boolean;
  /** Parent launcher grid is in edit mode: show the unpin badge +
   *  jiggle, suppress tap-to-open. */
  editMode?: boolean;
  onOpen: (app: AppEntry) => void;
  onUnpin?: (app: AppEntry) => void;
}

function AppLauncherCardImpl({
  app,
  isNew = false,
  editMode = false,
  onOpen,
  onUnpin,
}: AppLauncherCardProps) {
  const { wiggleDelayMs, wiggleDurationMs, wiggleVariant } = useMemo(() => {
    const seed = tileSeed(app.id);
    return {
      wiggleDelayMs: -(seed % 560),
      wiggleDurationMs: 480 + ((seed >>> 3) % 160),
      wiggleVariant: seed % 2 === 0 ? 'a' : 'b',
    } as const;
  }, [app.id]);

  const handleClick = () => {
    if (editMode) return;
    onOpen(app);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editMode) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(app);
    }
  };

  const handleUnpinClick = (e: MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    onUnpin?.(app);
  };

  return (
    <Box
      role={editMode ? undefined : 'button'}
      tabIndex={editMode ? -1 : 0}
      aria-label={editMode ? undefined : `Launch ${app.name}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      sx={theme => ({
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        height: '100%',
        boxSizing: 'border-box',
        p: 2,
        borderRadius: `${RADIUS.lg}px`,
        bgcolor: 'background.paper',
        border: `1px solid ${theme.palette.divider}`,
        cursor: editMode ? 'default' : 'pointer',
        userSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        transformOrigin: 'center',
        transition: theme.transitions.create('transform', {
          duration: theme.transitions.duration.shortest,
        }),
        animation: editMode
          ? `launcher-card-wiggle-${wiggleVariant} ${wiggleDurationMs}ms ease-in-out ${wiggleDelayMs}ms infinite`
          : isNew
            ? 'launcher-card-pop-in 240ms cubic-bezier(0.34, 1.56, 0.64, 1) 80ms both'
            : 'none',
        '@keyframes launcher-card-pop-in': {
          '0%': { opacity: 0, transform: 'scale(0.85)' },
          '100%': { opacity: 1, transform: 'scale(1)' },
        },
        '@keyframes launcher-card-wiggle-a': {
          '0%, 100%': { transform: 'rotate(-0.8deg)' },
          '25%': { transform: 'rotate(0.8deg)' },
          '50%': { transform: 'rotate(-0.5deg)' },
          '75%': { transform: 'rotate(0.8deg)' },
        },
        '@keyframes launcher-card-wiggle-b': {
          '0%, 100%': { transform: 'rotate(0.8deg)' },
          '25%': { transform: 'rotate(-0.8deg)' },
          '50%': { transform: 'rotate(0.5deg)' },
          '75%': { transform: 'rotate(-0.8deg)' },
        },
        '@media (prefers-reduced-motion: reduce)': {
          animation: 'none',
        },
        '&:focus-visible': {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 2,
        },
        '&:active': {
          transform: editMode ? undefined : 'scale(0.97)',
        },
      })}
    >
      {/* Illustration: the app icon itself, centered and large, with
          NO plate around it (the card IS the frame). Sized to overflow
          slightly for PNG glyphs, matching the home-screen "hero icon"
          treatment. */}
      <Box
        sx={{
          width: '100%',
          height: 88,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'visible',
        }}
      >
        <AppIcon app={app} size={64} imageSize={120} svgImageSize={80} />
      </Box>

      {/* Name (centered, 1 line). The official check no longer sits
          inline here - it's a faint corner cue (see below) so the name
          stays perfectly centered and uncluttered. */}
      <Box
        sx={{
          mt: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          maxWidth: '100%',
        }}
      >
        <Typography
          sx={{
            minWidth: 0,
            fontSize: TYPO.md,
            fontWeight: FONT_WEIGHT.bold,
            color: 'text.primary',
            letterSpacing: '-0.2px',
            lineHeight: 1.25,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {app.name}
        </Typography>
      </Box>

      {/* Description: centered, clamped to 2 lines, height reserved so
          cards in a row stay uniform even with a shorter blurb. */}
      <Typography
        sx={{
          mt: 0.5,
          fontSize: TYPO.xs,
          color: 'text.secondary',
          lineHeight: 1.4,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minHeight: '2.8em',
        }}
      >
        {app.description || '\u00a0'}
      </Typography>

      {/* Official check: a very faint cue tucked into the card's
          top-right corner. Kept intentionally low-contrast (disabled
          colour + reduced opacity) so "made by Pollen" reads as a quiet
          watermark rather than a badge competing with the icon. Hidden in
          edit mode, where the unpin ✕ owns this same corner. */}
      {!editMode && app.isOfficial && (
        <VerifiedOutlinedIcon
          aria-label="Official"
          sx={{
            position: 'absolute',
            top: 8,
            right: 8,
            fontSize: 17,
            color: 'text.disabled',
            opacity: 0.55,
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Edit-mode drag affordance: a faint "grip" glyph in the
          top-left corner hinting the card can be dragged to reorder.
          Purely decorative (the WHOLE card is the drag handle) so it's
          non-interactive and low-contrast, mirroring the official
          watermark's quiet posture in the opposite corner. */}
      {editMode && (
        <DragIndicatorIcon
          aria-hidden
          sx={{
            position: 'absolute',
            top: 6,
            left: 6,
            fontSize: 18,
            color: 'text.disabled',
            opacity: 0.5,
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Edit-mode unpin badge: half-off the card's top-right corner,
          the only actionable element while editing. */}
      {editMode && onUnpin && (
        <IconButton
          aria-label={`Unpin ${app.name}`}
          onClick={handleUnpinClick}
          sx={theme => ({
            position: 'absolute',
            top: -8,
            right: -8,
            width: 24,
            height: 24,
            minWidth: 0,
            padding: 0,
            bgcolor: 'background.paper',
            color: 'primary.main',
            border: `1.5px solid ${theme.palette.primary.main}`,
            boxShadow: theme.shadows[1],
            zIndex: 2,
            '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.08) },
            '&:active': {
              transform: 'scale(0.9)',
              bgcolor: alpha(theme.palette.primary.main, 0.16),
            },
          })}
        >
          <CloseIcon sx={{ fontSize: 15 }} />
        </IconButton>
      )}
    </Box>
  );
}

export default memo(AppLauncherCardImpl);
