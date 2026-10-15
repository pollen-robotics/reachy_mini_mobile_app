/**
 * Store page for Python apps: the ones that install and run on the robot.
 *
 * A flat, searchable list (official first, then by likes), windowed like the
 * web store's search results since the catalog runs to hundreds of entries.
 * Each tile opens the app's sheet; "Get" when it is not on the robot yet,
 * "Open" when it is.
 */
import { useDeferredValue, useMemo, useState, type ReactNode, type RefObject } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  InputAdornment,
  TextField,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';

import type { AppEntry } from '@/features/apps/types';
import { findInstalled } from '@/features/robot-apps/catalog';
import type { InstalledRobotApp } from '@/features/robot-apps/types';
import { TYPO } from '@/ui/design/tokens';

import VirtualAppList from '../VirtualAppList';
import { COLUMN_SX } from '../layout';

interface RobotAppsStoreProps {
  header: ReactNode;
  apps: readonly AppEntry[] | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  installed: readonly InstalledRobotApp[] | null;
  scrollRef: RefObject<HTMLElement | null>;
  onOpenApp: (app: AppEntry) => void;
}

function matches(app: AppEntry, query: string): boolean {
  return [app.name, app.id, app.description, app.author ?? '', ...app.tags].some(field =>
    field.toLowerCase().includes(query)
  );
}

export default function RobotAppsStore({
  header,
  apps,
  loading,
  failed,
  onRetry,
  installed,
  scrollRef,
  onOpenApp,
}: RobotAppsStoreProps) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  const visible = useMemo(
    () => (apps ?? []).filter(app => !deferredQuery || matches(app, deferredQuery)),
    [apps, deferredQuery]
  );

  return (
    <>
      {header}
      <Box sx={{ ...COLUMN_SX, px: 2, py: 1.5 }}>
        <TextField
          fullWidth
          size="small"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={apps ? `Search ${apps.length} robot apps` : 'Search robot apps'}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
      </Box>

      {loading && !apps && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress size={28} />
        </Box>
      )}
      {failed && !apps && (
        <Box sx={{ ...COLUMN_SX, py: 4, textAlign: 'center' }}>
          <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', mb: 1 }}>
            Could not load the robot apps.
          </Typography>
          <Button size="small" onClick={onRetry}>
            Retry
          </Button>
        </Box>
      )}
      {apps && visible.length === 0 && (
        <Box sx={{ ...COLUMN_SX, pt: 2 }}>
          <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }}>
            No robot apps match "{query.trim()}".
          </Typography>
        </Box>
      )}
      {visible.length > 0 && (
        <VirtualAppList
          apps={visible}
          scrollRef={scrollRef}
          onOpen={onOpenApp}
          actionLabel={app => (findInstalled(app, installed) ? 'Open' : 'Get')}
        />
      )}
    </>
  );
}
