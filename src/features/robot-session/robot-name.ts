/**
 * Renaming the robot over the live session.
 *
 * Why this exists: a `null` from the SDK's `setRobotName()` does not mean
 * the rename failed. The SDK resolves it `null` when its reply slot times
 * out (4 s) or is superseded by another name request, and the daemon only
 * acks after re-registering its mDNS service, which takes seconds. The
 * name is then stored on the robot while the app still shows the old one.
 * So a missing ack is settled by reading the name back.
 *
 * Split from the screen so it is unit-testable without React or an SDK.
 */
import { MAX_ROBOT_NAME_LENGTH, type ReachyMiniInstance } from './sdk-types';

type RobotNameApi = Pick<ReachyMiniInstance, 'getRobotName' | 'setRobotName'>;

/**
 * Persist `name` on the robot. Resolves the stored name, or `null` when
 * the robot does not carry it afterwards. Rejects like `setRobotName()`
 * does (data channel not open).
 */
export async function renameRobot(robot: RobotNameApi, name: string): Promise<string | null> {
  const saved = await robot.setRobotName(name);
  if (saved) return saved;
  // No ack: the daemon stores the name trimmed and length-capped, so that
  // is what a successful rename reads back as.
  const expected = name.trim().slice(0, MAX_ROBOT_NAME_LENGTH);
  if (!expected) return null;
  const current = await robot.getRobotName().catch(() => null);
  return current === expected ? current : null;
}
