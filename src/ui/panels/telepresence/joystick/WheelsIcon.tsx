/**
 * Filled steering-wheel glyph, drawn on the thumb of the wheels
 * joystick (the head joystick keeps the default `MoveIcon`).
 */
import { SvgIcon, type SvgIconProps } from '@mui/material';

export default function WheelsIcon(props: SvgIconProps) {
  return (
    <SvgIcon viewBox="0 0 24 24" {...props}>
      {/* Rim: outer disk minus inner disk (even-odd). */}
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill="currentColor"
        d="M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20zm0 2.2a7.8 7.8 0 1 1 0 15.6a7.8 7.8 0 1 1 0-15.6z"
      />
      {/* Hub + three spokes (left, right, bottom). */}
      <circle cx="12" cy="12" r="2.8" fill="currentColor" />
      <rect x="4" y="11" width="6" height="2" fill="currentColor" />
      <rect x="14" y="11" width="6" height="2" fill="currentColor" />
      <rect x="11" y="14" width="2" height="6" fill="currentColor" />
    </SvgIcon>
  );
}
