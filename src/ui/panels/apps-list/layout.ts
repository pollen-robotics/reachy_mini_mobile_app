/**
 * Shared layout primitives for the Apps tab.
 *
 * Every panel in the tab (`AppsTabView`) renders inside a full-bleed
 * wrapper that escapes the host column to the viewport edges (so
 * dividers and rails span the whole screen), then re-constrains its
 * own content back to a centred column. `COLUMN_SX` is that single
 * re-constraint, and `LIST_ROW_GAP_PX` the vertical rhythm of the
 * flat (search / focus) lists.
 *
 * They live here, in one module, because both the main tab and the
 * windowed `VirtualAppList` depend on them: keeping a single source
 * of truth stops the two from drifting (a 1 px gutter mismatch would
 * silently break the alignment between rails and the search list).
 */
import { LAYOUT } from '@/ui/design/tokens';

/**
 * Re-constrains a row to the centred content column. Applied by every
 * panel so titles, the search input and list rows line up on one
 * vertical axis even though the dividers themselves span the full
 * viewport. The `px: 3` gutter is the column's horizontal inset.
 */
export const COLUMN_SX = {
  width: '100%',
  maxWidth: LAYOUT.contentMaxWidth,
  mx: 'auto',
  px: 3,
} as const;

/**
 * Vertical gap between consecutive cards in the search-results and
 * category-focus lists. The tile is content-driven (no fixed height)
 * so the gap is the only thing controlling the rhythm between rows.
 */
export const LIST_ROW_GAP_PX = 12;
