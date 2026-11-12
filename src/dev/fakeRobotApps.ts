/**
 * Dev-only stand-in for the daemon's `apps.*` JSON-RPC surface, so the
 * harness can exercise the robot-apps panel, store and sheet without a robot:
 * installs stream fake `apps.job_progress` lines, starts go through
 * `starting` → `running`, and `?crash` makes started apps crash.
 */
import type {
  ReachyMiniInstance,
  RpcNotificationHandler,
} from '@/features/robot-session/sdk-types';

interface FakeInstalled {
  name: string;
  space_id: string;
  title: string;
  description: string;
  emoji: string | null;
  private: boolean;
  custom_app_url: string | null;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function rpcError(reason: string, message = reason): Error {
  return Object.assign(new Error(message), { reason });
}

export function createFakeRobotApps(): ReachyMiniInstance {
  const crash = new URLSearchParams(location.search).has('crash');
  const handlers = new Map<string, Set<RpcNotificationHandler>>();
  const installed: FakeInstalled[] = [
    {
      name: 'reachy_mini_dance',
      space_id: 'pollen-robotics/reachy_mini_dance',
      title: 'Dance',
      description: 'Reachy dances to the music around it.',
      emoji: '💃',
      private: false,
      custom_app_url: null,
    },
  ];
  let status: { state: string; info: { name: string } | null; error: string | null } = {
    state: 'idle',
    info: null,
    error: null,
  };
  const jobs = new Map<string, { command: string; status: string; logs: string[] }>();
  let jobCounter = 0;

  const notify = (method: string, params: Record<string, unknown>) =>
    handlers.get(method)?.forEach(h => h(params));

  const runJob = (command: string, lines: string[], onDone: () => void): string => {
    if ([...jobs.values()].some(j => j.status === 'in_progress')) throw rpcError('busy');
    const id = `job-${++jobCounter}`;
    const job = { command, status: 'in_progress', logs: [] as string[] };
    jobs.set(id, job);
    void (async () => {
      for (const line of lines) {
        await sleep(600);
        job.logs.push(line);
        notify('apps.job_progress', {
          job_id: id,
          command,
          status: job.status,
          line,
          final: false,
        });
      }
      onDone();
      job.status = 'done';
      notify('apps.job_progress', { job_id: id, command, status: 'done', line: null, final: true });
    })();
    return id;
  };

  const rpcCall = async (method: string, params: Record<string, unknown> = {}) => {
    await sleep(150);
    switch (method) {
      case 'apps.list_installed':
        return { apps: installed };
      case 'apps.status':
        return status;
      case 'apps.start': {
        const name = String(params.name);
        if (status.state === 'running' || status.state === 'starting')
          throw rpcError('already_running', 'An app is already running');
        status = { state: 'starting', info: { name }, error: null };
        setTimeout(() => {
          if (status.info?.name !== name) return;
          status = { state: 'running', info: { name }, error: null };
          if (crash)
            setTimeout(() => {
              status = {
                state: 'error',
                info: { name },
                error:
                  'Process exited with code 1\nTraceback (most recent call last):\nRuntimeError: no camera',
              };
            }, 3000);
        }, 1500);
        return status;
      }
      case 'apps.stop':
        if (status.state === 'idle') throw rpcError('not_running');
        await sleep(800);
        status = { state: 'idle', info: null, error: null };
        return { stopped: true };
      case 'apps.restart':
        if (!status.info) throw rpcError('not_running');
        await sleep(1200);
        status = { state: 'running', info: status.info, error: null };
        return status;
      case 'apps.install_space': {
        const spaceId = String(params.space_id);
        const name = spaceId.split('/')[1];
        const jobId = runJob(
          'install',
          [
            `Downloading HuggingFace Space: ${spaceId}`,
            `Space found: ${spaceId} (private=False)`,
            'Resolved 42 packages in 1.2s',
            'Prepared 3 packages in 4.1s',
            `Installed 3 packages in 120ms`,
            `Successfully installed '${name}'`,
          ],
          () =>
            installed.push({
              name,
              space_id: spaceId,
              title: name,
              description: '',
              emoji: null,
              private: false,
              custom_app_url: null,
            })
        );
        return { job_id: jobId, name };
      }
      case 'apps.remove': {
        const name = String(params.name);
        if (status.info?.name === name) throw rpcError('app_running');
        const jobId = runJob(
          'remove',
          [`Uninstalling ${name}`, `Successfully uninstalled ${name}`],
          () => {
            const i = installed.findIndex(a => a.name === name);
            if (i >= 0) installed.splice(i, 1);
          }
        );
        return { job_id: jobId };
      }
      case 'apps.update': {
        const name = String(params.name);
        return {
          job_id: runJob(
            'update',
            [`Downloading latest ${name}`, 'Resolved 12 packages'],
            () => {}
          ),
        };
      }
      case 'apps.job_status': {
        const job = jobs.get(String(params.job_id));
        if (!job) throw rpcError('unknown_job');
        return { ...job, logs: [...job.logs] };
      }
      default:
        throw rpcError('method_not_found');
    }
  };

  const onNotification = (method: string, handler: RpcNotificationHandler) => {
    const set = handlers.get(method) ?? new Set();
    set.add(handler);
    handlers.set(method, set);
    return () => set.delete(handler);
  };

  return Object.assign(new EventTarget(), {
    rpcCall,
    onNotification,
  }) as unknown as ReachyMiniInstance;
}
