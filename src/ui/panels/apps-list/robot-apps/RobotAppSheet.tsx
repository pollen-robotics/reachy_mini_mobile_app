/**
 * Bottom sheet for one Python app: what it is, whether it is on the robot,
 * and every action on it (install, start, stop, restart, update, uninstall),
 * with the live log of a running install.
 *
 * Python apps run on the robot, not in the phone: starting one keeps the
 * phone's session (the daemon starts it with `keep_remote`), so unlike a JS
 * app there is no iframe and no handoff. The sheet only drives the daemon.
 */
import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Drawer,
  LinearProgress,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineRounded';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded';
import StopRoundedIcon from '@mui/icons-material/StopRounded';
import SystemUpdateAltRoundedIcon from '@mui/icons-material/SystemUpdateAltRounded';

import type { AppEntry } from '@/features/apps/types';
import { hasSpaceId } from '@/features/robot-apps/catalog';
import { crashSummary } from '@/features/robot-apps/crash';
import { describeJobPhase } from '@/features/robot-apps/job-phase';
import type { InstalledRobotApp, RobotAppJob } from '@/features/robot-apps/types';
import type { RobotAppsHandle } from '@/features/robot-apps/useRobotApps';
import { openExternalUrl } from '@/shared/tauri/openUrl';
import { FONT_WEIGHT, LAYOUT, RADIUS, STATUS, TYPO } from '@/ui/design/tokens';

import AppIcon from '../AppIcon';
import RunsOnChip from '../RunsOnChip';

/** Log lines shown under the progress bar before "Show full log". */
const LOG_TAIL_LINES = 4;

interface RobotAppSheetProps {
  /** Catalog entry, or an adapter for an installed app the catalog lacks. */
  app: AppEntry | null;
  installed: InstalledRobotApp | null;
  robotApps: RobotAppsHandle;
  /** User-facing name of an installed app, from its entry name. */
  displayName: (entryName: string) => string;
  onClose: () => void;
}

type Confirm = { kind: 'replace'; running: string } | { kind: 'uninstall' } | null;

export default function RobotAppSheet({
  app,
  installed,
  robotApps,
  displayName,
  onClose,
}: RobotAppSheetProps) {
  const { snapshot, controller } = robotApps;
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [showFullLog, setShowFullLog] = useState(false);

  const open = app !== null;
  const name = installed?.name ?? null;
  const { running, job, pending, support, online } = snapshot;

  const runsThis = name !== null && running.name === name;
  const isLive = runsThis && (running.state === 'running' || running.state === 'starting');
  const crashed = runsThis && running.state === 'error';
  const otherRunning =
    !runsThis && (running.state === 'running' || running.state === 'starting')
      ? running.name
      : null;
  const jobForThis =
    job && app && (job.spaceId === app.id || (name !== null && job.appName === name)) ? job : null;
  const jobRunning = job !== null && (job.status === 'pending' || job.status === 'in_progress');
  // Offline (session down or re-dialing) counts as busy: a tap would only
  // fail on the closed data channel.
  const busy = pending !== null || jobRunning || !online;

  const handleStart = () => {
    if (!name) return;
    if (otherRunning) setConfirm({ kind: 'replace', running: displayName(otherRunning) });
    else void controller.start(name);
  };

  const confirmAction = () => {
    const current = confirm;
    setConfirm(null);
    if (!name || !current) return;
    if (current.kind === 'replace') void controller.start(name);
    else void controller.remove(name);
  };

  return (
    <>
      <Drawer
        anchor="bottom"
        open={open}
        onClose={onClose}
        slotProps={{
          paper: {
            sx: {
              borderTopLeftRadius: RADIUS.xl,
              borderTopRightRadius: RADIUS.xl,
              maxHeight: '85vh',
              pb: `calc(${LAYOUT.safeAreaBottom} + 16px)`,
            },
          },
        }}
      >
        {app && (
          <Box sx={{ width: '100%', maxWidth: LAYOUT.contentMaxWidth, mx: 'auto', px: 3, pt: 1.5 }}>
            <Box
              sx={{
                width: 36,
                height: 4,
                borderRadius: RADIUS.pill,
                bgcolor: 'divider',
                mx: 'auto',
                mb: 2,
              }}
            />

            <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mb: 1.5 }}>
              <AppIcon app={app} size={56} />
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography
                  sx={{ fontSize: TYPO.xl, fontWeight: FONT_WEIGHT.bold, lineHeight: 1.2 }}
                  noWrap
                >
                  {app.name}
                </Typography>
                {app.author && (
                  <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }} noWrap>
                    by {app.author}
                  </Typography>
                )}
                <Box sx={{ display: 'flex', mt: 0.5 }}>
                  <RunsOnChip runsOn="robot" />
                </Box>
              </Box>
              <StatusChip
                installed={installed !== null}
                isLive={isLive}
                starting={runsThis && running.state === 'starting'}
                crashed={crashed}
              />
            </Box>

            {app.description && (
              <Typography sx={{ fontSize: TYPO.body, color: 'text.secondary', mb: 2 }}>
                {app.description}
              </Typography>
            )}

            {!online && (
              <Alert severity="info" sx={{ mb: 2 }}>
                Reconnecting to Reachy…
              </Alert>
            )}

            {support === 'unsupported' && (
              <Alert severity="info" sx={{ mb: 2 }}>
                Update Reachy to install and manage its apps from your phone.
              </Alert>
            )}

            {crashed && running.error && (
              <Alert severity="error" sx={{ mb: 2, '& .MuiAlert-message': { minWidth: 0 } }}>
                <Typography sx={{ fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.semibold }}>
                  The app stopped with an error
                </Typography>
                <LogBlock lines={crashSummary(running.error, LOG_TAIL_LINES)} />
              </Alert>
            )}

            {jobForThis && (
              <JobProgress
                job={jobForThis}
                showFullLog={showFullLog}
                onToggleLog={() => setShowFullLog(v => !v)}
                onDismiss={() => controller.dismissJob()}
              />
            )}

            {snapshot.error && !jobForThis && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                {snapshot.error}
              </Alert>
            )}

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {!installed && hasSpaceId(app) && (
                <ActionButton
                  primary
                  icon={<DownloadRoundedIcon />}
                  disabled={busy || support !== 'supported'}
                  loading={jobForThis?.kind === 'install' && jobRunning}
                  onClick={() => void controller.install(app.id)}
                >
                  Install on Reachy
                </ActionButton>
              )}

              {installed && !isLive && (
                <ActionButton
                  primary
                  icon={<PlayArrowRoundedIcon />}
                  disabled={busy}
                  loading={pending?.kind === 'start' && pending.name === name}
                  onClick={handleStart}
                >
                  {crashed ? 'Start again' : 'Start'}
                </ActionButton>
              )}

              {installed && isLive && (
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <ActionButton
                    primary
                    icon={<StopRoundedIcon />}
                    disabled={busy}
                    loading={pending?.kind === 'stop'}
                    onClick={() => void controller.stop()}
                  >
                    Stop
                  </ActionButton>
                  <ActionButton
                    icon={<RestartAltRoundedIcon />}
                    disabled={busy}
                    loading={pending?.kind === 'restart'}
                    onClick={() => void controller.restart()}
                  >
                    Restart
                  </ActionButton>
                </Box>
              )}

              {installed && !isLive && support === 'supported' && (
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <ActionButton
                    icon={<SystemUpdateAltRoundedIcon />}
                    disabled={busy || installed.spaceId === null}
                    loading={jobForThis?.kind === 'update' && jobRunning}
                    onClick={() => void controller.update(installed.name)}
                  >
                    Update
                  </ActionButton>
                  <ActionButton
                    danger
                    icon={<DeleteOutlineIcon />}
                    disabled={busy}
                    loading={jobForThis?.kind === 'remove' && jobRunning}
                    onClick={() => setConfirm({ kind: 'uninstall' })}
                  >
                    Uninstall
                  </ActionButton>
                </Box>
              )}

              {/* An orphan the catalog does not list has no Space to open
                  (or to install from: its bare name is no Space id). */}
              {hasSpaceId(app) && (
                <Button
                  variant="text"
                  size="small"
                  endIcon={<OpenInNewIcon sx={{ fontSize: TYPO.md }} />}
                  onClick={() => void openExternalUrl(app.spaceUrl)}
                  sx={{ alignSelf: 'center', textTransform: 'none', fontSize: TYPO.xs, mt: 0.5 }}
                >
                  View on Hugging Face
                </Button>
              )}
            </Box>
          </Box>
        )}
      </Drawer>

      <Dialog open={confirm !== null} onClose={() => setConfirm(null)}>
        <DialogTitle sx={{ fontSize: TYPO.lg }}>
          {confirm?.kind === 'replace' ? `Stop ${confirm.running}?` : `Uninstall ${app?.name}?`}
        </DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: TYPO.body }}>
            {confirm?.kind === 'replace'
              ? `Reachy runs one app at a time. ${confirm.running} will stop so ${app?.name} can start.`
              : 'It will be removed from Reachy. You can install it again from the store.'}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>Cancel</Button>
          <Button
            color={confirm?.kind === 'uninstall' ? 'error' : 'primary'}
            onClick={confirmAction}
          >
            {confirm?.kind === 'replace' ? 'Stop and start' : 'Uninstall'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function StatusChip({
  installed,
  isLive,
  starting,
  crashed,
}: {
  installed: boolean;
  isLive: boolean;
  starting: boolean;
  crashed: boolean;
}) {
  if (crashed) return <Chip size="small" color="error" label="Crashed" />;
  if (starting) return <Chip size="small" color="primary" variant="outlined" label="Starting" />;
  if (isLive)
    return (
      <Chip
        size="small"
        label="Running"
        sx={{ bgcolor: STATUS.success, color: '#fff', fontWeight: FONT_WEIGHT.semibold }}
      />
    );
  if (installed) return <Chip size="small" variant="outlined" label="Installed" />;
  return null;
}

function JobProgress({
  job,
  showFullLog,
  onToggleLog,
  onDismiss,
}: {
  job: RobotAppJob;
  showFullLog: boolean;
  onToggleLog: () => void;
  onDismiss: () => void;
}) {
  const failed = job.status === 'failed';
  const done = job.status === 'done';
  const lines = showFullLog ? job.logs : job.logs.slice(-LOG_TAIL_LINES);
  return (
    <Box
      sx={{
        mb: 2,
        p: 1.5,
        borderRadius: `${RADIUS.lg}px`,
        border: 1,
        borderColor: failed ? 'error.main' : 'divider',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography sx={{ fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.semibold }}>
          {describeJobPhase(job)}
        </Typography>
        {failed && (
          <Button size="small" onClick={onDismiss} sx={{ textTransform: 'none', minWidth: 0 }}>
            Dismiss
          </Button>
        )}
      </Box>
      {!failed && (
        <LinearProgress
          variant={done ? 'determinate' : 'indeterminate'}
          value={100}
          sx={{ borderRadius: RADIUS.pill, mb: lines.length ? 1 : 0 }}
        />
      )}
      {lines.length > 0 && <LogBlock lines={lines} scroll={showFullLog} />}
      {job.logs.length > LOG_TAIL_LINES && (
        <Button size="small" onClick={onToggleLog} sx={{ textTransform: 'none', mt: 0.5, p: 0 }}>
          {showFullLog ? 'Show less' : 'Show full log'}
        </Button>
      )}
    </Box>
  );
}

function LogBlock({ lines, scroll = false }: { lines: string[]; scroll?: boolean }) {
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        fontFamily: 'monospace',
        fontSize: TYPO.micro,
        lineHeight: 1.5,
        color: 'text.secondary',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: scroll ? 240 : undefined,
        overflowY: scroll ? 'auto' : undefined,
      }}
    >
      {lines.join('\n')}
    </Box>
  );
}

function ActionButton({
  children,
  icon,
  onClick,
  disabled,
  loading,
  primary = false,
  danger = false,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <Button
      fullWidth
      variant={primary ? 'contained' : 'outlined'}
      color={danger ? 'error' : 'primary'}
      startIcon={loading ? <CircularProgress size={16} color="inherit" /> : icon}
      disabled={disabled || loading}
      onClick={onClick}
      disableElevation
      sx={{
        textTransform: 'none',
        fontWeight: FONT_WEIGHT.semibold,
        borderRadius: `${RADIUS.md}px`,
        py: 1,
      }}
    >
      {children}
    </Button>
  );
}
