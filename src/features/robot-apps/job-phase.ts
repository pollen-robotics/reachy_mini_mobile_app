/**
 * A short, human label for where a background job is, guessed from its log.
 *
 * The daemon streams raw `uv` / `huggingface_hub` output; the sheet shows
 * this label above the log tail so a non-developer gets a sense of progress.
 */
import type { RobotAppJob } from './types';

const PHASES: ReadonlyArray<[RegExp, string]> = [
  [/completed successfully|successfully (installed|uninstalled)/i, 'Finishing'],
  [/uninstall|removing/i, 'Removing'],
  [
    /resolved|prepared|installed \d+ package|pip install|uv pip|building/i,
    'Installing dependencies',
  ],
  [/download|fetching|space found|files available/i, 'Downloading'],
  [/creating venv|virtual environment/i, 'Preparing'],
];

const IDLE_LABEL: Record<RobotAppJob['kind'], string> = {
  install: 'Installing',
  remove: 'Uninstalling',
  update: 'Updating',
};

export function describeJobPhase(job: RobotAppJob): string {
  if (job.status === 'done') return 'Done';
  if (job.status === 'failed') return 'Failed';
  for (let i = job.logs.length - 1; i >= Math.max(0, job.logs.length - 10); i--) {
    const line = job.logs[i];
    for (const [pattern, label] of PHASES) if (pattern.test(line)) return label;
  }
  return IDLE_LABEL[job.kind];
}
