/**
 * NfcSettingsSection - the "NFC" block of the Settings panel.
 *
 * Same content as the desktop app's NFC Reader card (on/off switch, the
 * reader's state, the tag on it, rewrite / erase that tag, and the add-on
 * pitch when no reader is fitted), laid out with the panel's own
 * primitives so it reads like the Audio and Privacy sections around it.
 *
 * The reader handle comes from the session screen, which polls it for
 * the topbar's NFC pill too (`useNfcReader`, JSON-RPC `nfc.*`).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Box,
  ButtonBase,
  CircularProgress,
  Stack,
  TextField,
  Typography,
  alpha,
  useTheme,
} from '@mui/material';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import EditRoundedIcon from '@mui/icons-material/EditRounded';
import NfcRoundedIcon from '@mui/icons-material/NfcRounded';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';

import {
  describeTagError,
  needsFullErase,
  type NfcRecord,
  type NfcStatus,
  type UseNfcReaderResult,
} from '@/features/nfc';
import { openExternalUrl } from '@/shared/tauri/openUrl';
import { OutlinedSwitch } from '@/ui/design/OutlinedSwitch';
import { FONT_WEIGHT, RADIUS, STATUS, TYPO } from '@/ui/design/tokens';

import { Card, Row, Section, ghostBtnSx } from './settingsLayout';

/** Same page as the conversation app's "Get the NFC add-on". */
const ADD_ON_STORE_URL = 'https://store.pollen-robotics.com/collections/reachy-mini';

/** The daemon refuses more than this; the tag's own capacity is smaller still. */
const MAX_WRITE_CHARS = 860;

type WriteKind = 'text' | 'uri';

// A reader the daemon cannot find gets its own body (see `absent`), so these
// only cover the daemon not answering, the switch off, and a live reader.
function readerTitle(status: NfcStatus | null): string {
  if (!status) return 'Unknown';
  if (status.enabled === false) return 'Reader switched off';
  return 'Reader connected';
}

/** Null when the title says it all. */
function readerDetail(status: NfcStatus | null, fetchError: string | null): string | null {
  if (!status) return fetchError ?? 'Waiting for the robot…';
  if (status.enabled === false) return 'Turn it on to read tags.';
  return null;
}

function recordValue(record: NfcRecord): string {
  return record.value ?? [record.type_name, record.data_hex].filter(Boolean).join(' ');
}

/** What the editor opens on: the tag's first text or URI record, if any. */
function editableContent(records: NfcRecord[]): { kind: WriteKind; value: string } {
  const record = records.find(r => (r.kind === 'text' || r.kind === 'uri') && r.value);
  if (!record) return { kind: 'text', value: '' };
  return { kind: record.kind as WriteKind, value: record.value ?? '' };
}

export interface NfcSettingsSectionProps {
  reader: UseNfcReaderResult;
  /** Changes on each tap on the topbar's NFC pill: bring this section
   *  into view. 0 = leave the scroll alone. */
  focusKey?: number;
}

export function NfcSettingsSection({ reader, focusKey = 0 }: NfcSettingsSectionProps) {
  const theme = useTheme();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { status, tag, state, isErasing, isWriting, writeResult, eraseResult, clearResults } =
    reader;

  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [writeKind, setWriteKind] = useState<WriteKind>('text');
  const [draft, setDraft] = useState('');

  const tagUid = tag?.present ? tag.uid : null;
  const records = tag?.records ?? [];
  const fullErase = needsFullErase(tag);
  const busy = isErasing || isWriting;
  const result = writeResult ?? eraseResult;

  useEffect(() => {
    if (focusKey) rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focusKey]);

  // A result, a pending confirmation or an open editor belongs to the tag it
  // was about.
  useEffect(() => {
    setConfirming(false);
    setEditing(false);
    if (!busy) clearResults();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagUid]);

  const startEditing = (): void => {
    const { kind, value } = editableContent(records);
    setWriteKind(kind);
    setDraft(value);
    clearResults();
    setEditing(true);
  };

  const submitWrite = (): void => {
    setEditing(false);
    void reader.write(writeKind === 'uri' ? { uri: draft.trim() } : { text: draft });
  };

  const kickerSx = {
    fontSize: TYPO.tiny,
    fontWeight: FONT_WEIGHT.semibold,
    color: 'text.secondary',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  } as const;
  const monoSx = { fontFamily: 'monospace', fontSize: TYPO.xs, color: 'text.secondary' } as const;
  const actionBtnSx = (color: string, disabled = false) =>
    ({
      ...ghostBtnSx(color),
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 0.75,
      py: 0.75,
      fontSize: TYPO.sm,
      fontWeight: FONT_WEIGHT.semibold,
      border: `1.5px solid ${alpha(color, 0.45)}`,
      opacity: disabled ? 0.5 : 1,
      cursor: disabled ? 'default' : 'pointer',
    }) as const;

  // The daemon answers but finds no board: most robots have no add-on, so
  // present it rather than a reader with nothing to do. A reader switched off
  // keeps the full card, since its switch is the way back on.
  const absent = status !== null && !status.connected && status.enabled !== false;

  // Every layout sits in the same anchor, for the scroll above.
  const anchored = (node: ReactNode) => (
    <Box ref={rootRef} sx={{ scrollMarginTop: 16 }}>
      {node}
    </Box>
  );

  if (absent) {
    return anchored(
      <Section label="NFC" blurb="Tags placed on Reachy's NFC reader.">
        <Card>
          <Stack spacing={1.5} sx={{ px: 2, py: 2 }}>
            <Stack sx={{ flexDirection: 'row', alignItems: 'center', gap: 1.5 }}>
              <NfcRoundedIcon sx={{ fontSize: TYPO.xl, color: 'text.secondary', flexShrink: 0 }} />
              <Typography sx={{ fontSize: TYPO.body, fontWeight: FONT_WEIGHT.medium }}>
                No NFC reader detected
              </Typography>
            </Stack>
            <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary', lineHeight: 1.5 }}>
              Pop a hat on Reachy Mini and watch its personality change! The Conversation app reads
              the hat's NFC tag and takes on its character.
            </Typography>
            <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary', lineHeight: 1.5 }}>
              Got an idea? Tag any object and make it trigger your own behaviors in your apps.
            </Typography>
            <Box
              component="button"
              type="button"
              onClick={() => void openExternalUrl(ADD_ON_STORE_URL)}
              sx={{
                ...actionBtnSx(theme.palette.primary.main),
                flex: 'none',
                width: '100%',
                bgcolor: alpha(theme.palette.primary.main, 0.05),
              }}
            >
              Get the NFC add-on
              <OpenInNewRoundedIcon sx={{ fontSize: TYPO.md }} />
            </Box>
            {!status.driver_available && (
              <Typography sx={{ fontSize: TYPO.tiny, color: 'text.disabled', textAlign: 'center' }}>
                Already fitted? Install reachy_mini[nfc] on the robot.
              </Typography>
            )}
          </Stack>
        </Card>
      </Section>
    );
  }

  const detail = readerDetail(status, reader.fetchError);
  const actionsDisabled = !tag?.present || busy;
  // No tag, nothing to act on: the footer only stays for an operation
  // still running or the error it ended with.
  const showFooter = tag?.present || busy || (result !== null && !result.success);

  return anchored(
    <Section label="NFC" blurb="Tags placed on Reachy's NFC reader.">
      <Card>
        {/* Reader: state + on/off switch. */}
        <Row divider={false}>
          <NfcRoundedIcon sx={{ fontSize: TYPO.xl, color: 'text.secondary', flexShrink: 0 }} />
          <Stack sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontSize: TYPO.body, fontWeight: FONT_WEIGHT.medium }}>
              {readerTitle(status)}
              {status?.connected && status.board_version && (
                <Box
                  component="span"
                  sx={{
                    ml: 0.75,
                    fontSize: TYPO.tiny,
                    fontWeight: FONT_WEIGHT.regular,
                    color: 'text.disabled',
                  }}
                >
                  version {status.board_version}
                </Box>
              )}
            </Typography>
            {detail && (
              <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary', mt: 0.25 }}>
                {detail}
              </Typography>
            )}
            {status && !reader.canToggle && (
              <Typography sx={{ fontSize: TYPO.xs, color: 'text.disabled', mt: 0.25 }}>
                This robot software cannot switch the reader off.
              </Typography>
            )}
            {reader.toggleError && (
              <Typography sx={{ fontSize: TYPO.xs, color: 'error.main', mt: 0.25 }}>
                {reader.toggleError}
              </Typography>
            )}
          </Stack>
          <OutlinedSwitch
            checked={state !== 'disabled'}
            onChange={(_, checked) => void reader.setEnabled(checked)}
            disabled={!reader.canToggle || reader.isToggling || isErasing}
            slotProps={{ input: { 'aria-label': 'NFC reader on' } }}
          />
        </Row>

        {/* Tag on the reader. */}
        <Row divider>
          <Stack spacing={1} sx={{ flex: 1, minWidth: 0 }}>
            <Stack sx={{ flexDirection: 'row', alignItems: 'center', gap: 0.75 }}>
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  flexShrink: 0,
                  borderRadius: '50%',
                  bgcolor: state === 'tag' ? STATUS.success : 'text.disabled',
                }}
              />
              {/* lineHeight 1: the caps then sit level with the dot. */}
              <Typography sx={{ ...kickerSx, lineHeight: 1 }}>
                {tag?.present ? 'Tag' : 'No tag'}
              </Typography>
              {tag?.present && tag.model && (
                <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary', ml: 'auto' }}>
                  {tag.model}
                  {tag.capacity != null && ` · ${tag.capacity} bytes`}
                </Typography>
              )}
            </Stack>

            {!tag?.present ? (
              <Typography
                sx={{ fontSize: TYPO.sm, color: 'text.secondary', textAlign: 'center', py: 2 }}
              >
                {state === 'disabled'
                  ? 'Reader is off'
                  : state === 'unavailable'
                    ? 'No reader to read from'
                    : 'Place a tag on the reader'}
              </Typography>
            ) : (
              <>
                <Stack sx={{ flexDirection: 'row', alignItems: 'baseline', gap: 1 }}>
                  <Typography sx={{ ...kickerSx, minWidth: 56 }}>UID</Typography>
                  <Typography sx={{ ...monoSx, wordBreak: 'break-all' }}>
                    {tag.uid ?? '—'}
                  </Typography>
                </Stack>
                <Stack sx={{ flexDirection: 'row', alignItems: 'baseline', gap: 1 }}>
                  <Typography sx={{ ...kickerSx, minWidth: 56 }}>Content</Typography>
                  <Stack spacing={0.5} sx={{ minWidth: 0, flex: 1 }}>
                    {tag.blank ? (
                      <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary' }}>
                        Blank tag
                      </Typography>
                    ) : records.length > 0 ? (
                      records.map((record, i) => (
                        <Stack
                          key={i}
                          sx={{ flexDirection: 'row', alignItems: 'baseline', gap: 0.75 }}
                        >
                          <Typography
                            sx={{
                              fontSize: TYPO.micro,
                              fontWeight: FONT_WEIGHT.semibold,
                              color: 'text.secondary',
                              textTransform: 'uppercase',
                              px: 0.5,
                              borderRadius: `${RADIUS.xs}px`,
                              border: `1px solid ${theme.palette.divider}`,
                              flexShrink: 0,
                            }}
                          >
                            {record.kind}
                          </Typography>
                          <Typography sx={{ fontSize: TYPO.sm, wordBreak: 'break-all' }}>
                            {recordValue(record)}
                          </Typography>
                        </Stack>
                      ))
                    ) : tag.raw_hex ? (
                      <Typography sx={{ ...monoSx, wordBreak: 'break-all' }}>
                        {tag.raw_hex}…
                      </Typography>
                    ) : (
                      <Typography sx={{ fontSize: TYPO.sm, color: STATUS.warning }}>
                        {tag.error ?? 'Content could not be read'}
                      </Typography>
                    )}
                  </Stack>
                </Stack>
                {/* A quiet acknowledgement: the content above already shows
                    what changed. */}
                {result?.success && (
                  <Stack
                    direction="row"
                    spacing={0.5}
                    sx={{ alignItems: 'center', color: STATUS.success }}
                  >
                    <CheckRoundedIcon sx={{ fontSize: 16 }} />
                    <Typography
                      component="span"
                      sx={{ fontSize: TYPO.xs, fontWeight: FONT_WEIGHT.semibold }}
                    >
                      {writeResult ? 'Tag written' : 'Tag erased'}
                    </Typography>
                  </Stack>
                )}
              </>
            )}
          </Stack>
        </Row>

        {/* Actions: padded footer, like Clear memory under its toggle. */}
        {showFooter && (
          <Stack spacing={1.5} sx={{ px: 2, pb: 2 }}>
            {editing ? (
              <>
                <Typography component="label" htmlFor="nfc-tag-content" sx={kickerSx}>
                  Tag content
                </Typography>
                <Stack direction="row" spacing={1}>
                  {(['text', 'uri'] as const).map(kind => {
                    const selected = kind === writeKind;
                    return (
                      <ButtonBase
                        key={kind}
                        onClick={() => setWriteKind(kind)}
                        aria-pressed={selected}
                        sx={{
                          px: 1.5,
                          py: 0.75,
                          borderRadius: `${RADIUS.sm}px`,
                          fontSize: TYPO.sm,
                          fontWeight: FONT_WEIGHT.semibold,
                          color: selected ? 'primary.main' : 'text.primary',
                          bgcolor: selected
                            ? alpha(theme.palette.primary.main, 0.1)
                            : 'background.paper',
                          // Constant border width: toggling never resizes the chip.
                          border: `1.5px solid ${
                            selected ? theme.palette.primary.main : theme.palette.divider
                          }`,
                          WebkitTapHighlightColor: 'transparent',
                        }}
                      >
                        {kind === 'text' ? 'Text' : 'Link'}
                      </ButtonBase>
                    );
                  })}
                </Stack>
                <TextField
                  id="nfc-tag-content"
                  autoFocus
                  fullWidth
                  multiline={writeKind === 'text'}
                  maxRows={4}
                  placeholder={writeKind === 'uri' ? 'https://…' : 'Content to write'}
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Escape') setEditing(false);
                    if (e.key === 'Enter' && !e.shiftKey && draft.trim()) {
                      e.preventDefault();
                      submitWrite();
                    }
                  }}
                  slotProps={{
                    htmlInput: {
                      maxLength: MAX_WRITE_CHARS,
                      // Links: no autocorrect or capitalised first letter.
                      ...(writeKind === 'uri' && {
                        inputMode: 'url',
                        autoCapitalize: 'none',
                        autoCorrect: 'off',
                      }),
                    },
                  }}
                />
                {records.length > 1 && (
                  <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }}>
                    Replaces all {records.length} records on the tag.
                  </Typography>
                )}
                <Stack direction="row" spacing={1}>
                  <Box
                    component="button"
                    type="button"
                    onClick={() => setEditing(false)}
                    sx={actionBtnSx(theme.palette.text.secondary)}
                  >
                    Cancel
                  </Box>
                  <Box
                    component="button"
                    type="button"
                    onClick={submitWrite}
                    disabled={!draft.trim()}
                    sx={actionBtnSx(theme.palette.primary.main, !draft.trim())}
                  >
                    Write
                  </Box>
                </Stack>
              </>
            ) : confirming ? (
              <>
                <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', lineHeight: 1.4 }}>
                  {fullErase ? 'Wipe the whole tag memory?' : 'Erase this tag?'}
                </Typography>
                <Stack direction="row" spacing={1}>
                  <Box
                    component="button"
                    type="button"
                    onClick={() => setConfirming(false)}
                    sx={actionBtnSx(theme.palette.primary.main)}
                  >
                    Cancel
                  </Box>
                  <Box
                    component="button"
                    type="button"
                    onClick={() => {
                      setConfirming(false);
                      void reader.erase(fullErase);
                    }}
                    sx={actionBtnSx(theme.palette.error.main)}
                  >
                    Erase
                  </Box>
                </Stack>
              </>
            ) : tag?.present || busy ? (
              <Stack direction="row" spacing={1}>
                <Box
                  component="button"
                  type="button"
                  onClick={startEditing}
                  disabled={actionsDisabled}
                  sx={actionBtnSx(theme.palette.primary.main, actionsDisabled)}
                >
                  {isWriting ? (
                    <CircularProgress size={12} thickness={5} color="inherit" />
                  ) : (
                    <EditRoundedIcon sx={{ fontSize: TYPO.md }} />
                  )}
                  {isWriting ? 'Writing…' : 'Modify'}
                </Box>
                <Box
                  component="button"
                  type="button"
                  onClick={() => {
                    clearResults();
                    setConfirming(true);
                  }}
                  disabled={actionsDisabled}
                  sx={{
                    ...actionBtnSx(theme.palette.error.main, actionsDisabled),
                    bgcolor: alpha(theme.palette.error.main, 0.05),
                  }}
                >
                  {isErasing ? (
                    <CircularProgress size={12} thickness={5} color="inherit" />
                  ) : (
                    <DeleteOutlineRoundedIcon sx={{ fontSize: TYPO.md }} />
                  )}
                  {isErasing ? 'Erasing…' : fullErase ? 'Wipe tag' : 'Erase tag'}
                </Box>
              </Stack>
            ) : null}

            {fullErase && !result && !editing && (
              <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary', lineHeight: 1.4 }}>
                Not an NDEF tag: the whole memory is wiped, which takes a few seconds.
              </Typography>
            )}

            {result && !result.success && (
              <Typography sx={{ fontSize: TYPO.xs, color: 'error.main', lineHeight: 1.4 }}>
                {describeTagError(result.error)}
              </Typography>
            )}
          </Stack>
        )}
      </Card>
    </Section>
  );
}
