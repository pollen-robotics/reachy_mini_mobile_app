/**
 * Reaper for the SDK's leaked placeholder `AudioContext`.
 *
 * Every dial (`startSession()` and each auto-reconnect attempt, both of
 * which go through the private `_startSessionInternal`) builds a fresh
 * `AudioContext` driving a 0-gain oscillator into a
 * `MediaStreamDestination`, used as the initial WebRTC audio sender
 * track. The SDK's teardown stops that track but never closes the
 * context, so each context keeps a running output stream open.
 *
 * Chromium caps a renderer at 10 open output streams. Once the leaked
 * contexts eat the budget, the next `AudioContext` the app creates
 * (telepresence audio, mic level meters, ...) fails with "The
 * AudioContext encountered an error from the audio device" and stays
 * `suspended`, silently. Observed on Android after a Wi-Fi hiccup: one
 * redial plus a few busy-rejected retries leaked 5 contexts, and the
 * then phone-side conversation pipeline went deaf. Each leaked context
 * also keeps an oscillator running for the rest of the app's life.
 *
 * Workaround until the SDK closes the context itself: wrap the
 * instance's `_startSessionInternal` to capture the context it builds
 * (it is constructed synchronously, before the method's first
 * `await`), close the previous one before each new dial, and close the
 * current one on `sessionStopped`. Reaches into a private SDK method,
 * like `release-sdk-phone-mic.ts`; if the method is renamed this
 * becomes a no-op and the leak comes back.
 */

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

type DialFn = (robotId: string) => Promise<void>;

interface SdkInternals {
  _startSessionInternal?: DialFn;
}

export function installPlaceholderAudioReaper(robot: ReachyMiniInstance): void {
  const sdk = robot as unknown as SdkInternals;
  const dial = sdk._startSessionInternal;
  if (typeof dial !== 'function') return;

  let current: AudioContext | null = null;
  const closeCurrent = (): void => {
    const ctx = current;
    current = null;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
  };

  sdk._startSessionInternal = function (this: unknown, robotId: string) {
    // The previous session's transport is already torn down by the
    // time the SDK dials again (explicit restart or redial attempt).
    closeCurrent();
    const w = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Native = w.AudioContext ?? w.webkitAudioContext;
    if (!Native) return dial.call(this, robotId);
    const Capturing = function (...args: ConstructorParameters<typeof AudioContext>) {
      const ctx = new Native(...args);
      current = ctx;
      return ctx;
    } as unknown as typeof AudioContext;
    Capturing.prototype = Native.prototype;
    const hadStd = w.AudioContext !== undefined;
    if (hadStd) w.AudioContext = Capturing;
    else w.webkitAudioContext = Capturing;
    try {
      return dial.call(this, robotId);
    } finally {
      if (hadStd) w.AudioContext = Native;
      else w.webkitAudioContext = Native;
    }
  };

  robot.addEventListener('sessionStopped', closeCurrent);
}
