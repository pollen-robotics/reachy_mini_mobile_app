/**
 * Five-digit boxed PIN input with native mobile UX (one box per
 * digit, numeric keyboard, auto-advance, auto-submit, paste support).
 *
 * Used by the Wi-Fi setup screen and the Forget-Wi-Fi dialog. The
 * daemon's `BluetoothCommandService` accepts a hard-coded 5-digit PIN
 * (last 5 of the audio device serial - see `get_pin()` in
 * `bluetooth_service.py`), so:
 *
 *   - We render exactly 5 boxes, with `inputMode="numeric"` to
 *     trigger the digit pad on mobile.
 *   - Typing a digit auto-focuses the next box.
 *   - Backspace on an empty box jumps back and clears the previous.
 *   - Paste of a 5-digit string fills all boxes at once and triggers
 *     auto-submit.
 *   - Hitting the 5th digit calls `onComplete` immediately so the user
 *     never has to tap a "Continue" button: BLE auth is fast enough
 *     that any extra tap feels gratuitous.
 *
 * The component is fully controlled to keep the parent in charge of
 * loading / disabled states and reset semantics (the parent clears
 * the value to `""` after a successful auth, or after a wrong-PIN
 * error so the user starts fresh).
 */

import {
  useEffect,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { Stack, TextField } from '@mui/material';

import { FONT_WEIGHT, RADIUS } from './tokens';

const PIN_LENGTH = 5;

interface PinInputProps {
  /** Current PIN as plain digits (0..PIN_LENGTH chars). */
  value: string;
  /** Called whenever the value changes (including on paste / backspace). */
  onChange: (value: string) => void;
  /**
   * Called once the user has entered exactly `PIN_LENGTH` digits. The
   * caller is expected to send the PIN to the robot. We pass the
   * full PIN as the only argument so the consumer doesn't need to
   * read it back from a controlled state that may not have flushed.
   */
  onComplete: (pin: string) => void;
  /** Disable interaction (e.g. during the BLE auth round-trip). */
  disabled?: boolean;
  /** Render the boxes in the error palette + show an outline. */
  hasError?: boolean;
  /** Auto-focus the first box on mount. Defaults to `true`. */
  autoFocus?: boolean;
}

export default function PinInput({
  value,
  onChange,
  onComplete,
  disabled = false,
  hasError = false,
  autoFocus = true,
}: PinInputProps) {
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);
  const completeFiredFor = useRef<string | null>(null);

  // ─── Focus management ─────────────────────────────────────────
  useEffect(() => {
    if (!autoFocus) return;
    inputsRef.current[0]?.focus();
  }, [autoFocus]);

  // Auto-advance focus to the next empty box whenever the value
  // grows. We DON'T fight the user when they go back: explicit
  // backspace/click handles that path.
  useEffect(() => {
    const nextIdx = Math.min(value.length, PIN_LENGTH - 1);
    const target = inputsRef.current[nextIdx];
    // Only refocus when the active element is one of OUR boxes:
    // otherwise we'd steal focus from a parent that has its own
    // input (e.g. a future "Cancel" path).
    const active = document.activeElement;
    if (active instanceof HTMLElement && inputsRef.current.includes(active as HTMLInputElement)) {
      target?.focus();
    }
  }, [value]);

  // Auto-submit when the user reaches the last digit. We guard against
  // re-firing for the same value (StrictMode renders this effect twice
  // in dev), and against re-firing after the parent reset the value.
  useEffect(() => {
    if (disabled) return;
    if (value.length !== PIN_LENGTH) {
      completeFiredFor.current = null;
      return;
    }
    if (completeFiredFor.current === value) return;
    completeFiredFor.current = value;
    onComplete(value);
  }, [value, disabled, onComplete]);

  // ─── Handlers ─────────────────────────────────────────────────
  const setDigitAt = (idx: number, digit: string): void => {
    // Always work off the canonical value so two simultaneous
    // edits (rare but possible during fast typing on a slow phone)
    // can't desync.
    const chars = value.padEnd(PIN_LENGTH, ' ').split('');
    chars[idx] = digit;
    const next = chars.join('').replace(/ /g, '').slice(0, PIN_LENGTH);
    onChange(next);
  };

  const handleChange = (idx: number, raw: string): void => {
    // Mobile keyboards sometimes send the full input value back,
    // including the previously-typed digit. Normalise to the LAST
    // digit the user typed to keep the UX consistent.
    const digit = raw.replace(/\D/g, '').slice(-1);
    if (!digit) {
      setDigitAt(idx, '');
      return;
    }
    setDigitAt(idx, digit);
  };

  const handleKeyDown = (idx: number, e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Backspace') {
      // If the current box has a digit, clear it (default behaviour
      // would just unset the input but we want to keep our model
      // in sync).
      if (value[idx]) {
        e.preventDefault();
        setDigitAt(idx, '');
        return;
      }
      // Otherwise jump back and clear the previous box.
      if (idx > 0) {
        e.preventDefault();
        setDigitAt(idx - 1, '');
        inputsRef.current[idx - 1]?.focus();
      }
      return;
    }
    if (e.key === 'ArrowLeft' && idx > 0) {
      e.preventDefault();
      inputsRef.current[idx - 1]?.focus();
      return;
    }
    if (e.key === 'ArrowRight' && idx < PIN_LENGTH - 1) {
      e.preventDefault();
      inputsRef.current[idx + 1]?.focus();
      return;
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>): void => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, PIN_LENGTH);
    if (!pasted) return;
    e.preventDefault();
    onChange(pasted);
  };

  // ─── Render ───────────────────────────────────────────────────
  return (
    <Stack
      direction="row"
      spacing={1}
      justifyContent="center"
      sx={{ width: '100%' }}
    >
      {Array.from({ length: PIN_LENGTH }, (_, idx) => (
        <TextField
          key={idx}
          inputRef={(el: HTMLInputElement | null) => {
            inputsRef.current[idx] = el;
          }}
          value={value[idx] ?? ''}
          onChange={(e) => handleChange(idx, e.target.value)}
          onKeyDown={(e) => handleKeyDown(idx, e)}
          onPaste={handlePaste}
          // Select on focus so a tap immediately clears the existing
          // digit, mirroring native iOS/Android pin input behaviour.
          onFocus={(e) => e.target.select()}
          disabled={disabled}
          error={hasError}
          variant="outlined"
          slotProps={{
            htmlInput: {
              inputMode: 'numeric',
              pattern: '[0-9]*',
              autoComplete: 'one-time-code',
              maxLength: 1,
              'aria-label': `PIN digit ${idx + 1}`,
              style: {
                textAlign: 'center',
                fontSize: '1.5rem',
                fontWeight: FONT_WEIGHT.semibold,
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, monospace',
                padding: '12px 0',
                width: 44,
              },
            },
          }}
          sx={{
            width: 52,
            '& .MuiOutlinedInput-root': {
              borderRadius: `${RADIUS.md}px`,
            },
          }}
        />
      ))}
    </Stack>
  );
}

/** Length of the PIN expected by the daemon. Exported for callers
 * that want to display "5 digits" in helper text without duplicating
 * the constant. */
export const PIN_INPUT_LENGTH = PIN_LENGTH;
