/**
 * Plutchik emotion wheel: 8 family slices around a dice.
 *
 *            joy
 *   anticip.  ·  trust
 *   anger   (🎲)   fear
 *   disgust  ·  surprise
 *          sadness
 *
 * Tapping a slice selects its family (the sheet lists that family's
 * moves); the centre dice plays a random emotion - from the selected
 * family when there is one, otherwise from the whole wheel. Slices are
 * real buttons (focusable, Enter/Space), so the wheel works without a
 * touchscreen and with a screen reader.
 */
import { Box } from '@mui/material';

import {
  COUNT_BY_FAMILY,
  FAMILY_COLORS,
  FAMILY_EMOJIS,
  FAMILY_LABELS,
  FAMILY_ORDER,
  type PlutchikFamily,
} from '@/features/emotions';

interface EmotionWheelProps {
  selected: PlutchikFamily | null;
  onSelect: (family: PlutchikFamily) => void;
  onRandom: () => void;
  disabled?: boolean;
  size?: number;
}

const VIEW = 300;
const C = VIEW / 2;
const R_OUT = 146;
const R_IN = 50;
const SLICE = (2 * Math.PI) / FAMILY_ORDER.length;

/** Point on the circle; angle 0 = 12 o'clock, clockwise. */
function polar(r: number, a: number): [number, number] {
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
}

function slicePath(i: number): string {
  const a0 = i * SLICE - SLICE / 2;
  const a1 = a0 + SLICE;
  const [x0, y0] = polar(R_OUT, a0);
  const [x1, y1] = polar(R_OUT, a1);
  const [x2, y2] = polar(R_IN, a1);
  const [x3, y3] = polar(R_IN, a0);
  return `M${x0} ${y0} A${R_OUT} ${R_OUT} 0 0 1 ${x1} ${y1} L${x2} ${y2} A${R_IN} ${R_IN} 0 0 0 ${x3} ${y3} Z`;
}

/** Dark text on the light families (joy, trust, amber), white elsewhere. */
function inkFor(family: PlutchikFamily): string {
  return family === 'joy' || family === 'trust' || family === 'anticipation' ? '#1f1f1f' : '#fff';
}

export default function EmotionWheel({
  selected,
  onSelect,
  onRandom,
  disabled = false,
  size = 300,
}: EmotionWheelProps) {
  const activate = (e: React.KeyboardEvent, fn: () => void) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };

  return (
    <Box
      component="svg"
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      role="group"
      aria-label="Emotion wheel"
      sx={{
        width: size,
        height: size,
        display: 'block',
        mx: 'auto',
        opacity: disabled ? 0.5 : 1,
        transition: 'opacity 200ms ease',
        userSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        '& .slice': { cursor: disabled ? 'default' : 'pointer', transition: 'opacity 150ms ease' },
        '& .slice:focus-visible path': { stroke: 'currentColor', strokeWidth: 3 },
        '& .slice:focus': { outline: 'none' },
      }}
    >
      {FAMILY_ORDER.map((family, i) => {
        const isSel = selected === family;
        const dim = selected !== null && !isSel;
        const [ex, ey] = polar(R_IN + (R_OUT - R_IN) * 0.4, i * SLICE);
        const [lx, ly] = polar(R_IN + (R_OUT - R_IN) * 0.76, i * SLICE);
        // "Anticipation" is too wide for a slice at 11 px and spills past
        // the outer edge onto the sheet background (unreadable dark-on-dark).
        const labelSize = FAMILY_LABELS[family].length > 8 ? 9.5 : 11;
        return (
          <g
            key={family}
            className="slice"
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-pressed={isSel}
            aria-label={`${FAMILY_LABELS[family]}, ${COUNT_BY_FAMILY[family]} emotions`}
            onClick={() => !disabled && onSelect(family)}
            onKeyDown={(e) => !disabled && activate(e, () => onSelect(family))}
            opacity={dim ? 0.45 : 1}
          >
            <path
              d={slicePath(i)}
              fill={FAMILY_COLORS[family]}
              stroke="rgba(0,0,0,0.25)"
              strokeWidth={isSel ? 0 : 1}
              transform={isSel ? `translate(${polar(6, i * SLICE)[0] - C} ${polar(6, i * SLICE)[1] - C})` : undefined}
            />
            <text x={ex} y={ey} textAnchor="middle" dominantBaseline="central" fontSize={28} aria-hidden>
              {FAMILY_EMOJIS[family]}
            </text>
            <text
              x={lx}
              y={ly}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={labelSize}
              fontWeight={700}
              fill={inkFor(family)}
              aria-hidden
            >
              {FAMILY_LABELS[family]}
            </text>
          </g>
        );
      })}
      <g
        className="slice"
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={selected ? `Random ${FAMILY_LABELS[selected]} emotion` : 'Random emotion'}
        onClick={() => !disabled && onRandom()}
        onKeyDown={(e) => !disabled && activate(e, onRandom)}
      >
        <circle cx={C} cy={C} r={R_IN - 6} fill="#fff" stroke="rgba(0,0,0,0.15)" />
        <text x={C} y={C} textAnchor="middle" dominantBaseline="central" fontSize={34} aria-hidden>
          🎲
        </text>
      </g>
    </Box>
  );
}
