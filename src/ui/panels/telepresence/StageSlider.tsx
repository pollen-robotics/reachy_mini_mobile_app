/**
 * MUI `<Slider>` that still tracks the finger inside a rotated stage.
 *
 * MUI computes the value from `clientX/Y` against the slider's
 * `getBoundingClientRect()`, both in screen space, so a slider turned a
 * quarter with the stage reads the wrong axis. When the stage is
 * rotated, the slider is counter-rotated back upright on screen (so
 * MUI's math holds) and its orientation swapped, so it still LOOKS like
 * the requested orientation in the stage:
 *
 *   - stage-horizontal → upright vertical slider. Screen-down is
 *     stage-right, so values are mirrored (`min + max - v`) to keep
 *     `min` on the stage's left.
 *   - stage-vertical → upright horizontal slider, as-is (screen-left is
 *     stage-bottom).
 *
 * Unrotated, it's a plain `<Slider>`. Style overrides must not assume
 * an orientation (a track `height` would collapse the swapped one).
 */
import { Box, Slider, type SliderProps } from '@mui/material';

import { useStage } from './stage';

/** Single-thumb slider props (the only kind the telepresence view uses). */
export type StageSliderProps = SliderProps<'span', unknown, number>;

/** Cross-axis size of the slot holding a rotated slider (MUI's hit area). */
const SLOT_PX = 30;

export default function StageSlider({
  orientation = 'horizontal',
  min = 0,
  max = 100,
  value,
  marks,
  track = 'normal',
  onChange,
  onChangeCommitted,
  getAriaValueText,
  sx,
  ...rest
}: StageSliderProps) {
  const { rotation } = useStage();
  if (rotation === 0) {
    return (
      <Slider
        orientation={orientation}
        min={min}
        max={max}
        value={value}
        marks={marks}
        track={track}
        onChange={onChange}
        onChangeCommitted={onChangeCommitted}
        getAriaValueText={getAriaValueText}
        sx={sx}
        {...rest}
      />
    );
  }

  const mirror = orientation === 'horizontal';
  const flip = (v: number) => (mirror ? min + max - v : v);
  const flippedMarks = mirror && Array.isArray(marks) ? marks.map((m) => ({ ...m, value: flip(m.value) })) : marks;
  const flippedTrack = mirror && track !== false ? (track === 'normal' ? 'inverted' : 'normal') : track;

  return (
    <Box
      sx={{
        position: 'relative',
        containerType: 'size',
        ...(mirror ? { flex: 1, minWidth: 0, height: SLOT_PX } : { width: SLOT_PX, height: '100%' }),
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: '100cqh',
          height: '100cqw',
          transform: 'translate(-50%, -50%) rotate(-90deg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Slider
          orientation={mirror ? 'vertical' : 'horizontal'}
          min={min}
          max={max}
          value={value === undefined ? undefined : flip(value)}
          marks={flippedMarks}
          track={flippedTrack}
          onChange={onChange && ((e, v, thumb) => onChange(e, flip(v), thumb))}
          onChangeCommitted={onChangeCommitted && ((e, v) => onChangeCommitted(e, flip(v)))}
          sx={sx}
          {...rest}
          // aria-valuenow carries the mirrored value: announce the real one.
          getAriaValueText={(v, thumb) => (getAriaValueText ? getAriaValueText(flip(v), thumb) : String(flip(v)))}
        />
      </Box>
    </Box>
  );
}
