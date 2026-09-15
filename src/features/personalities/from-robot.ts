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

import { BUILTIN_PERSONALITIES, DEFAULT_GLOW, getDefaultPersonality } from './builtin';
import type { Personality } from './types';

/** `user_personalities/guide` is the robot's namespace for what a user wrote. */
export const USER_PREFIX = 'user_personalities/';

/** The profile the robot falls back to, and the id of its bundled default. */
export const ROBOT_DEFAULT_PROFILE = 'default';

/**
 * Presentation by robot profile name. The phone's built-in ids are already
 * `builtin:<profile>`, so the map is the bundled catalog with the prefix
 * dropped, plus the one name the two sides spell differently.
 */
const PRESENTATION = new Map<string, Personality>(
  BUILTIN_PERSONALITIES.map(personality => [personality.id.replace(/^builtin:/, ''), personality])
);
const ALIASES: Record<string, string> = {
  // The robot calls it the assistant; the phone just the scientist.
  mad_scientist_assistant: 'mad_scientist',
};

/** Turn `cosmic_kitchen` into `Cosmic Kitchen` for a profile we do not ship. */
function humanise(profile: string): string {
  return profile
    .split(/[_-]/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function presentationFor(name: string): Personality | undefined {
  const profile = name.startsWith(USER_PREFIX) ? name.slice(USER_PREFIX.length) : name;
  return PRESENTATION.get(ALIASES[profile] ?? profile);
}

/** Map one robot profile onto the shape the personality UI renders. */
export function toPersonality(robot: RobotPersonality): Personality {
  const look = presentationFor(robot.name);
  const fallback = getDefaultPersonality();
  return {
    // The robot's canonical name IS the id: it is what `personalities.apply`
    // takes, so nothing has to translate back.
    id: robot.name,
    kind: robot.name.startsWith(USER_PREFIX) ? 'custom' : 'builtin',
    name: look?.name ?? humanise(robot.name.replace(USER_PREFIX, '')),
    tagline: look?.tagline ?? robot.greeting ?? '',
    instructions: robot.instructions,
    voice: robot.voice,
    glow: look?.glow ?? DEFAULT_GLOW,
    avatar: look?.avatar ?? fallback.avatar,
  };
}

export function toCatalog(robots: readonly RobotPersonality[]): Personality[] {
  return robots.map(toPersonality);
}
