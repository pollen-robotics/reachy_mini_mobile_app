/// <reference types="vite/client" />

/**
 * Build-time constant injected by `vite.config.ts` from the npm
 * `package.json` version. Used by the splash screen and any future
 * "About" surface so we never have to keep a hand-maintained version
 * constant in sync with the package version.
 */
declare const __APP_VERSION__: string;

declare module '*.svg' {
  const src: string;
  export default src;
}

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.jpg' {
  const src: string;
  export default src;
}
