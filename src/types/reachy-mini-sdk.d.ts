/**
 * Ambient stub for `@pollen-robotics/reachy-mini-sdk`.
 *
 * The published npm package currently ships plain JavaScript with no
 * `.d.ts`. The mobile app only imports `ReachyMini` from it once — at
 * `src/features/robot-session/sdk-bootstrap.ts`, immediately cast
 * through `unknown` onto `window.ReachyMini`. Engine-side typing of
 * the SDK surface lives in `src/features/robot-session/sdk-types.ts`
 * (`ReachyMiniInstance`), not here.
 *
 * So this file's only job is to silence TS's "Could not find a
 * declaration file" error at the import site.
 *
 * TODO: delete this file once `reachy-mini-sdk.js` is migrated to
 * TypeScript (or shipped with generated `.d.ts` files from its JSDoc)
 * upstream — see the TODO in PR #1135 about deriving SDK types from
 * JSDoc via `tsc --declaration --allowJs`. Once the npm package
 * carries its own `types` entry, TypeScript will resolve the import
 * from `node_modules` and this stub becomes dead code.
 */
declare module '@pollen-robotics/reachy-mini-sdk';
