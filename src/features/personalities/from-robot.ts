/**
 * The robot's personalities, presented the way the phone draws them.
 *
 * The robot owns the content: each profile is a directory holding the
 * instructions, the voice and an avatar, and its canonical name (`default`,
 * `user_personalities/guide`) is the identity everything else keys off.
 *
 * It does not own the look. The phone ships its own drawing, glow and tagline
 * for each personality it knows, and they are far cheaper to read from the
 * bundle than to pull ~120 KB of SVG per profile through the data channel. So
 * a robot profile is merged with the phone's presentation when there is one,
 * and falls back to the default look when there is not — which is what a
 * personality the user wrote on the robot gets.
 */
import type { RobotPersonality } from '@/features/conv-app/client';

import { getCachedAvatar } from './avatar-cache';
import { BUILTIN_PERSONALITIES, DEFAULT_GLOW, getDefaultPersonality } from './builtin';
import type { Personality } from './types';

/** `user_personalities/guide` is the robot's namespace for what a user wrote. */
export const USER_PREFIX = 'user_personalities/';

/** The profile the robot falls back to, and the id of its bundled default. */
export const ROBOT_DEFAULT_PROFILE = 'default';

/** The one profile the two sides spell differently. */
const ALIASES: Record<string, string> = {
  // The robot calls it the assistant; the phone just the scientist.
  mad_scientist_assistant: 'mad_scientist',
};
/** How the phone draws each personality it ships, by presentation key. */
const PRESENTATION = new Map<string, Personality>(
  BUILTIN_PERSONALITIES.map(personality => [presentationKey(personality.id), personality])
);

/** Turn `cosmic_kitchen` into `Cosmic Kitchen` for a profile we do not ship. */
function humanise(profile: string): string {
  return profile
    .split(/[_-]/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * The key a personality presents under, from either side: the bare profile,
 * without the robot's user namespace or the phone's `builtin:` prefix, and
 * through the alias table. It is what says that `user_personalities/zen_guide`,
 * `builtin:zen_guide` and `zen_guide` are one personality, and that
 * `mad_scientist_assistant` is the phone's `mad_scientist`.
 */
export function presentationKey(name: string): string {
  const profile = name.replace(/^builtin:/, '').replace(USER_PREFIX, '');
  return ALIASES[profile] ?? profile;
}

function presentationFor(name: string): Personality | undefined {
  return PRESENTATION.get(presentationKey(name));
}

/** The robot's `avatar_id` for its own default drawing: nothing to fetch. */
const ROBOT_DEFAULT_AVATAR_ID = 'default';

/**
 * The robot drawing worth fetching for a profile the phone ships no drawing
 * for, or null. The robot's default is skipped: the phone has its own, and a
 * sticker the phone generated must not be replaced by it.
 */
export function robotAvatarId(robot: RobotPersonality): string | null {
  if (presentationFor(robot.name)) return null;
  const id = robot.avatar_id;
  return id && id !== ROBOT_DEFAULT_AVATAR_ID ? id : null;
}

/** Map one robot profile onto the shape the personality UI renders. */
export function toPersonality(robot: RobotPersonality): Personality {
  const look = presentationFor(robot.name);
  const fallback = getDefaultPersonality();
  const fetchedId = robotAvatarId(robot);
  return {
    // The robot's canonical name IS the id: it is what `personalities.apply`
    // takes, so nothing has to translate back.
    id: robot.name,
    kind: robot.name.startsWith(USER_PREFIX) ? 'custom' : 'builtin',
    name: look?.name ?? humanise(robot.name.replace(USER_PREFIX, '')),
    // The robot has no teaser; its greeting is an opening-line prompt.
    tagline: look?.tagline ?? '',
    instructions: robot.instructions,
    voice: robot.voice,
    glow: look?.glow ?? DEFAULT_GLOW,
    avatar: look?.avatar ?? (fetchedId ? getCachedAvatar(fetchedId) : null) ?? fallback.avatar,
  };
}

export function toCatalog(robots: readonly RobotPersonality[]): Personality[] {
  return robots.map(toPersonality);
}
