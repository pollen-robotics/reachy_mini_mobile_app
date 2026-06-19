/**
 * Animated TV static, shown while the camera feed is still connecting so
 * the "closed eye" reads as a sleeping sensor rather than a dead box.
 */

import { useEffect, useRef } from 'react';

export default function StaticNoise() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const imageData = ctx.createImageData(w, h);
    const data = imageData.data;
    let raf = 0;
    const draw = () => {
      for (let i = 0; i < data.length; i += 4) {
        const v = Math.random() * 255;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 40;
      }
      ctx.putImageData(imageData, 0, 0);
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={360}
      height={270}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
    />
  );
}
