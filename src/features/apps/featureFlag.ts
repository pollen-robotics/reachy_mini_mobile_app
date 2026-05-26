/**
 * Apps tab kill switch (single source of truth).
 *
 * The Apps tab is the in-app catalog of third-party Hugging Face Spaces
 * (`reachy_mini_js_app` tag), embedded in a sandboxed iframe. It is the
 * UGC surface of the app and cannot ship to the App Store / Play Store
 * before the four UGC pillars in `docs/APP_STORE_COMPLIANCE.md` §6.1 are
 * implemented (report flow, block-author, EULA, contact info) and the
 * server-side moderation kill switch (§6.2) is live.
 *
 * Setting this to `false` cleanly hides the surface from the user while
 * keeping all of the underlying code (state, hooks, components, route
 * handlers, iframe overlay) compiled and ready to ship the day the
 * pillars are in place. Effects of the flag being `false`:
 *
 *   - the "Apps" entry is removed from the bottom navigation, so the
 *     user can only ever sit on the Conversation tab
 *     (`ui/screens/RobotSessionScreen.tsx`)
 *   - the apps tab body (`<AppsTabView>`) is never rendered
 *   - the iframe overlay (`<AppIframeOverlay>`) is never mounted, so no
 *     third-party Space ever loads
 *   - the catalog is never fetched, even at app cold start: the root
 *     warm-up `usePrefetchApps()` is gated by this same flag so we
 *     don't pull the UGC catalog over the wire in a "no-UGC" build.
 *     Without that gate App Review's network inspector would see a
 *     fetch to `/api/js-apps` while the Privacy Manifest declares no
 *     UGC surface, which is a self-inflicted reviewer question.
 *
 * Flip back to `true` once the UGC compliance plan has shipped. The
 * flag lives in this dedicated module (not co-located with one of the
 * call sites) so every consumer points at the same constant and a
 * reviewer tracing "where does this iframe come from" can grep one
 * symbol to find every surface affected.
 */
export const APPS_TAB_ENABLED = false;
