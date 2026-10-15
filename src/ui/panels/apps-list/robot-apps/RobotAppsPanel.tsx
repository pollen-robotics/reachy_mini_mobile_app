/**
 * "On your robot" panel at the top of the Apps launcher: the Python apps
 * installed on the robot, which one runs, and a one-tap start / stop.
 *
 * Tapping a row opens the app's sheet for everything else (restart, update,
 * uninstall, crash details). A running app is always shown, even on a daemon
 * too old to list what is installed, so the user can stop it from the phone.
 */
import { Box, Button, CircularProgress, IconButton, Typography } from '@mui/material';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import StopRoundedIcon from '@mui/icons-material/StopRounded';

import type { AppEntry } from '@/features/apps/types';
import { CONV_APP_NAME } from '@/features/conv-app/client';
import { findCatalogEntry, installedAsEntry } from '@/features/robot-apps/catalog';
import { describeJobPhase } from '@/features/robot-apps/job-phase';
import type { InstalledRobotApp } from '@/features/robot-apps/types';
import type { RobotAppsHandle } from '@/features/robot-apps/useRobotApps';
import { FONT_WEIGHT, RADIUS, STATUS, TYPO } from '@/ui/design/tokens';

import AppIcon from '../AppIcon';
import { COLUMN_SX } from '../layout';

interface RobotAppsPanelProps {
  robotApps: RobotAppsHandle;
  catalog: readonly AppEntry[] | undefined;
  onOpenApp: (app: AppEntry) => void;
  onBrowse: () => void;
  /** Start `name`, letting the host confirm replacing another app. */
  onStart: (app: AppEntry, name: string) => void;
}

export default function RobotAppsPanel({
  robotApps,
  catalog,
  onOpenApp,
  onBrowse,
  onStart,
}: RobotAppsPanelProps) {
  const { snapshot, controller } = robotApps;
  const { installed, running, job, pending, support, online } = snapshot;

  const live = running.state === 'running' || running.state === 'starting';
  // Unknown to the installed list (old daemon, list not loaded yet) but
  // holding the slot: still show it, so it can be stopped.
  const orphanRunning =
    running.name && running.state !== 'idle' && !installed?.some(i => i.name === running.name)
      ? running.name
      : null;

  if (support === 'unsupported' && !orphanRunning) return null;
  if (installed === null && !orphanRunning) return null;

  // The Talk tab owns the conversation app: listed only while it holds the
  // slot (a teardown still under way, a crash), so it can be stopped.
  const rows: InstalledRobotApp[] = (installed ?? []).filter(
    app => app.name !== CONV_APP_NAME || running.name === CONV_APP_NAME
  );
  if (orphanRunning) {
    rows.unshift({
      name: orphanRunning,
      spaceId: null,
      title: null,
      description: '',
      emoji: null,
      private: false,
      customAppUrl: null,
    });
  }
  const jobRunning = job !== null && (job.status === 'pending' || job.status === 'in_progress');

  return (
    <Box sx={{ ...COLUMN_SX, pt: 2, pb: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', mb: 1 }}>
        <Typography sx={{ fontSize: TYPO.lg, fontWeight: FONT_WEIGHT.bold }}>
          On your robot
        </Typography>
        {!online ? (
          <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }} noWrap>
            Reconnecting to Reachy…
          </Typography>
        ) : (
          jobRunning &&
          job && (
            <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }} noWrap>
              {describeJobPhase(job)}
              {job.appName ? ` ${job.appName}` : ''}…
            </Typography>
          )
        )}
      </Box>

      {rows.length === 0 ? (
        <Box
          sx={{
            p: 2,
            borderRadius: `${RADIUS.lg}px`,
            border: 1,
            borderColor: 'divider',
            borderStyle: 'dashed',
          }}
        >
          <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', mb: 1 }}>
            Install apps that run on Reachy itself, even when your phone is away.
          </Typography>
          <Button size="small" variant="outlined" onClick={onBrowse} sx={{ textTransform: 'none' }}>
            Browse robot apps
          </Button>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {rows.map(app => {
            const entry = findCatalogEntry(app, catalog) ?? installedAsEntry(app);
            const isThis = running.name === app.name;
            const isLive = isThis && live;
            const crashed = isThis && running.state === 'error';
            const pendingHere =
              pending !== null &&
              (pending.name === app.name || (pending.kind === 'start' && isThis));
            return (
              <Box
                key={app.name}
                role="button"
                tabIndex={0}
                onClick={() => onOpenApp(entry)}
                onKeyDown={e => {
                  if (e.key === 'Enter') onOpenApp(entry);
                }}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  p: 1.25,
                  borderRadius: `${RADIUS.lg}px`,
                  border: 1,
                  borderColor: crashed ? 'error.main' : isLive ? STATUS.success : 'divider',
                  cursor: 'pointer',
                  '&:hover': { bgcolor: 'action.hover' },
                }}
              >
                <AppIcon app={entry} size={40} />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography sx={{ fontSize: TYPO.md, fontWeight: FONT_WEIGHT.semibold }} noWrap>
                    {entry.name}
                  </Typography>
                  <Typography
                    sx={{
                      fontSize: TYPO.xs,
                      color: crashed
                        ? 'error.main'
                        : isLive
                          ? STATUS.successSoft
                          : 'text.secondary',
                    }}
                    noWrap
                  >
                    {crashed
                      ? 'Crashed. Tap for details'
                      : isThis && running.state === 'starting'
                        ? 'Starting…'
                        : isThis && running.state === 'stopping'
                          ? 'Stopping…'
                          : isLive
                            ? 'Running'
                            : entry.description || 'Installed'}
                  </Typography>
                </Box>
                {pendingHere ? (
                  <CircularProgress size={22} sx={{ mx: 1 }} />
                ) : isLive ? (
                  <IconButton
                    aria-label={`Stop ${entry.name}`}
                    disabled={pending !== null || !online}
                    onClick={e => {
                      e.stopPropagation();
                      void controller.stop();
                    }}
                  >
                    <StopRoundedIcon />
                  </IconButton>
                ) : (
                  <IconButton
                    aria-label={`Start ${entry.name}`}
                    color="primary"
                    disabled={pending !== null || jobRunning || !online}
                    onClick={e => {
                      e.stopPropagation();
                      onStart(entry, app.name);
                    }}
                  >
                    <PlayArrowRoundedIcon />
                  </IconButton>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
