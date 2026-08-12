import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Box, Stack, Typography, useTheme } from '@mui/material';
import { Canvas } from '@react-three/fiber';
import type { Vector3Tuple } from 'three';

import ReachyModel from './ReachyModel';
import type { LivePose } from './useRobotPose';

export interface ReachyVizProps {
  /**
   * Pose source, read every frame (not subscribed). Build it with
   * `useRobotPose(session)` for a live mirror or `useStaticPose(pose)` for a
   * fixed reference pose (e.g. sleep).
   */
  poseRef: React.RefObject<LivePose>;
  /** Height of the canvas box. Width always fills the parent. */
  height?: number | string;
  /** Optional caption rendered under the canvas. */
  label?: string;
  /** Camera placement (metres, model frame). Defaults to the desktop preset. */
  cameraPosition?: Vector3Tuple;
  /** Point the camera looks at. */
  cameraTarget?: Vector3Tuple;
  /** Fired once when the model is loaded and settled on its first pose (i.e.
   *  the moment the viz becomes visible). Lets a parent gate its own UI on the
   *  viz being ready. */
  onReady?: () => void;
  /**
   * When `false`, the render loop runs on-demand instead of every frame: the
   * model snaps to its pose, renders once (plus on resize / dark-mode change),
   * then idles. Use it for static reference vizzes (e.g. a fixed sleep target)
   * that never move - it drops the per-frame IK + GPU cost to ~zero. Defaults
   * to `true` (continuous) for live, smoothly-interpolated poses.
   */
  animate?: boolean;
  /**
   * Optional target "ghost": a second model posed from this ref and rendered in
   * the SAME scene as a translucent tinted silhouette. Because both share the
   * model frame, alignment is pixel-perfect and the opaque live robot occludes
   * the ghost wherever they match - so it reads as "move the robot onto the
   * target". Used by the sleep-pose check on the first wake-up step.
   */
  ghostPoseRef?: React.RefObject<LivePose>;
  /** Ghost tint (CSS/hex); change it live, e.g. orange -> green when matched. */
  ghostColor?: string;
  /** Ghost dissolve (0 = solid, 1 = dissolved away; eased). Shader-based fade
   *  that keeps the surface opaque instead of going translucent. */
  ghostDissolve?: number;
  /** Target x-offset (scene units) for the live model; eased. Used to slide the
   *  live robot left of its target, then recentre it when matched. */
  offsetX?: number;
  /** Target x-offset (scene units) for the ghost model; eased. */
  ghostOffsetX?: number;
  /** Extra yaw (radians) applied to both models for a 3/4 view without moving
   *  the camera. Defaults to 0 (front-facing). */
  yawOffset?: number;
}

// Based on the desktop viewer's "normal" preset (Viewer3D.tsx CAMERA_PRESETS),
// pulled ~20% closer to the target so the robot fills more of the canvas.
const DEFAULT_CAMERA_POSITION: Vector3Tuple = [-0.245, 0.35, 0.53];
const DEFAULT_CAMERA_TARGET: Vector3Tuple = [0, 0.2, 0];
const DEFAULT_FOV = 50;

// Extra beat after the first valid pose before revealing the viz, so the
// smoothing has settled and we never show the robot mid-snap.
const REVEAL_SETTLE_MS = 500;

/**
 * 3D view of the robot: renders the rigged glb (head, body yaw, antennas,
 * articulated neck) driven by whatever pose the `poseRef` carries. Transparent
 * background so it blends into the surrounding surface.
 */
function ReachyViz({
  poseRef,
  height = 300,
  label,
  cameraPosition = DEFAULT_CAMERA_POSITION,
  cameraTarget = DEFAULT_CAMERA_TARGET,
  onReady,
  animate = true,
  ghostPoseRef,
  ghostColor,
  ghostDissolve,
  offsetX = 0,
  ghostOffsetX = 0,
  yawOffset = 0,
}: ReachyVizProps): React.ReactElement {
  // R3F doesn't bridge the outer MUI theme context into the Canvas, so resolve
  // dark mode here and pass it down as a plain prop.
  const isDark = useTheme().palette.mode === 'dark';
  // Keep the canvas hidden until the model has applied a real pose. Otherwise
  // it flashes the default rest pose while the (live) feed warms up, showing
  // the robot in the wrong position. Static poses (sleep/awake) flip this on
  // the very first frame, so they still appear near-instantly. We always add a
  // short settle delay after the first pose so the exponential smoothing has
  // converged before the viz is revealed (no visible snap on reveal).
  const [poseReady, setPoseReady] = useState(false);
  const settleTimer = useRef<number | null>(null);
  const handleFirstPose = useCallback(() => {
    if (settleTimer.current !== null) return;
    settleTimer.current = window.setTimeout(() => setPoseReady(true), REVEAL_SETTLE_MS);
  }, []);
  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    },
    [],
  );

  // Notify the parent once the viz is loaded + settled (same moment it becomes
  // visible). Keep the latest callback in a ref so we don't re-fire on identity
  // changes.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    if (poseReady) onReadyRef.current?.();
  }, [poseReady]);
  return (
    <Stack spacing={0.5} sx={{ width: '100%', alignItems: 'center' }}>
      {/* Reserve the height so nothing jumps when the viz fades in. */}
      <Box
        sx={{
          width: '100%',
          height,
          opacity: poseReady ? 1 : 0,
          transition: 'opacity 0.35s ease',
        }}
        aria-hidden
      >
        <Canvas
          dpr={[1, 2]}
          frameloop={animate ? 'always' : 'demand'}
          gl={{ antialias: true, alpha: true, preserveDrawingBuffer: false }}
          camera={{ position: cameraPosition, fov: DEFAULT_FOV, near: 0.01, far: 50 }}
          onCreated={({ camera }) => camera.lookAt(...cameraTarget)}
        >
          <ambientLight intensity={0.6} />
          <directionalLight position={[2, 4, 2]} intensity={1.6} />
          <directionalLight position={[-2, 2, 1.5]} intensity={0.4} />
          <directionalLight position={[0, 3, -2]} intensity={0.7} color="#FFB366" />
          <Suspense fallback={null}>
            <ReachyModel
              poseRef={poseRef}
              isActive
              dark={isDark}
              animate={animate}
              offsetX={offsetX}
              yawOffset={yawOffset}
              onFirstPose={handleFirstPose}
            />
            {ghostPoseRef ? (
              <ReachyModel
                poseRef={ghostPoseRef}
                isActive
                dark={isDark}
                animate={animate}
                ghost
                ghostColor={ghostColor}
                ghostDissolve={ghostDissolve}
                offsetX={ghostOffsetX}
                yawOffset={yawOffset}
              />
            ) : null}
          </Suspense>
        </Canvas>
      </Box>
      {label && (
        <Typography
          variant="caption"
          sx={{
            textAlign: 'center',
            color: 'text.secondary',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            fontWeight: 600,
          }}
        >
          {label}
        </Typography>
      )}
    </Stack>
  );
}

export default ReachyViz;
