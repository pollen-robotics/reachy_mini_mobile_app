/**
 * Organic audio-level bars on a canvas (center envelope + per-bar
 * randomness), tinted with the theme's primary colour. Ported from the
 * desktop "Wake Me Up" visualiser.
 */

import { useEffect, useRef, useState } from 'react';
import { Box, useTheme } from '@mui/material';

const FREQ_BAR_COUNT = 12;
const FREQ_BAR_GAP = 5;
const FREQ_MIN_BAR_HEIGHT = 4;

export default function FrequencyBars({
  level,
  isActive,
  height = 56,
}: {
  level: number;
  isActive: boolean;
  height?: number;
}) {
  const theme = useTheme();
  const color = theme.palette.primary.main;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef(0);
  const smoothedRef = useRef<Float32Array>(new Float32Array(FREQ_BAR_COUNT));
  const [width, setWidth] = useState(300);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width;
      if (w && w > 0) setWidth(w);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const barWidth = (width - (FREQ_BAR_COUNT - 1) * FREQ_BAR_GAP) / FREQ_BAR_COUNT;
      // Asymmetric smoothing: snap UP almost instantly so every tap punches the
      // bars to full even mid-decay (no "canned envelope that waits to finish"),
      // then fall gently so it still reads as audio rather than a strobe.
      const smoothingUp = 0.7;
      const smoothingDown = 0.16;
      const baseLevel = isActive ? Math.min(level, 1) : 0;
      for (let i = 0; i < FREQ_BAR_COUNT; i += 1) {
        const position = i / (FREQ_BAR_COUNT - 1);
        const centerDistance = Math.abs(position - 0.5) * 2;
        const envelope = 1 - centerDistance * centerDistance;
        const randomness = Math.random() * 0.4 + 0.8;
        const target = baseLevel * envelope * randomness;
        const cur = smoothedRef.current[i];
        smoothedRef.current[i] += (target - cur) * (target > cur ? smoothingUp : smoothingDown);
        const val = smoothedRef.current[i];
        const barH = Math.max(FREQ_MIN_BAR_HEIGHT, val * (height - 8));
        const x = i * (barWidth + FREQ_BAR_GAP);
        const y = (height - barH) / 2;
        ctx.globalAlpha = 0.35 + val * 0.65;
        ctx.fillStyle = color;
        const radius = Math.min(barWidth / 2, barH / 2, 5);
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barH, radius);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      animationRef.current = requestAnimationFrame(draw);
    };
    animationRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animationRef.current);
  }, [width, height, level, isActive, color]);

  return (
    <Box ref={containerRef} sx={{ width: '100%', height, position: 'relative', flexShrink: 0 }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
    </Box>
  );
}
