/**
 * The conversation-app client for whatever robot is live right now.
 *
 * Some surfaces outside the engine need to reach the robot: the personality
 * picker applies a choice the moment you tap it, while a conversation is
 * running. The engine publishes the live robot here and retracts it when the
 * conversation stops, so a consumer either gets a usable client or `null`,
 * never a stale one.
 */
import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { createConvAppClient, type ConvAppClient } from './client';

let client: ConvAppClient | null = null;

/** Publish (or with `null`, retract) the robot a conversation is running on. */
export function setLiveRobot(robot: ReachyMiniInstance | null): void {
  client = robot ? createConvAppClient(robot) : null;
}

export function getLiveClient(): ConvAppClient | null {
  return client;
}
