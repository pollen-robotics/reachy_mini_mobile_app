import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

import glbUrl from '@/assets/robot-3d/reachy_mini_viz.glb?url';
import type { LivePose } from './useRobotPose';

// Draco-compressed glb; decoder vendored at public/draco (the app ships
// offline, so we can't rely on drei's default CDN decoder path).
const DRACO_PATH = '/draco/';
useGLTF.preload(glbUrl, DRACO_PATH);

// ============================================================================
// Ported from the desktop app's GLTFRobot (PR #287). The glb is exported Z-up
// (the robot's native frame), so head_pose applies directly. The only change
// here is the input: instead of re-rendering on every pose prop, we read a
// live-pose ref and exponentially smooth it in the render loop, so a ~12 Hz
// data feed still looks fluid at 60 fps.
// ============================================================================
// The glb was modeled ~3x real scale; bring it to the URDF's metres.
const MODEL_SCALE = 0.5;
// Yaw to align the glb's forward with the URDF facing.
const DISPLAY_YAW = -Math.PI;
// head_pose translation (metres) -> model units.
const UNITS_PER_M = 1.7;
// Platform head-Z reach measured from the rig (model units, rel. to rest).
const HEAD_Z_MAX = 0.044;
const HEAD_Z_MIN = -0.085;
// Robot frame (X-fwd, Y-left, Z-up) -> glb model frame: proper change of basis
// R_model = M*R*M^-1 (det +1, no reflection), M = Rz(+90).
const HEAD_FRAME_YAW_OFFSET = Math.PI / 2;
const HEAD_FIX = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(0, 0, 1),
  HEAD_FRAME_YAW_OFFSET,
);
const HEAD_FIX_INV = HEAD_FIX.clone().invert();
const YAW_SIGN = 1;
const ANT_AXIS = new THREE.Vector3(0, 0, 1); // antenna hinge axis in glb space
const ANT_SIGN = -1;

// The two flexible antennas are the only skinned meshes in the glb; they use a
// near-black, highly-metallic material ('Metal.Black'). With no environment map
// a metallic surface renders almost pure black, so on the viz's transparent
// background the antennas vanish in dark mode. In dark mode we tint them a mid
// grey and drop the metalness so the grey actually shows (metallic materials
// suppress diffuse color). The clone (see effect) keeps this scoped to the
// antennas and to this model instance.
const DARK_ANTENNA_COLOR = '#8f8f8f';
const DARK_ANTENNA_METALNESS = 0.2;

// Ghost tinting: keep each part's ORIGINAL material (so the robot's real
// colours/details still read) and only nudge its base colour a touch toward the
// target tint - a hint (orange, or green when matched), not a flat monochrome
// override. Each material stores its untinted base colour so re-tinting never
// compounds. The dissolve fade is injected per-material (see setup effect).
const GHOST_TINT_MIX = 0.28;
const applyGhostTint = (mats: THREE.MeshStandardMaterial[], color: string): void => {
  const c = new THREE.Color(color);
  for (const m of mats) {
    const orig = m.userData.__ghostOrigColor as THREE.Color | undefined;
    if (orig) m.color.copy(orig).lerp(c, GHOST_TINT_MIX);
  }
};

// Exponential smoothing rate (1/s). Higher = snappier, lower = smoother.
const SMOOTH_K = 15;
// Slower rate for the layout transition (x-offset slide + ghost fade) so the
// "split apart / recentre when matched" reads as a deliberate move, not a snap.
const TRANSITION_K = 5;

// Bone node names (verified present in the exported glb).
const BONE = {
  body: 'Core',
  head: 'Core.001',
  antL: 'Antenna.L.002',
  antR: 'Antenna.R.002',
} as const;

function toMatrix(p: number[] | null | undefined): THREE.Matrix4 | null {
  if (!p || p.length !== 16) return null;
  // row-major (robot) -> three is column-major, so transpose.
  return new THREE.Matrix4().fromArray(p).transpose();
}

// GLTFLoader sanitizes '.' out of node names ("Core.001" -> "Core001"),
// so look bones up by a normalized key.
const norm = (s: string): string => s.replace(/[^a-z0-9]/gi, '').toLowerCase();

// --- Neck leg IK -----------------------------------------------------------
// Each leg is a 4-bone chain that IK-solves in Blender so its tip reaches a
// target riding on the head. glTF can't carry that, so we re-solve it here with
// a small CCD pass.
const LEG_IDS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
const LEG_IK_ITERATIONS = 12;
type Dof = 'free' | 'hingeX' | 'locked';
const LEG_DOF: Dof[] = ['locked', 'hingeX', 'locked', 'free'];
const HINGE_AXIS = new THREE.Vector3(1, 0, 0);

interface LegChain {
  chain: THREE.Object3D[];
  restQ: THREE.Quaternion[];
  effector: THREE.Object3D;
  target: THREE.Object3D;
}

function setupLeg(
  id: string,
  byName: Record<string, THREE.Object3D>,
  head: THREE.Object3D,
): LegChain | null {
  const chain = ['001', '002', '003', '004'].map(s => byName[norm(`Neck.${id}.${s}`)]);
  const ikTarget = byName[norm(`Neck.loc.IK.${id}`)];
  if (chain.some(b => !b) || !ikTarget) {
    console.warn(`[ReachyModel] leg ${id}: missing bones, IK skipped`);
    return null;
  }
  const attach = ikTarget.getWorldPosition(new THREE.Vector3());
  const effector = new THREE.Object3D();
  chain[3]!.add(effector);
  effector.position.copy(chain[3]!.worldToLocal(attach.clone()));
  const target = new THREE.Object3D();
  head.add(target);
  target.position.copy(head.worldToLocal(attach.clone()));
  const restQ = chain.map(b => b!.quaternion.clone());
  return { chain: chain as THREE.Object3D[], restQ, effector, target };
}

// CCD scratch (module-level, no per-frame allocation). Safe because a single
// viewer instance is on screen at a time and solveLeg runs synchronously.
const _jp = new THREE.Vector3();
const _ep = new THREE.Vector3();
const _tp = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _hw = new THREE.Vector3();
const _cx = new THREE.Vector3();
const _qr = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _qp = new THREE.Quaternion();

function solveLeg(leg: LegChain, iterations: number): void {
  for (let i = 0; i < leg.chain.length; i++) leg.chain[i]!.quaternion.copy(leg.restQ[i]!);
  leg.chain[0]!.updateWorldMatrix(false, true);
  leg.target.getWorldPosition(_tp);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < leg.chain.length; i++) {
      const dof = LEG_DOF[i];
      if (dof === 'locked') continue;
      const joint = leg.chain[i]!;
      leg.effector.getWorldPosition(_ep);
      if (_ep.distanceToSquared(_tp) < 1e-8) return;
      joint.getWorldPosition(_jp);
      joint.getWorldQuaternion(_qw);
      if (dof === 'free') {
        _v1.subVectors(_ep, _jp).normalize();
        _v2.subVectors(_tp, _jp).normalize();
        _qr.setFromUnitVectors(_v1, _v2);
      } else {
        _hw.copy(HINGE_AXIS).applyQuaternion(_qw).normalize();
        _v1.subVectors(_ep, _jp).projectOnPlane(_hw);
        _v2.subVectors(_tp, _jp).projectOnPlane(_hw);
        if (_v1.lengthSq() < 1e-12 || _v2.lengthSq() < 1e-12) continue;
        _v1.normalize();
        _v2.normalize();
        const ang = Math.atan2(_cx.crossVectors(_v1, _v2).dot(_hw), _v1.dot(_v2));
        _qr.setFromAxisAngle(_hw, ang);
      }
      _qr.multiply(_qw);
      joint.parent?.getWorldQuaternion(_qp);
      joint.quaternion.copy(_qp.invert().multiply(_qr));
      joint.updateWorldMatrix(false, true);
    }
  }
}

export interface ReachyModelProps {
  /** Live pose ref, read (not subscribed) every frame. */
  poseRef: React.RefObject<LivePose>;
  isActive?: boolean;
  /** Tint the antennas grey so they don't disappear on a dark background. */
  dark?: boolean;
  /**
   * When `false` (on-demand render loop), the model snaps to its pose in a
   * single scheduled frame and we don't rely on continuous frames: request a
   * render whenever the model (re)mounts or its appearance changes. Defaults to
   * `true`.
   */
  animate?: boolean;
  /**
   * Render as a translucent tinted "ghost" (target) silhouette instead of the
   * normal shaded robot: every mesh gets a single unlit tinted material with
   * `depthWrite` off. Drawn after the opaque live robot in the same scene, so
   * depth-testing hides the ghost wherever the live robot is in front - the two
   * visually merge as the live pose converges on the target.
   */
  ghost?: boolean;
  /** Ghost tint (CSS/hex). Change it live, e.g. orange -> green when matched. */
  ghostColor?: string;
  /** Ghost dissolve amount (0 = fully materialised, 1 = fully dissolved away).
   *  Eased in the frame loop. A shader discards fragments (with a glowing edge)
   *  rather than lowering opacity, so the fade never turns the model
   *  translucent and never reveals its interior. */
  ghostDissolve?: number;
  /** Target horizontal offset (scene units); the model eases toward it. Used to
   *  split the live robot and its target ghost apart, then recentre the live
   *  robot when the two align. Defaults to 0 (centred). */
  offsetX?: number;
  /** Extra yaw (radians) added to the base display orientation, to show the
   *  robot at a 3/4 angle without moving the camera (keeps the front-on split
   *  symmetric). Defaults to 0 (front-facing). */
  yawOffset?: number;
  onReady?: () => void;
  /**
   * Fired exactly once, the first time a *valid* head pose is actually applied
   * (i.e. `poseRef` carries a real matrix). Lets the host keep the canvas
   * hidden until the model reflects the robot's true position instead of
   * flashing the default rest pose while the live feed warms up.
   */
  onFirstPose?: () => void;
}

function ReachyModel({
  poseRef,
  isActive = true,
  dark = false,
  animate = true,
  ghost = false,
  ghostColor = '#ff8c00',
  ghostDissolve = 0,
  offsetX = 0,
  yawOffset = 0,
  onReady,
  onFirstPose,
}: ReachyModelProps): React.ReactElement {
  const { scene } = useGLTF(glbUrl, DRACO_PATH);
  // SkeletonUtils.clone preserves the armature + skinned-mesh bindings.
  const model = useMemo(() => skeletonClone(scene) as THREE.Object3D, [scene]);

  // On-demand render loop (animate=false): nothing schedules frames for us, so
  // request one after every commit. Cheap - a static viz re-renders only on
  // mount / resize / dark-mode change - and it guarantees the snapped pose and
  // any antenna recolor actually reach the (idle) framebuffer.
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => {
    if (!animate) invalidate();
  });

  const groupRef = useRef<THREE.Group>(null);
  // Yaw at mount time; the live target (`yawOffset`) is tweened in the frame
  // loop rather than through the reactive JSX prop.
  const initialYaw = useRef(yawOffset);
  const bones = useRef<Record<string, THREE.Object3D | undefined>>({});
  const rest = useRef<Record<string, THREE.Quaternion>>({});
  const headRest = useRef<{
    parentInv: THREE.Matrix4;
    q: THREE.Quaternion;
    p: THREE.Vector3;
    s: THREE.Vector3;
  } | null>(null);
  const legs = useRef<LegChain[]>([]);
  // Body-spin axis expressed in the Core bone's PARENT frame (see setup effect).
  // Blender bones roll about their local Y, so the Core bone's local Z is NOT the
  // vertical: spinning about it makes the robot tumble. We instead spin about the
  // model's up axis (Z), mapped into the parent frame so a pre-multiply gives a
  // clean vertical yaw regardless of the bone's rest orientation.
  const bodyYawAxis = useRef(new THREE.Vector3(0, 0, 1));
  // Latch so `onFirstPose` fires only on the first valid head pose applied.
  const firstPoseFired = useRef(false);

  // Capture bones + rest pose ONCE per model.
  useEffect(() => {
    model.updateWorldMatrix(true, true);
    const modelInv = new THREE.Matrix4().copy(model.matrixWorld).invert();
    const byName: Record<string, THREE.Object3D> = {};
    model.traverse(o => {
      if (o.name) byName[norm(o.name)] = o;
    });
    for (const [key, name] of Object.entries(BONE)) {
      const node = byName[norm(name)];
      bones.current[key] = node;
      if (node) rest.current[key] = node.quaternion.clone();
      else console.warn(`[ReachyModel] bone node not found: ${name}`);
    }
    // Map the model's up axis (Z) into the Core bone's parent frame so a
    // pre-multiplied yaw spins the body about the true vertical (see bodyYawAxis).
    const bodyNode = bones.current.body;
    if (bodyNode?.parent) {
      const parentModel = new THREE.Matrix4().multiplyMatrices(modelInv, bodyNode.parent.matrixWorld);
      const pq = new THREE.Quaternion();
      parentModel.decompose(new THREE.Vector3(), pq, new THREE.Vector3());
      bodyYawAxis.current.set(0, 0, 1).applyQuaternion(pq.invert()).normalize();
    }
    const head = bones.current.head;
    if (head?.parent) {
      const headModel = new THREE.Matrix4().multiplyMatrices(modelInv, head.matrixWorld);
      const parentModel = new THREE.Matrix4().multiplyMatrices(modelInv, head.parent.matrixWorld);
      const q = new THREE.Quaternion();
      const p = new THREE.Vector3();
      const s = new THREE.Vector3();
      headModel.decompose(p, q, s);
      headRest.current = { parentInv: parentModel.invert(), q, p, s };
      legs.current = LEG_IDS.map(id => setupLeg(id, byName, head)).filter(
        (l): l is LegChain => l !== null,
      );
    }
    onReady?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // Recolor the antennas (the glb's only skinned meshes) for dark mode.
  // SkeletonUtils.clone shares materials with the source scene, so clone the
  // antenna material once per instance before mutating it -- otherwise we'd tint
  // every other 'Metal.Black' part and every other viz on screen too.
  useEffect(() => {
    if (ghost) return; // ghost mode overrides every material below
    model.traverse(o => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh || !mesh.material) return;
      let mat = mesh.material as THREE.MeshStandardMaterial;
      if (!mat.userData.__antennaClone) {
        mat = mat.clone();
        mat.userData.__antennaClone = true;
        mat.userData.__origColor = mat.color.clone();
        mat.userData.__origMetalness = mat.metalness;
        mesh.material = mat;
      }
      if (dark) {
        mat.color.set(DARK_ANTENNA_COLOR);
        mat.metalness = DARK_ANTENNA_METALNESS;
      } else {
        mat.color.copy(mat.userData.__origColor as THREE.Color);
        mat.metalness = mat.userData.__origMetalness as number;
      }
      mat.needsUpdate = true;
    });
  }, [model, dark, ghost]);

  // Ghost mode: CLONE each mesh's original material (keeping its colour, maps,
  // roughness/metalness so the robot's real look survives) and only tint it a
  // touch toward the target colour (applyGhostTint). The fade-out is a plain,
  // UNIFORM material OPACITY drop on the whole ghost.
  //
  // The catch with naive transparency: the robot is many overlapping meshes
  // (shell + internal parts), so alpha-blending them all shows the internal
  // layers stacked through each other. To make the fade read as one flat
  // silhouette we add a DEPTH PRE-PASS: for every rigid mesh we render an
  // invisible depth-only twin first (colorWrite off, depthWrite on), so the
  // depth buffer holds only the nearest surface per pixel. The real (colour)
  // pass then runs with depthWrite OFF and depthFunc LessEqual, so only that
  // nearest fragment blends - internal layers fail the depth test and are
  // dropped. One layer per pixel => a clean, uniform fade. (Antennas are the
  // glb's only skinned meshes and have no internal overlap, so they skip the
  // pre-pass.)
  const ghostMats = useRef<THREE.MeshStandardMaterial[]>([]);
  // Eased fade amount, 0 = fully opaque, 1 = fully faded out (opacity 1 -> 0).
  // Seed it from the CURRENT dissolve target at mount so a ghost that remounts
  // already-matched (e.g. going Back to the welcome step while the pose still
  // matches) starts fully dissolved instead of re-playing the fade-out from
  // solid. Fresh mounts that aren't matched yet seed 0 (solid) as before, so
  // the first-time dissolve animation is preserved.
  const fade = useRef({ value: ghostDissolve });
  const applyGhostFade = (mats: THREE.MeshStandardMaterial[], v: number): void => {
    const opacity = 1 - v;
    for (const m of mats) m.opacity = opacity;
  };
  useEffect(() => {
    if (!ghost) return;
    const mats: THREE.MeshStandardMaterial[] = [];
    // Shared, invisible depth-only material for the pre-pass twins.
    const depthMat = new THREE.MeshBasicMaterial({ colorWrite: false });
    depthMat.depthWrite = true;
    const depthTwins: THREE.Mesh[] = [];
    // Collect the source meshes first: adding the depth twins (themselves
    // meshes) DURING traverse would make traverse visit them and spawn twins of
    // twins forever -> stack overflow. Snapshot, then mutate.
    const meshes: THREE.Mesh[] = [];
    model.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.material) meshes.push(mesh);
    });
    for (const mesh of meshes) {
      const src = mesh.material as THREE.MeshStandardMaterial;
      const mat = src.clone();
      mat.userData.__ghostOrigColor = mat.color.clone();
      mat.transparent = true;
      mat.depthWrite = false;
      mat.depthFunc = THREE.LessEqualDepth;
      mat.needsUpdate = true;
      mesh.material = mat;
      mesh.renderOrder = 2;
      mats.push(mat);

      // Depth-only twin for rigid meshes (the internal shell parts). Added as a
      // child with an identity transform so it shares the exact same world
      // matrix -> identical depth, no z-fighting. Skinned antennas are skipped.
      if (!(mesh as THREE.SkinnedMesh).isSkinnedMesh) {
        const twin = new THREE.Mesh(mesh.geometry, depthMat);
        twin.renderOrder = 1;
        twin.frustumCulled = false;
        mesh.add(twin);
        depthTwins.push(twin);
      }
    }
    ghostMats.current = mats;
    applyGhostTint(mats, ghostColor);
    applyGhostFade(mats, fade.current.value);
    if (!animate) invalidate();
    return () => {
      depthTwins.forEach(t => t.parent?.remove(t));
      depthMat.dispose();
      mats.forEach(m => m.dispose());
      ghostMats.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, ghost]);

  // Live tint updates (e.g. orange -> green the moment the pose matches) without
  // rebuilding the material or the mesh bindings. Opacity is eased in the frame
  // loop (or set directly below for the on-demand static case).
  useEffect(() => {
    if (!ghost || ghostMats.current.length === 0) return;
    applyGhostTint(ghostMats.current, ghostColor);
    if (!animate) {
      fade.current.value = ghostDissolve;
      applyGhostFade(ghostMats.current, ghostDissolve);
      if (groupRef.current) groupRef.current.visible = ghostDissolve < 0.995;
      invalidate();
    }
  }, [ghost, ghostColor, ghostDissolve, animate, invalidate]);

  // Per-instance scratch + smoothing state (no per-frame allocation).
  const tmp = useRef({
    p: new THREE.Vector3(),
    q: new THREE.Quaternion(),
    s: new THREE.Vector3(),
    worldQ: new THREE.Quaternion(),
    worldP: new THREE.Vector3(),
    mat: new THREE.Matrix4(),
  }).current;
  const sm = useRef({
    headInit: false,
    yawInit: false,
    antInit: false,
    smP: new THREE.Vector3(),
    smQ: new THREE.Quaternion(),
    tgtP: new THREE.Vector3(),
    tgtQ: new THREE.Quaternion(),
    smYaw: 0,
    smAnt: [0, 0] as [number, number],
  }).current;

  useFrame((_, delta) => {
    if (!isActive) return;

    // Layout transition (runs even before a pose streams): ease the group to
    // its target x-offset and, for a ghost, ease its opacity toward the target
    // (drop to 0 to fade out when matched).
    const at = 1 - Math.exp(-TRANSITION_K * Math.min(delta, 0.05));
    if (groupRef.current) {
      groupRef.current.position.x += (offsetX - groupRef.current.position.x) * at;
      // Ease the display yaw toward its target so a step change (e.g. leaving
      // the welcome step -> robot turns to face front) animates smoothly and
      // reverses cleanly when going back. Driven here (not via the JSX
      // `rotation` prop) so a React re-render can't snap it and skip the tween.
      const targetYaw = DISPLAY_YAW + yawOffset;
      groupRef.current.rotation.y += (targetYaw - groupRef.current.rotation.y) * at;
    }
    if (ghost) {
      fade.current.value += (ghostDissolve - fade.current.value) * at;
      applyGhostFade(ghostMats.current, fade.current.value);
      // Once fully faded, hide the whole ghost so its depth pre-pass twins stop
      // punching an (invisible) occlusion hole over the live robot behind it.
      if (groupRef.current) groupRef.current.visible = fade.current.value < 0.995;
    }

    const pose = poseRef.current;
    if (!pose) return;
    const { body, head, antL, antR } = bones.current;
    // Exponential smoothing factor (clamp dt so a stalled tab can't jump).
    const a = 1 - Math.exp(-SMOOTH_K * Math.min(delta, 0.05));

    // Body yaw
    if (body && rest.current.body) {
      const tgt = pose.body_yaw ?? 0;
      if (!sm.yawInit) { sm.smYaw = tgt; sm.yawInit = true; }
      else sm.smYaw += (tgt - sm.smYaw) * a;
      // Pre-multiply: spin about the vertical (parent-frame) axis, then the rest
      // pose. `rest * Rz(localZ)` (post-multiply) would spin about the bone's
      // local Z, which isn't vertical -> tumbling.
      tmp.q.setFromAxisAngle(bodyYawAxis.current, YAW_SIGN * sm.smYaw);
      body.quaternion.copy(tmp.q).multiply(rest.current.body);
    }

    // Head 6-DOF from the cartesian pose matrix (robot frame), smoothed then
    // mapped into the model frame, with Z clamped to the platform's reach.
    const m = toMatrix(pose.head);
    const hr = headRest.current;
    if (head && hr && m) {
      m.decompose(sm.tgtP, sm.tgtQ, tmp.s);
      if (!sm.headInit) {
        sm.smP.copy(sm.tgtP);
        sm.smQ.copy(sm.tgtQ);
        sm.headInit = true;
      } else {
        sm.smP.lerp(sm.tgtP, a);
        sm.smQ.slerp(sm.tgtQ, a);
      }
      tmp.p.copy(sm.smP);
      tmp.q.copy(sm.smQ);
      // Change of basis robot -> model frame (proper rotation, no reflection).
      tmp.q.premultiply(HEAD_FIX).multiply(HEAD_FIX_INV);
      tmp.p.applyQuaternion(HEAD_FIX);
      tmp.worldQ.copy(tmp.q).multiply(hr.q);
      tmp.worldP.copy(hr.p).addScaledVector(tmp.p, UNITS_PER_M);
      tmp.worldP.z = Math.min(hr.p.z + HEAD_Z_MAX, Math.max(hr.p.z + HEAD_Z_MIN, tmp.worldP.z));
      tmp.mat.compose(tmp.worldP, tmp.worldQ, hr.s);
      tmp.mat.premultiply(hr.parentInv);
      tmp.mat.decompose(head.position, head.quaternion, head.scale);
      if (!firstPoseFired.current) {
        firstPoseFired.current = true;
        onFirstPose?.();
      }
    }

    // Neck leg IK: re-solve each leg so its tip tracks the head-mounted target.
    for (const leg of legs.current) solveLeg(leg, LEG_IK_ITERATIONS);

    // Antennas
    const ant = pose.antennas;
    if (ant) {
      if (!sm.antInit) { sm.smAnt[0] = ant[0]!; sm.smAnt[1] = ant[1]!; sm.antInit = true; }
      else {
        sm.smAnt[0] += (ant[0]! - sm.smAnt[0]) * a;
        sm.smAnt[1] += (ant[1]! - sm.smAnt[1]) * a;
      }
      if (antL && rest.current.antL) {
        tmp.q.setFromAxisAngle(ANT_AXIS, ANT_SIGN * sm.smAnt[1]);
        antL.quaternion.copy(rest.current.antL).multiply(tmp.q);
      }
      if (antR && rest.current.antR) {
        tmp.q.setFromAxisAngle(ANT_AXIS, ANT_SIGN * sm.smAnt[0]);
        antR.quaternion.copy(rest.current.antR).multiply(tmp.q);
      }
    }
  });

  return (
    // Only the MOUNT yaw is set here; subsequent changes are eased imperatively
    // in the frame loop (see above), so the prop stays constant and R3F never
    // snaps the rotation on re-render.
    <group ref={groupRef} position={[0, 0, 0]} rotation={[0, DISPLAY_YAW + initialYaw.current, 0]} scale={MODEL_SCALE}>
      <primitive object={model} rotation={[-Math.PI / 2, 0, 0]} />
    </group>
  );
}

export default ReachyModel;
