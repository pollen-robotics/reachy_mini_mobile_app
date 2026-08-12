/**
 * R3F confetti burst for the first wake-up finale.
 *
 * A self-contained, transparent full-screen Canvas overlay: a one-shot burst
 * of instanced paper flakes that explode outward from the robot's area, tumble
 * (3-axis spin), flutter (sinusoidal sway), fall under gravity, then fade out.
 * Mounted only while the wizard is finishing (see index.tsx), unmounted on
 * handoff, so it never costs anything the rest of the time.
 *
 * One `instancedMesh` (single draw call) keeps it cheap; the material is
 * unlit (`meshBasicMaterial`) so the flake colours read flat and vivid with no
 * scene lighting needed.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Box } from '@mui/material';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const COUNT = 180;

// Festive but curated palette (kept slightly desaturated so it reads premium,
// not party-store garish).
const COLORS = ['#FF6B6B', '#FFD93D', '#5AC98B', '#4D96FF', '#FF9F45', '#C77DFF', '#FF7EB6'];

// Burst origin (world units). Slightly above centre so the flakes appear to
// erupt from around the robot's head, which sits in the upper stage region.
const ORIGIN_Y = 1.4;
const GRAVITY = 11;

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  angVel: THREE.Vector3;
  swayPhase: number;
  swayAmp: number;
  scale: number;
}

function Flakes() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const startRef = useRef<number>(performance.now() / 1000);

  const particles = useMemo<Particle[]>(
    () =>
      Array.from({ length: COUNT }, () => ({
        pos: new THREE.Vector3(
          (Math.random() - 0.5) * 0.6,
          ORIGIN_Y + (Math.random() - 0.5) * 0.6,
          (Math.random() - 0.5) * 0.6,
        ),
        // Explode up + outward: a wide horizontal spread, a strong upward kick.
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 9,
          Math.random() * 5 + 3.5,
          (Math.random() - 0.5) * 5,
        ),
        rot: new THREE.Euler(
          Math.random() * Math.PI,
          Math.random() * Math.PI,
          Math.random() * Math.PI,
        ),
        angVel: new THREE.Vector3(
          (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 8,
        ),
        swayPhase: Math.random() * Math.PI * 2,
        swayAmp: 0.4 + Math.random() * 0.6,
        scale: 0.7 + Math.random() * 0.6,
      })),
    [],
  );

  // Per-instance colour (once). `setColorAt` lazily allocates `instanceColor`.
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const c = new THREE.Color();
    for (let i = 0; i < COUNT; i++) {
      c.set(COLORS[i % COLORS.length]);
      mesh.setColorAt(i, c);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [particles]);

  useFrame((state, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dt = Math.min(delta, 0.05);
    const t = state.clock.elapsedTime;
    const age = performance.now() / 1000 - startRef.current;

    // Global fade-out over the last stretch so nothing pops on unmount.
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.opacity = age < 3.2 ? 1 : Math.max(0, 1 - (age - 3.2) / 1.6);

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i]!;
      p.vel.y -= GRAVITY * dt;
      const sway = Math.sin(t * 3 + p.swayPhase) * p.swayAmp;
      p.pos.x += (p.vel.x + sway) * dt;
      p.pos.y += p.vel.y * dt;
      p.pos.z += p.vel.z * dt;
      p.rot.x += p.angVel.x * dt;
      p.rot.y += p.angVel.y * dt;
      p.rot.z += p.angVel.z * dt;

      dummy.position.copy(p.pos);
      dummy.rotation.copy(p.rot);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, COUNT]}>
      <planeGeometry args={[0.13, 0.2]} />
      <meshBasicMaterial side={THREE.DoubleSide} toneMapped={false} transparent />
    </instancedMesh>
  );
}

export default function FinishConfetti() {
  return (
    // zIndex -1 keeps the confetti BEHIND the robot: it paints above the
    // wizard's opaque background but below the (positioned) 3D viz, whose
    // transparent canvas lets the flakes show through everywhere except where
    // the robot's opaque silhouette occludes them - so they read as flying
    // behind him rather than pasted on top.
    <Box aria-hidden sx={{ position: 'fixed', inset: 0, zIndex: -1, pointerEvents: 'none' }}>
      <Canvas
        dpr={[1, 2]}
        gl={{ alpha: true, antialias: true }}
        camera={{ position: [0, 0, 10], fov: 50, near: 0.1, far: 50 }}
      >
        <Flakes />
      </Canvas>
    </Box>
  );
}
