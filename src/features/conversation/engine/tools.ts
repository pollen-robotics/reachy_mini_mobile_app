/**
 * Static realtime tool descriptors + the head-pose lookup
 * table the model targets via `move_head`.
 *
 * Pure data: no runtime dependencies, no side effects. The engine
 * imports these and registers them with the realtime backend at
 * conversation start.
 *
 * Schema mirrors the backend's Realtime API tool schema: a `name`, a free-
 * text `description` (the model's only hint about when to call the
 * tool, so write them like prompt fragments) and a JSON-Schema
 * `parameters` block.
 */

import { MOVE_CATALOG, MOVE_IDS } from '../motion/move-player';
import type { RealtimeTool } from './huggingface-realtime';

/**
 * Predefined head poses (roll/pitch/yaw in degrees) the model can
 * target via the single `move_head` tool. Kept small and readable:
 * the model just picks a named direction, we do the geometry.
 */
export const HEAD_POSES = {
  center: { roll: 0, pitch: 0, yaw: 0 },
  up: { roll: 0, pitch: -18, yaw: 0 },
  down: { roll: 0, pitch: 18, yaw: 0 },
  left: { roll: 0, pitch: 0, yaw: 25 },
  right: { roll: 0, pitch: 0, yaw: -25 },
  tilt_left: { roll: -15, pitch: 0, yaw: 0 },
  tilt_right: { roll: 15, pitch: 0, yaw: 0 },
} as const;

export type HeadPoseName = keyof typeof HEAD_POSES;

export const ROBOT_TOOLS: RealtimeTool[] = [
  {
    name: 'move_head',
    description:
      "Point the robot's head in a named direction. Use this to accompany " +
      'your speech with a tiny, legible gesture (e.g. `up` when celebrating, ' +
      '`tilt_left` when curious, `center` to reset).',
    parameters: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: Object.keys(HEAD_POSES),
          description: 'Named head pose to assume.',
        },
      },
      required: ['direction'],
    },
  },
  {
    name: 'play_move',
    description:
      'Trigger a short pre-recorded body-language move (1-4s) from the ' +
      'Reachy dances + emotions library. Catalog (each line is `id | kind | ' +
      'when to pick it`):\n' +
      MOVE_CATALOG.map(
        (m) => `  - ${m.id} | ${m.kind} | ${m.description}`,
      ).join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: [...MOVE_IDS],
          description:
            'Catalog id to play. See the description for guidance on ' +
            'which id fits which conversational moment.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'remember',
    description:
      'Save ONE short fact about the user to your long-term memory so ' +
      'you remember it in future sessions. Use this for stable user ' +
      'information they explicitly shared: name, preferences, hobbies, ' +
      'recurring projects, important people, plans. Keep each fact under ' +
      'one sentence and atomic - if the user shares two things, call ' +
      '`remember` twice. Do NOT save sensitive data (passwords, addresses, ' +
      "payment info, health diagnoses) or fleeting details (current mood, " +
      "today's weather). Acknowledge naturally without reading the fact " +
      'back; never announce "I will remember that".',
    parameters: {
      type: 'object',
      properties: {
        fact: {
          type: 'string',
          description:
            'A short, third-person statement about the user (e.g. ' +
            '"Has a dog named Mochi", "Works as a UX designer", ' +
            '"Prefers replies in French"). One fact per call.',
        },
      },
      required: ['fact'],
    },
  },
  {
    name: 'forget',
    description:
      'Remove a previously saved fact from your long-term memory. Call ' +
      'this when the user asks you to forget something, or when the ' +
      'information becomes obsolete (e.g. they got a new job, the dog ' +
      'they had passed away). Match by free-text query: pick the most ' +
      'specific phrase that uniquely identifies the fact to remove.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'A short search phrase that should be present in the fact ' +
            'to remove. Case-insensitive substring match. If multiple ' +
            'facts contain it, the oldest one is removed and you are ' +
            'told about the others so you can re-call `forget` with a ' +
            'more specific query.',
        },
      },
      required: ['query'],
    },
  },
];
