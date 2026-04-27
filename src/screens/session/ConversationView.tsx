/**
 * ConversationView - the post-handshake surface.
 *
 * Mounted from the 'engine' phase onward (the ConversePanel's
 * DataChannel IS the daemon proxy transport, so wake-up + daemon
 * status pill need it before the user sees anything). The component
 * itself only renders meaningful chrome from 'ready' on.
 *
 * Phase mapping:
 *   'engine'  - panel mounted but covered by the parent's bring-up
 *               overlay; chrome (banner, tabs, daemon pill) hidden.
 *   'ready'   - panel still hidden behind a CTA overlay. Bottom-nav
 *               + tabs become visible so the user can preview the
 *               apps tab even before opting in to the conversation.
 *   'live'    - full UI: SessionBanner if degraded, daemon pill in
 *               the corner, conversation engine front and center.
 *
 * The split between 'ready' and 'live' is deliberate. We don't auto-
 * start the conversation pipeline on wake: starting audio is a
 * deliberate user action, and the gating gives the daemon a moment to
 * settle.
 */
import { Box, BottomNavigation, BottomNavigationAction, Stack, useTheme } from '@mui/material';
import AppsIcon from '@mui/icons-material/Apps';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import { useState } from 'react';

import DaemonStatusPill from '../../components/DaemonStatusPill';
import OutdatedDaemonBanner from '../../components/OutdatedDaemonBanner';
import SessionBanner from '../../components/SessionBanner';
import { AppsPanel } from '../../conversation/AppsPanel';
import { ConversePanel } from '../../conversation/ConversePanel';
import type { SessionController } from '../../session/useSessionController';

import { HandshakeReadyView } from './HandshakeViews';

export interface ConversationViewProps {
  controller: SessionController;
  isAuthenticated: boolean;
}

export function ConversationView({
  controller,
  isAuthenticated,
}: ConversationViewProps) {
  const theme = useTheme();
  const [activeTab, setActiveTab] = useState<'converse' | 'apps'>('converse');

  const phase = controller.state.phase;
  const live = phase === 'live';
  const chromeVisible = phase === 'ready' || phase === 'live';

  // Apps tab now lives behind RobotClient (the same WebRTC channel),
  // so it's available remotely too. The remaining gate is "user is
  // signed in", which holds in both modes (LAN: daemon-side HF
  // token; remote: mobile-side HF token forwarded into the iframe by
  // AppsPanel).
  const showAppsTab = isAuthenticated && controller.robotClient !== null;

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
            modes (the DC IS the daemon transport). 'ready' covers it
            with the CTA below so the user always lands in the same
            post-connect chrome regardless of how they got here. */}
        <ConversePanel
          peerId={controller.peerId}
          peerIdResolved={controller.peerIdResolved}
          remountKey={controller.state.remountEpoch}
          onAppStateChange={controller.onEngineStateChange}
          onStuck={controller.onEngineStuck}
          busyLabel={controller.conversationBusyLabel}
          errorMessage={controller.conversationErrorMessage}
          convoActive={controller.convoActive}
          onTransportChange={controller.onEngineTransport}
        />
        {phase === 'ready' ? (
          <Stack
            alignItems="center"
            justifyContent="center"
            spacing={1.5}
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: 3,
              bgcolor: theme.palette.background.paper,
              px: 3,
              textAlign: 'center',
            }}
          >
            <HandshakeReadyView
              robotName={controller.displayName}
              onStart={controller.startConversation}
            />
          </Stack>
        ) : null}
        {live ? (
          <Box
            sx={{
              position: 'absolute',
              top: 8,
              right: 8,
              zIndex: 2,
              maxWidth: 'calc(100% - 16px)',
              pointerEvents: 'none',
            }}
          >
            <DaemonStatusPill probe={controller.daemonProbe} />
          </Box>
        ) : null}
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
          <AppsPanel
            client={controller.robotClient}
            isAuthenticated={isAuthenticated}
          />
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
            label="Apps"
            icon={<AppsIcon />}
          />
        </BottomNavigation>
      ) : null}
    </Box>
  );
}
