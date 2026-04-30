/**
 * ConversationView - the post-handshake surface.
 *
 * Mounted from the 'engine' phase onward (the ConversePanel's
 * DataChannel IS the daemon proxy transport, so wake-up needs it
 * before the user sees anything). The component itself only renders
 * meaningful chrome from 'ready' on.
 *
 * Phase mapping:
 *   'engine'  - panel mounted but covered by the parent's bring-up
 *               overlay; chrome (banner, tabs) hidden.
 *   'ready'   - the orb itself takes the role of the "Start
 *               conversation" CTA (state='ready' on the orb). Bottom-
 *               nav + tabs become visible so the user can preview the
 *               apps tab even before opting in to the conversation.
 *   'live'    - full UI: SessionBanner if degraded, conversation
 *               engine front and center.
 *
 * The split between 'ready' and 'live' is deliberate. We don't auto-
 * start the conversation pipeline on wake: starting audio is a
 * deliberate user action, and the gating gives the daemon a moment to
 * settle.
 */
import { Box, BottomNavigation, BottomNavigationAction, Chip, Stack, Typography, useTheme } from '@mui/material';
import AppsIcon from '@mui/icons-material/Apps';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import { useState } from 'react';

import OutdatedDaemonBanner from '../../components/OutdatedDaemonBanner';
import SessionBanner from '../../components/SessionBanner';
import { ConversePanel } from '../../conversation/ConversePanel';
import type { SessionController } from '../../session/useSessionController';

export interface ConversationViewProps {
  controller: SessionController;
  isAuthenticated: boolean;
}

export function ConversationView({
  controller,
  isAuthenticated: _isAuthenticated,
}: ConversationViewProps) {
  const theme = useTheme();
  const [activeTab, setActiveTab] = useState<'converse' | 'apps'>('converse');

  const phase = controller.state.phase;
  const live = phase === 'live';
  const chromeVisible = phase === 'ready' || phase === 'live';

  // Apps tab is currently a placeholder while we redesign the
  // catalog: we show the bottom-nav entry so users know it's coming
  // back, but the body just surfaces a "Coming soon" stub. Once the
  // new app catalog ships we'll replace the stub with `<AppsPanel>`
  // again (and bring back the auth + RobotClient gating that was
  // attached to it in api_revision 3).
  const showAppsTab = true;

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: theme.palette.background.paper,
      }}
    >
      {/* Health banner is only meaningful while the engine is actually
          running. In 'ready' the chrome is up but the engine isn't,
          so there's nothing to be "degraded" about yet. */}
      {live ? (
        <SessionBanner
          health={controller.sessionHealth}
          onRetry={controller.retry}
          onDisconnect={controller.back}
        />
      ) : null}
      {live && controller.daemonVersion?.outdated ? (
        <OutdatedDaemonBanner daemonVersion={controller.daemonVersion.version} />
      ) : null}

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: activeTab === 'converse' ? 'flex' : 'none',
          flexDirection: 'column',
          position: 'relative',
        }}
      >
        {/* The engine is mounted from 'engine' phase onward in both
            modes (the DC IS the daemon transport). During 'ready' we
            don't cover it with an overlay anymore: the orb itself
            takes the role of the "Start conversation" CTA, courtesy
            of the `startInvitation` prop below. That keeps a single
            visual anchor on the screen across phases - same orb,
            different state. */}
        <ConversePanel
          peerId={controller.peerId}
          peerIdResolved={controller.peerIdResolved}
          remountKey={controller.state.remountEpoch}
          onAppStateChange={controller.onEngineStateChange}
          onEngineErrorMessage={controller.onEngineErrorMessage}
          onStuck={controller.onEngineStuck}
          busyLabel={controller.conversationBusyLabel}
          errorMessage={controller.conversationErrorMessage}
          convoActive={controller.convoActive}
          onTransportChange={controller.onEngineTransport}
          startInvitation={
            phase === 'ready' ? controller.startConversation : undefined
          }
        />
      </Box>

      {showAppsTab ? (
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: activeTab === 'apps' ? 'flex' : 'none',
            flexDirection: 'column',
          }}
        >
          <AppsComingSoon />
        </Box>
      ) : null}

      {chromeVisible && showAppsTab ? (
        <BottomNavigation
          showLabels
          value={activeTab}
          onChange={(_, value) => setActiveTab(value as 'converse' | 'apps')}
          sx={{
            borderTop: `1px solid ${theme.palette.divider}`,
            flexShrink: 0,
          }}
        >
          <BottomNavigationAction
            value="converse"
            label="Converse"
            icon={<GraphicEqIcon />}
          />
          <BottomNavigationAction
            value="apps"
            label={
              <Stack direction="row" alignItems="center" spacing={0.5}>
                <span>Apps</span>
                <Chip
                  label="Soon"
                  size="small"
                  sx={{
                    height: 14,
                    fontSize: '0.55rem',
                    fontWeight: 600,
                    '& .MuiChip-label': { px: 0.5 },
                  }}
                />
              </Stack>
            }
            icon={<AppsIcon />}
          />
        </BottomNavigation>
      ) : null}
    </Box>
  );
}

/**
 * Placeholder content for the Apps tab while the new catalog is being
 * redesigned. Kept as a tiny in-file component to avoid spinning up
 * a whole module for a stub. Once the redesign lands we'll swap this
 * out for `<AppsPanel>` and re-introduce the `client` /
 * `isAuthenticated` gating in the parent.
 */
function AppsComingSoon() {
  const theme = useTheme();
  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      spacing={1.5}
      sx={{ flex: 1, minHeight: 0, px: 4, textAlign: 'center' }}
    >
      <Box
        sx={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: theme.palette.action.hover,
          color: theme.palette.text.secondary,
        }}
      >
        <AppsIcon fontSize="medium" />
      </Box>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>
        Apps
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 280 }}>
        Coming soon. We're building a new way to bring extra
        experiences to your Reachy. Check back in a future update.
      </Typography>
    </Stack>
  );
}
