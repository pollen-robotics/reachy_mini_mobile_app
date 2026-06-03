/**
 * Cooking placeholder for a persona avatar: a deterministic monogram (the
 * persona's initial) under a soft shimmer sweep.
 *
 * Why a monogram + shimmer rather than a spinner / determinate ring:
 * the persona is ALREADY usable the instant it's created - only its custom
 * portrait is baking in the background (~1 min). That's an async / optimistic
 * case, not a blocking wait, so the canonical pattern is a stable placeholder
 * that swaps for the real asset on arrival (think initials avatars + skeleton
 * shimmer), NOT a progress bar that invites the user to sit and watch a fill.
 *
 *  - The INITIAL is deterministic per persona (same name -> same letter), so
 *    freshly-created personas read as distinct from the first frame instead
 *    of all sharing one generic face.
 *  - The SHIMMER (a pale light band sweeping across the disc, the usual
 *    skeleton-loading cue) signals "this is being prepared" calmly, without a
 *    finish line.
 *
 * Pure design-layer primitive (MUI only) so it can sit on any avatar disc.
 */
import { Box } from '@mui/material';
import { alpha } from '@mui/material/styles';

interface CookingMonogramProps {
  /** Persona name; its first character becomes the monogram. */
  name: string;
  /** Disc diameter in px (the monogram scales off this). */
  size: number;
  /**
   * Whether to run the "cooking" shimmer sweep. When `true` (a portrait is
   * baking) the letter is also dimmed further, since the shimmer carries the
   * signal. When `false` it's a plain static placeholder (e.g. a freshly
   * named persona before any bake) and the letter reads a touch stronger.
   */
  shimmer?: boolean;
}

export default function CookingMonogram({
  name,
  size,
  shimmer = true,
}: CookingMonogramProps) {
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <Box
      aria-hidden
      sx={{
        position: 'absolute',
        inset: 0,
        borderRadius: '50%',
        overflow: 'hidden',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <Box
        component="span"
        sx={{
          fontSize: size * 0.42,
          fontWeight: 600,
          lineHeight: 1,
          // Kept deliberately faint: the persona is usable now, so the
          // monogram is just a quiet stand-in for the portrait, not a focal
          // point. While baking the shimmer carries the signal, so the letter
          // dims further; as a static placeholder it reads a touch stronger.
          color: 'text.secondary',
          opacity: shimmer ? 0.12 : 0.2,
          userSelect: 'none',
        }}
      >
        {initial}
      </Box>
      {/* Shimmer sweep: a pale band sliding across on a loop. `text.primary`
          tint adapts to the theme (dark band in light mode, light band in
          dark). Disabled under reduced-motion. */}
      {shimmer && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            backgroundRepeat: 'no-repeat',
            backgroundSize: '55% 100%',
            backgroundImage: theme =>
              `linear-gradient(100deg, transparent 0%, ${alpha(
                theme.palette.text.primary,
                0.05,
              )} 50%, transparent 100%)`,
            animation: 'cookShimmer 1.6s ease-in-out infinite',
            '@keyframes cookShimmer': {
              '0%': { backgroundPosition: '-150% 0' },
              '100%': { backgroundPosition: '250% 0' },
            },
            '@media (prefers-reduced-motion: reduce)': {
              animation: 'none',
            },
          }}
        />
      )}
    </Box>
  );
}
