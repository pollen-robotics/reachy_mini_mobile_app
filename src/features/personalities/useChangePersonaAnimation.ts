/**
 * Persona-change animation.
 *
 * Plays a short (~2 s) recorded "change-personality" choreography on the
 * robot whenever the user switches Reachy's active personality, as a bit
 * of physical feedback that the swap landed.
 *
 * Constraints / why it's this simple:
 *   - We only fire when the transport is `live` AND no conversation is
 *     running (`idle`). Persona switching happens from the picker, which
 *     is only reachable while idle, so there's no live wobbler / antenna
 *     oscillator to fight - we can stream `set_full_target` frames
 *     straight to the robot via a standalone `MovePlayer` without the
 *     engine's move-gating coordination.
 *   - The move JSON lives in the public HF dataset
 *     `tfrere/reachy-personalities` (RecordedMove format), so the same
 *     client-side player used for dances/emotions can stream it.
 */
import { useEffect, useRef } from "react";

import { MovePlayer } from "@/features/conversation/motion/move-player";
import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";
import { useActivePersonality } from "./store";

/** Source of the persona-change choreography (public dataset). */
const PERSONA_CHANGE_MOVE = {
  dataset: "tfrere/reachy-personalities",
  /** Path in the repo, INCLUDING the `.json` extension. */
  path: "data/change-personality.json",
} as const;

const HF_DATASET_BASE = "https://huggingface.co/datasets";

/** Build a dataset `resolve/main` URL, encoding each path segment but
 *  keeping the slashes (the move file lives under `data/`). */
function buildMoveUrl(dataset: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${HF_DATASET_BASE}/${dataset}/resolve/main/${encoded}`;
}

interface ChangePersonaAnimationParams {
  /** Live SDK accessor (null in any pre-connect / torn-down state). */
  getRobot: () => ReachyMiniInstance | null;
  /** True when the WebRTC transport is up (robot reachable). */
  isLive: boolean;
  /** True when no AI conversation is running (so nothing else drives
   *  the robot's pose). */
  isIdle: boolean;
}

export function useChangePersonaAnimation({
  getRobot,
  isLive,
  isIdle,
}: ChangePersonaAnimationParams): void {
  const activePersonaId = useActivePersonality().id;
  const previousIdRef = useRef<string | null>(null);
  // Reused player, re-created when the underlying SDK ref changes (e.g.
  // after a reconnect). Cached move JSON survives across plays.
  const playerRef = useRef<{
    robot: ReachyMiniInstance;
    player: MovePlayer;
  } | null>(null);

  useEffect(() => {
    const previous = previousIdRef.current;
    previousIdRef.current = activePersonaId;

    if (previous === null) return; // first render: nothing changed yet
    if (previous === activePersonaId) return; // no actual switch
    if (!isLive || !isIdle) return; // only when live + no conversation

    const robot = getRobot();
    if (!robot) return;

    if (!playerRef.current || playerRef.current.robot !== robot) {
      playerRef.current = { robot, player: new MovePlayer(robot) };
    }
    const { player } = playerRef.current;

    const url = buildMoveUrl(PERSONA_CHANGE_MOVE.dataset, PERSONA_CHANGE_MOVE.path);
    void player.playUrl("persona-change", url).catch((err) => {
      console.warn("[persona-fx] change-personality animation failed:", err);
    });
  }, [activePersonaId, isLive, isIdle, getRobot]);

  // Stop any in-flight choreography on unmount so the 100Hz worker
  // interval never outlives the screen.
  useEffect(() => {
    return () => {
      playerRef.current?.player.stop();
    };
  }, []);
}
