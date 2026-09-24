/**
 * Outlined "move in any direction" glyph. Default centre glyph of the
 * joystick thumb, advertising "drag in any direction".
 */
import { SvgIcon, type SvgIconProps } from '@mui/material';

const STROKE_DEFAULTS = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export default function MoveIcon(props: SvgIconProps) {
  return (
    <SvgIcon
      viewBox="0 0 24 24"
      {...props}
      sx={[
        STROKE_DEFAULTS,
        ...(Array.isArray(props.sx) ? props.sx : [props.sx ?? false]),
      ]}
    >
      <line x1="12" y1="7" x2="12" y2="2" />
      <polyline points="8 5 12 2 16 5" />
      <line x1="12" y1="17" x2="12" y2="22" />
      <polyline points="8 19 12 22 16 19" />
      <line x1="7" y1="12" x2="2" y2="12" />
      <polyline points="5 8 2 12 5 16" />
      <line x1="17" y1="12" x2="22" y2="12" />
      <polyline points="19 8 22 12 19 16" />
    </SvgIcon>
  );
}
