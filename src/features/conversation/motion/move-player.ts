/**
 * Move player - streams Reachy Mini recorded choreographies on the WebRTC
 * data channel as `set_full_target` frames.
 *
 * Why not just ask the daemon to play a move by name?
 *   The daemon *does* expose `POST /api/move/play/recorded-move-dataset/{ds}/
 *   {move}` which plays a RecordedMove internally (see `move.py` on the
 *   daemon, and `pollen-robotics/reachy-mini-{dances,emotions}-library` HF
 *   datasets it preloads at boot). But that endpoint is HTTP on the robot's
 *   LAN, which a browser running on `https://*.hf.space` can't reach (mixed
 *   content, no DNS). The WebRTC data channel protocol does not have a
 *   `play_dance` command either (`PlayMoveTaskRequest not yet implemented
 *   over WS`). So we replicate what the daemon does internally: fetch the
 *   move JSON from the public HF CDN, evaluate it client-side at 100 Hz,
 *   and stream each frame as `set_full_target`.
 *
 * What the JSON looks like (recorded move, see `RecordedMove` in
 * `reachy_mini/motion/recorded_move.py`):
 *   {
 *     description: string,
 *     time: number[],                          // seconds, monotonically increasing
 *     set_target_data: Array<{
 *       head: number[4][4],                    // 4x4 pose (last row may be [0,0,0,0] in some files)
 *       antennas: [right_rad, left_rad],
 *       body_yaw: number,
 *       check_collision: boolean | null,
 *     }>
 *   }
 *
 * Two gotchas this module handles:
 *   1. The datasets in the wild have `[0,0,0,0]` as the last row of `head`
 *      instead of `[0,0,0,1]`. We clean that up before sending so the wire
 *      payload is a proper homogeneous matrix.
 *   2. Rotations must be interpolated on the rotation group (SE(3)), not
 *      elementwise - otherwise the intermediate matrices aren't orthogonal
 *      and the IK picks up weird shear. We port the daemon's
 *      `linear_pose_interpolation` (axis-angle slerp) to TypeScript.
 */

import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";
import { createUnthrottledInterval } from "./unthrottled-interval";

const HF_DATASET_BASE = "https://huggingface.co/datasets";
const STREAM_HZ = 100;

// ─── Curated catalog ────────────────────────────────────────────────────

/**
 * A single entry the LLM can pick from. `id` is the opaque identifier used
 * in tool calls; we map it to a dataset + file stem at playback time.
 */
export interface MoveCatalogEntry {
  readonly id: string;
  readonly kind: "dance" | "emotion";
  readonly dataset: string;
  readonly file: string;
  readonly description: string;
}

/**
 * Curated selection exposed to the model: a handful of dances for
 * rhythmic/punctuating moments, and a handful of emotions for reactive
 * body language. Ordered roughly by how often we expect them to be useful.
 */
export const MOVE_CATALOG: readonly MoveCatalogEntry[] = [
  // Dances - rhythmic, expressive, ~1-2s
  {
    id: "yeah_nod",
    kind: "dance",
    dataset: "pollen-robotics/reachy-mini-dances-library",
    file: "yeah_nod",
    description: "A confident, rhythmic nod - agreement, affirmation.",
  },
  {
    id: "uh_huh_tilt",
    kind: "dance",
    dataset: "pollen-robotics/reachy-mini-dances-library",
    file: "uh_huh_tilt",
    description: "Curious acknowledgement, small sidelong tilt.",
  },
  {
    id: "side_peekaboo",
    kind: "dance",
    dataset: "pollen-robotics/reachy-mini-dances-library",
    file: "side_peekaboo",
    description: "Playful peek from the side - teasing moments.",
  },
  {
    id: "dizzy_spin",
    kind: "dance",
    dataset: "pollen-robotics/reachy-mini-dances-library",
    file: "dizzy_spin",
    description: "Dizzy spin - for lighthearted, silly replies.",
  },
  {
    id: "groovy_sway",
    kind: "dance",
    dataset: "pollen-robotics/reachy-mini-dances-library",
    file: "groovy_sway_and_roll",
    description: "Grooving sway and roll - when the conversation gets musical.",
  },
  {
    id: "chicken_peck",
    kind: "dance",
    dataset: "pollen-robotics/reachy-mini-dances-library",
    file: "chicken_peck",
    description: "Sharp forward pecks - lively and percussive.",
  },

  // Emotions - reactive, affective, 1-4s
  {
    id: "cheerful",
    kind: "emotion",
    dataset: "pollen-robotics/reachy-mini-emotions-library",
    file: "cheerful1",
    description: "Bright, upbeat body language - praise, small wins.",
  },
  {
    id: "surprised",
    kind: "emotion",
    dataset: "pollen-robotics/reachy-mini-emotions-library",
    file: "surprised1",
    description: "Startled, a tiny recoil - when something unexpected happens.",
  },
  {
    id: "curious",
    kind: "emotion",
    dataset: "pollen-robotics/reachy-mini-emotions-library",
    file: "curious1",
    description: "Inquisitive gaze shift - investigating, asking.",
  },
  {
    id: "amazed",
    kind: "emotion",
    dataset: "pollen-robotics/reachy-mini-emotions-library",
    file: "amazed1",
    description: "In awe, long upward look - genuine wonder.",
  },
  {
    id: "confused",
    kind: "emotion",
    dataset: "pollen-robotics/reachy-mini-emotions-library",
    file: "confused1",
    description: "Hesitant head tilt - when something doesn't compute.",
  },
  {
    id: "proud",
    kind: "emotion",
    dataset: "pollen-robotics/reachy-mini-emotions-library",
    file: "proud1",
    description: "Chin up, chest out - taking credit, feeling good.",
  },
  {
    id: "shy",
    kind: "emotion",
    dataset: "pollen-robotics/reachy-mini-emotions-library",
    file: "shy1",
    description: "Small look-away - embarrassed, modest.",
  },
  {
    id: "sad",
    kind: "emotion",
    dataset: "pollen-robotics/reachy-mini-emotions-library",
    file: "sad1",
    description: "Subtle downward look - sympathy, bad news.",
  },
];

export type MoveId = (typeof MOVE_CATALOG)[number]["id"];

export const MOVE_IDS: readonly MoveId[] = MOVE_CATALOG.map((m) => m.id);

function findMove(id: string): MoveCatalogEntry | undefined {
  return MOVE_CATALOG.find((m) => m.id === id);
}

// ─── File format & loading ──────────────────────────────────────────────

interface RawFrame {
  head: number[][];
  antennas: [number, number];
  body_yaw: number;
}

interface MoveFile {
  description: string;
  time: number[];
  set_target_data: RawFrame[];
}

interface LoadedMove {
  readonly id: MoveId;
  readonly description: string;
  readonly duration: number;
  readonly times: readonly number[];
  readonly frames: readonly RawFrame[];
}

// ─── SE(3) interpolation ────────────────────────────────────────────────
//
// Ported from `linear_pose_interpolation` in
// reachy_mini/utils/interpolation.py. Rotations are slerp'd via quaternions;
// translations are linearly interpolated.

type Quat = readonly [number, number, number, number]; // [x, y, z, w]

/** Extract a unit quaternion from the top-left 3x3 of a 4x4 homogeneous matrix. */
function quatFromMatrix(m: readonly number[][]): Quat {
  const m00 = m[0][0], m01 = m[0][1], m02 = m[0][2];
  const m10 = m[1][0], m11 = m[1][1], m12 = m[1][2];
  const m20 = m[2][0], m21 = m[2][1], m22 = m[2][2];
  const trace = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const len = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
  return [x / len, y / len, z / len, w / len];
}

/** Convert a unit quaternion to a 3x3 rotation matrix (flat row-major). */
function quatToRot3(q: Quat): number[] {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy),
  ];
}

/** Spherical linear interpolation between two unit quaternions. */
function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  const [ax, ay, az, aw] = a;
  let [bx, by, bz, bw] = b;
  // Pick the shorter arc by flipping b if needed.
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
    dot = -dot;
  }
  // Fall back to lerp when quaternions are nearly colinear, to avoid div/0.
  if (dot > 0.9995) {
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    const z = az + (bz - az) * t;
    const w = aw + (bw - aw) * t;
    const len = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
    return [x / len, y / len, z / len, w / len];
  }
  const theta0 = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sinTheta0 = Math.sin(theta0);
  const theta = theta0 * t;
  const s1 = Math.sin(theta) / sinTheta0;
  const s0 = Math.cos(theta) - dot * s1;
  return [
    ax * s0 + bx * s1,
    ay * s0 + by * s1,
    az * s0 + bz * s1,
    aw * s0 + bw * s1,
  ];
}

/**
 * Interpolate a full 4x4 pose at parameter `t` in [0, 1] between two
 * recorded frames. Output is a flat 16-float row-major homogeneous matrix
 * with a well-formed `[0,0,0,1]` last row.
 */
function interpolateHeadFlat(
  a: readonly number[][],
  b: readonly number[][],
  t: number,
): number[] {
  const rot = quatToRot3(quatSlerp(quatFromMatrix(a), quatFromMatrix(b), t));
  // Translation is always 0 in the recorded dances, but we still lerp in
  // case a future dataset uses it.
  const tx = a[0][3] + (b[0][3] - a[0][3]) * t;
  const ty = a[1][3] + (b[1][3] - a[1][3]) * t;
  const tz = a[2][3] + (b[2][3] - a[2][3]) * t;
  return [
    rot[0], rot[1], rot[2], tx,
    rot[3], rot[4], rot[5], ty,
    rot[6], rot[7], rot[8], tz,
    0, 0, 0, 1,
  ];
}

/** Same cleanup applied to a frame served as-is (no interpolation). */
function headFlatFromFrame(m: readonly number[][]): number[] {
  // Re-normalize the rotation block via quat roundtrip - this also scrubs
  // the degenerate `[0,0,0,0]` last row found in the dataset.
  const rot = quatToRot3(quatFromMatrix(m));
  return [
    rot[0], rot[1], rot[2], m[0][3] ?? 0,
    rot[3], rot[4], rot[5], m[1][3] ?? 0,
    rot[6], rot[7], rot[8], m[2][3] ?? 0,
    0, 0, 0, 1,
  ];
}

// ─── Player ─────────────────────────────────────────────────────────────

/**
 * Streams moves to the robot one at a time. Load-once / play-many: fetched
 * JSON is cached in memory for the session.
 */
export class MovePlayer {
  private readonly robot: ReachyMiniInstance;
  private readonly cache = new Map<string, LoadedMove>();
  private timer: { clear: () => void } | null = null;
  private current: { move: LoadedMove; t0: number } | null = null;
  private onFinish: (() => void) | null = null;

  constructor(robot: ReachyMiniInstance) {
    this.robot = robot;
  }

  /** True while a move is actively streaming. */
  get isPlaying(): boolean {
    return this.current !== null;
  }

  /**
   * Fetch (or hit cache) the trajectory JSON and return the parsed move.
   * Safe to call ahead of time to prewarm a move that's likely to play.
   */
  async load(id: MoveId): Promise<LoadedMove> {
    const cached = this.cache.get(id);
    if (cached) return cached;

    const entry = findMove(id);
    if (!entry) throw new Error(`Unknown move id '${id}'`);

    const url = `${HF_DATASET_BASE}/${entry.dataset}/resolve/main/${encodeURIComponent(entry.file)}.json`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch move '${id}' from ${entry.dataset}: ${response.status} ${response.statusText}`,
      );
    }
    const raw = (await response.json()) as MoveFile;
    if (!Array.isArray(raw.time) || !Array.isArray(raw.set_target_data)) {
      throw new Error(`Malformed move file '${id}'`);
    }
    if (raw.time.length !== raw.set_target_data.length) {
      throw new Error(`Move '${id}' has mismatched time/frame lengths`);
    }

    const move: LoadedMove = {
      id,
      description: raw.description ?? entry.description,
      times: raw.time.slice(),
      frames: raw.set_target_data,
      duration: raw.time[raw.time.length - 1] ?? 0,
    };
    this.cache.set(id, move);
    return move;
  }

  /**
   * Play a move. If another move is already streaming it is cancelled
   * first. Resolves when the move finishes (or is cancelled via `stop()`).
   */
  async play(id: MoveId): Promise<void> {
    const move = await this.load(id);
    this.stop();

    return new Promise<void>((resolve) => {
      this.onFinish = resolve;
      this.current = { move, t0: performance.now() / 1000 };
      // Worker-backed interval so the 100Hz pose stream keeps pushing
      // frames to the robot even when the window loses focus (plain
      // setInterval gets clamped to ~1Hz on unfocused tabs, which makes
      // canned moves play back in slow-motion).
      this.timer = createUnthrottledInterval(
        () => this.tick(),
        1000 / STREAM_HZ,
      );
    });
  }

  /** Abort playback immediately. Safe to call when idle. */
  stop(): void {
    if (this.timer !== null) {
      this.timer.clear();
      this.timer = null;
    }
    const cb = this.onFinish;
    this.current = null;
    this.onFinish = null;
    if (cb) cb();
  }

  // ─── internals ──────────────────────────────────────────────────────

  private tick(): void {
    if (!this.current) return;
    const { move, t0 } = this.current;
    const t = performance.now() / 1000 - t0;

    if (t >= move.duration) {
      // Snap to the final frame for a clean landing before stopping.
      const last = move.frames[move.frames.length - 1];
      this.sendFrame(headFlatFromFrame(last.head), last.antennas, last.body_yaw);
      this.stop();
      return;
    }

    const sample = sampleAt(move, t);
    this.sendFrame(sample.head, sample.antennas, sample.body_yaw);
  }

  private sendFrame(
    headFlat: number[],
    antennas: readonly [number, number],
    bodyYaw: number,
  ): void {
    this.robot.sendRaw({
      type: "set_full_target",
      head: headFlat,
      antennas: [antennas[0], antennas[1]],
      body_yaw: bodyYaw,
    });
  }
}

// ─── Sampling ───────────────────────────────────────────────────────────

interface SampledFrame {
  head: number[]; // flat row-major 4x4
  antennas: [number, number];
  body_yaw: number;
}

function sampleAt(move: LoadedMove, t: number): SampledFrame {
  const { times, frames } = move;
  const n = times.length;
  if (n === 0) {
    return { head: identity4Flat(), antennas: [0, 0], body_yaw: 0 };
  }
  if (t <= times[0]) {
    return {
      head: headFlatFromFrame(frames[0].head),
      antennas: frames[0].antennas,
      body_yaw: frames[0].body_yaw,
    };
  }
  if (t >= times[n - 1]) {
    const last = frames[n - 1];
    return {
      head: headFlatFromFrame(last.head),
      antennas: last.antennas,
      body_yaw: last.body_yaw,
    };
  }

  // Binary search for the bracket [i, i+1] with times[i] <= t < times[i+1].
  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const ta = times[lo];
  const tb = times[lo + 1];
  const alpha = tb > ta ? (t - ta) / (tb - ta) : 0;

  const a = frames[lo];
  const b = frames[lo + 1];
  return {
    head: interpolateHeadFlat(a.head, b.head, alpha),
    antennas: [
      a.antennas[0] + (b.antennas[0] - a.antennas[0]) * alpha,
      a.antennas[1] + (b.antennas[1] - a.antennas[1]) * alpha,
    ],
    body_yaw: a.body_yaw + (b.body_yaw - a.body_yaw) * alpha,
  };
}

function identity4Flat(): number[] {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}
