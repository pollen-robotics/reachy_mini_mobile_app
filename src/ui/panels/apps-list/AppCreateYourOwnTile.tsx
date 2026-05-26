/**
 * Trailing "Create your own" CTA tile.
 *
 * Sits at the end of every category rail (and at the end of the
 * focused-category flat list) to nudge the user toward the
 * developer guide: "Want to create your own?". Visually it's a
 * sibling of `AppCompactTile` - same outer width formula so the
 * rail rhythm stays uniform - but it leans into a CTA treatment
 * to read as an affordance rather than a real app:
 *
 *   - Dashed border + soft primary tint replace the solid
 *     border + paper bg.
 *   - 64×64 icon plate carries a `+` glyph in primary instead
 *     of an app icon.
 *   - The whole card is the tap target (no footer button pair);
 *     `role="button"` + Enter / Space handlers keep it accessible.
 *
 * Tapping opens the HF docs "Apps & Ecosystem" anchor in the
 * device browser via the Tauri opener plugin - same handoff the
 * Help sheet uses for documentation links.
 */
import { Box, Stack, Typography, alpha } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import ArrowOutwardRoundedIcon from '@mui/icons-material/ArrowOutwardRounded';

import { openExternalUrl } from '@/shared/tauri/openUrl';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

const CREATE_GUIDE_URL =
  'https://huggingface.co/docs/reachy_mini/index#-apps--ecosystem';

interface AppCreateYourOwnTileProps {
  /**
   * Width branch parity with `AppCompactTile`: `false` (default)
   * uses the rail's "1 + 30 % peek" viewport-relative formula;
   * `true` makes the tile span the full row, used when it
   * trails a focused-category vertical list.
   */
  fullWidth?: boolean;
}

export default function AppCreateYourOwnTile({
  fullWidth = false,
}: AppCreateYourOwnTileProps) {
  const handleOpen = () => {
    void openExternalUrl(CREATE_GUIDE_URL);
  };

  return (
    <Box
      role="button"
      tabIndex={0}
      aria-label="Create your own Reachy Mini app"
      onClick={handleOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleOpen();
        }
      }}
      sx={(theme) => ({
        flexShrink: 0,
        // Mirror `AppCompactTile`'s width branches so the CTA
        // tile slots into the rail without breaking the
        // "1 + 30 % peek" formula. See AppCompactTile for the
        // derivation.
        width: fullWidth
          ? '100%'
          : 'clamp(208px, calc((100vw - 72px) / 1.3), 320px)',
        height: 'auto',
        // Stretch vertically to match the tallest sibling tile
        // in the rail - the rail uses `display: flex` on its
        // track so children expand to the cross-axis max. This
        // keeps the CTA's bottom edge aligned with the regular
        // tiles even when their descriptions push them taller
        // than the CTA's intrinsic content.
        alignSelf: 'stretch',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        borderRadius: `${RADIUS.lg}px`,
        // Same paper bg + divider border as `AppCompactTile`, so
        // the CTA tile sits flush with its siblings in the rail.
        // The CTA-ness is carried entirely by the inner icon
        // plate (dashed primary `+`) and the copy: keeping the
        // outer frame neutral avoids visual noise at rail
        // density.
        bgcolor: 'background.paper',
        border: `1px solid ${theme.palette.divider}`,
        p: 2,
        cursor: 'pointer',
        userSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        transition: theme.transitions.create(['transform'], {
          duration: theme.transitions.duration.shortest,
        }),
        '&:active': {
          transform: 'scale(0.99)',
        },
        '&:focus-visible': {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 2,
        },
      })}
    >
      <Stack
        direction="row"
        spacing={1.5}
        alignItems="center"
        sx={{ minHeight: 64 }}
      >
        {/* Icon plate. Same 64×64 footprint as `AppCompactTile`
            so the CTA tile aligns visually with the sibling
            cards' icon rail, but rendered with a primary-tinted
            background + filled `+` glyph to signal "new" rather
            than "app icon". */}
        <Box
          sx={(theme) => ({
            width: 64,
            height: 64,
            flexShrink: 0,
            borderRadius: `${RADIUS.md}px`,
            bgcolor: alpha(theme.palette.primary.main, 0.1),
            border: `1px dashed ${alpha(theme.palette.primary.main, 0.4)}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: theme.palette.primary.main,
          })}
        >
          <AddRoundedIcon sx={{ fontSize: 36 }} />
        </Box>

        {/* Identity column. Same width branch + ellipsis safety
            as the regular tile, with the CTA copy + a trailing
            arrow glyph so the affordance reads at a glance. */}
        <Stack sx={{ flex: 1, minWidth: 0 }} spacing={0.25}>
          <Stack
            direction="row"
            alignItems="center"
            spacing={0.5}
            sx={{ minWidth: 0 }}
          >
            <Typography
              sx={(theme) => ({
                fontSize: TYPO.lg,
                fontWeight: FONT_WEIGHT.bold,
                color: theme.palette.primary.main,
                letterSpacing: '-0.3px',
                lineHeight: 1.2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              })}
            >
              Create your own
            </Typography>
            <ArrowOutwardRoundedIcon
              sx={(theme) => ({
                fontSize: TYPO.md,
                color: theme.palette.primary.main,
                flexShrink: 0,
              })}
            />
          </Stack>
          <Typography
            sx={{
              fontSize: TYPO.sm,
              color: 'text.secondary',
              lineHeight: 1.45,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            Build apps with the SDK and share them with the community.
          </Typography>
        </Stack>
      </Stack>
    </Box>
  );
}
