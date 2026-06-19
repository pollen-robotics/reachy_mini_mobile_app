/**
 * CreatePersonalityModal - full-screen "author your own persona" form.
 *
 * The personalities feature already ships the whole data layer
 * (`addCustomPersonality`, localStorage persistence, the `custom:<slug>`
 * id form) but never exposed a UI to author one. This overlay closes
 * that gap: it collects the user-facing knobs of a persona (name, tagline,
 * voice, instructions), hands them to `addCustomPersonality`, then
 * immediately makes the new persona the active one. The voice is chosen via
 * a picker that auditions a bundled sample on select.
 *
 * Structure
 * ─────────
 * This file is the ORCHESTRATOR: it owns the form state + side effects
 * (generation, sticker avatar, persona draft channel) and wires three
 * presentational pieces from `./create-personality`:
 *   - `CreatePersonalityHero`       - the create-mode "describe a vibe" landing
 *   - `CreatePersonalityGenerating` - the dedicated generate + reveal screen
 *   - `CreatePersonalityFields`     - the classic name/voice/tagline/instructions form
 *   - `CreatePersonalityActions`    - the sticky Create / Save+Delete plate
 * plus the logic hook `useVibeRoll`.
 *
 * Visual contract
 * ───────────────
 * Full-screen overlay (`position: fixed; inset: 0`) mirroring the
 * `EulaConsentModal` / `HelpAndSupportOverlay` pattern rather than a MUI
 * `Dialog`, because the rest of the app does fullscreen-from-the-root that
 * way and `Dialog`'s focus-trap fights the WebView keyboard on mobile.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, IconButton, Stack, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import {
  AVAILABLE_VOICES,
  DEFAULT_AVATAR_URL,
  DEFAULT_GLOW,
  GeneratePersonalityError,
  type GeneratedPersonality,
  type Personality,
  addCustomPersonality,
  clearPersonaDraft,
  removeCustomPersonality,
  setActivePersonality,
  setPersonaDraft,
  streamPersonality,
  updateCustomPersonality,
} from '@/features/personalities';
import { FONT_WEIGHT, LAYOUT, TYPO } from '@/ui/design/tokens';

import { useStickerAvatar } from './useStickerAvatar';
import {
  CreatePersonalityActions,
  CreatePersonalityFields,
  CreatePersonalityGenerating,
  CreatePersonalityHero,
  VIBE_MAX,
  useVibeRoll,
  useVoiceAudition,
} from './create-personality';

interface CreatePersonalityModalProps {
  /**
   * Fired when the overlay should close WITHOUT having created a
   * persona (close button, backdrop, Escape). The host clears its
   * open state in response.
   */
  onCancel: () => void;
  /**
   * Fired right after a persona is created/updated AND made active.
   * On create the host typically closes both the overlay and the
   * picker so the user lands back on the orb; on edit it just closes
   * the form back to the picker.
   */
  onCreated: () => void;
  /**
   * Edit an existing custom persona instead of authoring a new one.
   * When set the form pre-fills from this persona, the CTA becomes
   * "Save & use" (writing back to the same id), and a destructive
   * "Delete" affordance appears. Null/undefined = create mode.
   */
  editing?: Personality | null;
  /**
   * Fired after the edited persona has been deleted (edit mode only).
   * The host closes the form back to the picker, where the card is
   * now gone.
   */
  onDeleted?: () => void;
  /**
   * Render in-flow inside the host's body slot instead of as a
   * full-screen `position: fixed` overlay. In embedded mode the
   * persistent personality band stays visible ABOVE this form and
   * owns the title + the close affordance (its "+" becomes a "✕"), so
   * the modal drops its own sticky header to avoid a duplicate title /
   * close. Used by `ConversationPanel`; the standalone fullscreen mode
   * is kept for any caller that wants the classic overlay.
   */
  embedded?: boolean;
  /**
   * (Embedded mode) Fired when the form enters/leaves its full-panel "Meet"
   * phase (create-mode generation + reveal). The host uses it to hide its
   * persistent personality band so this view fills the panel area - WITHOUT
   * covering the app's top bar / bottom nav. Always fired with `false` on
   * unmount so a mid-reveal close can't strand the band hidden.
   */
  onImmersiveChange?: (immersive: boolean) => void;
}

export function CreatePersonalityModal({
  onCancel,
  onCreated,
  editing = null,
  onDeleted,
  embedded = false,
  onImmersiveChange,
}: CreatePersonalityModalProps) {
  const isEdit = editing !== null;

  // Seed from the persona under edit when present. Lazy initialisers are
  // enough because the host remounts the form (keyed by persona id /
  // "create") whenever the target changes.
  const [name, setName] = useState(() => editing?.name ?? '');
  const [tagline, setTagline] = useState(() => editing?.tagline ?? '');
  const [instructions, setInstructions] = useState(() => editing?.instructions ?? '');
  // Voice picker: seed from the persona under edit, else the first catalog
  // voice. Picking one auditions it (see `selectVoice`).
  const [voice, setVoice] = useState<string>(() => editing?.voice || AVAILABLE_VOICES[0]);

  // Two-step delete confirmation (edit mode only): the first tap arms it,
  // the second commits. Deleting a custom persona destroys the user's own
  // work, so we make it deliberate rather than one-tap.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // "Magic" generation (create mode only): the user types a one-line vibe
  // and we ask a model to author the knobs (name / tagline / instructions /
  // voice), then pre-fill the form below so they can tweak. The voice is
  // applied automatically (no picker), so it never surfaces in the form.
  // Kept out of edit mode so a regenerate never silently clobbers a persona
  // the user is deliberately editing.
  const [vibe, setVibe] = useState('');
  // Distinguish which button is spinning ('describe' = Generate from the
  // typed vibe, 'random' = Surprise me) so only the tapped one shows a
  // spinner while both stay disabled during a request.
  const [genMode, setGenMode] = useState<'describe' | 'random' | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const generating = genMode !== null;

  // Create-mode screen machine: the "describe a vibe" landing ('idea') hands
  // off to a dedicated full-screen generation view ('generating'), then to a
  // short celebratory beat ('reveal') once the persona is committed + active,
  // before the overlay closes. Edit mode and the manual on-ramp ignore this
  // (they use `detailsOpen` below).
  const [phase, setPhase] = useState<'idea' | 'generating' | 'reveal'>('idea');

  // Progressive disclosure. `detailsOpen` swaps the centred "magic" landing
  // (create mode) for the classic form; edit mode opens it straight away, and
  // the manual on-ramp flips it on.
  const [detailsOpen, setDetailsOpen] = useState(isEdit);

  // Map a generation failure onto the modal-facing error copy. Shared so the
  // (streaming) generate path stays lean and the messaging stays consistent.
  const reportGenError = useCallback((err: unknown) => {
    console.warn('[personalities] generation failed:', err);
    if (
      err instanceof GeneratePersonalityError &&
      err.reason === 'hf_token_missing'
    ) {
      setGenError('Sign in to Hugging Face first to generate a personality.');
    } else if (
      err instanceof GeneratePersonalityError &&
      err.reason === 'overloaded'
    ) {
      // Transient provider overload (429/503): not the user's fault and
      // retryable, so say so plainly instead of dumping a status code.
      setGenError('Hugging Face is busy right now - give it a moment and try again.');
    } else if (
      err instanceof GeneratePersonalityError &&
      err.reason === 'model_unavailable'
    ) {
      // None of the fallback models is reachable for this account:
      // actionable, point the user at enabling an Inference Provider.
      setGenError(
        'No inference provider is enabled for the generation models. Enable one in your Hugging Face settings (Inference Providers), then try again.',
      );
    } else if (err instanceof GeneratePersonalityError) {
      // Surface the underlying reason/message so a router 400 / model routing
      // error is diagnosable in-app instead of a generic "try again" dead end.
      setGenError(`Generation failed (${err.reason}): ${err.message}`);
    } else {
      setGenError("Couldn't generate that one - give it another try.");
    }
  }, []);

  // The "Randomize" die seeds ONLY the description box with a fresh vibe (it
  // streams a sentence in, falling back to a local idea on failure). The
  // hook owns the stream/abort; we just gate it on an in-flight generation
  // and clear any prior error.
  const { rolling, roll } = useVibeRoll(setVibe, VIBE_MAX);
  const handleRandom = useCallback(() => {
    if (generating) return;
    setGenError(null);
    roll();
  }, [generating, roll]);

  // Sticker avatar: generate a portrait for the persona via the Reachy
  // sticker API (~1 min). The hook keeps the generation alive past submit,
  // so the user can hit "Create & use" while it cooks and the sticker lands
  // on the persona by id once it resolves.
  const sticker = useStickerAvatar();
  // "Cooking" for the band/tiles ring covers BOTH the actual sticker bake
  // AND, in edit mode, the brief LLM theme-crafting that precedes it when
  // the user hits "Regenerate". Without folding `crafting` in, that craft
  // latency was a dead zone. (Create mode crafts its theme passively in the
  // background, so we don't count it there.)
  const stickerCooking =
    sticker.status === 'queued' ||
    sticker.status === 'generating' ||
    (isEdit && sticker.crafting);
  // Avatar shown in the band's preview disc: a freshly generated sticker
  // wins; otherwise the persona-under-edit's own avatar (unless it's still
  // the shared default placeholder); otherwise nothing.
  const previewAvatar =
    sticker.dataUri ??
    (isEdit && editing?.avatar && editing.avatar !== DEFAULT_AVATAR_URL
      ? editing.avatar
      : null);

  // Edit-mode "Regenerate avatar": re-craft a fresh theme from the current
  // persona and bake a new sticker for THIS persona id, patching it in when
  // ready. (Create mode authors the avatar passively at submit.)
  const handleRegenerateAvatar = useCallback(() => {
    if (!isEdit || !editing) return;
    sticker.regenerateFor(editing.id, { name, tagline, instructions });
  }, [isEdit, editing, sticker, name, tagline, instructions]);

  // Passive avatar, step 1 of 2 (create mode only): quietly pre-craft a
  // visual theme (a cheap text-only LLM call) once the persona has a name +
  // instructions, so the avatar kicked off at submit is on-theme. Debounced,
  // and skipped once a sticker is in flight or done. Edit mode skips this -
  // its "Regenerate" button crafts its own fresh theme on demand.
  const craftTheme = sticker.craft;
  useEffect(() => {
    if (isEdit) return;
    if (sticker.theme.trim().length > 0 || sticker.status !== 'idle') return;
    if (name.trim().length === 0 || instructions.trim().length === 0) return;
    const t = window.setTimeout(() => {
      craftTheme({ name, tagline, instructions });
    }, 1200);
    return () => window.clearTimeout(t);
  }, [isEdit, name, tagline, instructions, sticker.theme, sticker.status, craftTheme]);

  // Publish the persona being authored to the draft channel so the
  // persistent personality band above can mirror it live: the title tracks
  // the typed name, the avatar disc shows the portrait (with a cooking ring
  // while it bakes) + an inline regenerate control. The avatar is shown ONLY
  // on the band, never in this form body.
  useEffect(() => {
    setPersonaDraft({
      name,
      avatar: previewAvatar,
      cooking: stickerCooking,
      regenerate: isEdit && editing ? handleRegenerateAvatar : null,
    });
  }, [name, previewAvatar, stickerCooking, isEdit, editing, handleRegenerateAvatar]);

  // Clear the draft when the form closes so the band drops back to the
  // active persona.
  useEffect(() => () => clearPersonaDraft(), []);

  // Voice audition: selecting a voice writes form state here and asks the
  // hook to play its bundled sample.
  const { playingVoice, playSample } = useVoiceAudition();
  const selectVoice = useCallback(
    (v: string) => {
      setVoice(v);
      playSample(v);
    },
    [playSample],
  );

  const canSubmit = name.trim().length > 0 && instructions.trim().length > 0;

  // Edit mode only: has anything actually changed vs the persona we opened?
  // A pristine editor has nothing to write, so we disable "Save" until the
  // user touches a field (or a fresh sticker lands). Create mode is always
  // considered "dirty" - `canSubmit` alone gates it. Comparisons mirror the
  // field initialisers (trimmed values, empty-voice -> first-voice fallback).
  const editDirty =
    !isEdit || !editing
      ? true
      : name.trim() !== editing.name ||
        tagline.trim() !== (editing.tagline ?? '') ||
        instructions.trim() !== editing.instructions ||
        voice !== (editing.voice || AVAILABLE_VOICES[0]) ||
        sticker.dataUri != null;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const input = {
      name: name.trim(),
      tagline: tagline.trim(),
      instructions: instructions.trim(),
      // The user picked a voice in the form; persist it (the data layer
      // snaps it onto the HF catalog). The generator path sets it directly
      // via `commitGeneratedPersona`.
      voice,
      // Accent colour is no longer user-facing - we still hand the data
      // layer the default glow so the persona shape stays unchanged.
      glow: DEFAULT_GLOW,
      // Plug in a finished sticker if we have one; otherwise omit it (create
      // falls back to the default avatar, edit keeps the existing one) and
      // let an in-flight generation patch it later.
      avatar: sticker.dataUri ?? undefined,
    };
    const targetId = isEdit && editing ? editing.id : addCustomPersonality(input).id;
    if (isEdit && editing) {
      updateCustomPersonality(editing.id, input);
    }
    // Make the persona active; the id is stable across an update so
    // "Save & use" resolves cleanly.
    setActivePersonality(targetId);
    // Passive avatar, step 2 of 2 (create only): if no avatar was produced
    // yet, kick one off now using the pre-crafted theme (or the name as a
    // fallback). It cooks in the background and patches in by id once ready.
    // In EDIT mode we don't auto-generate (saving a prompt edit shouldn't
    // silently replace the avatar); we only adopt when a regenerate is
    // already in flight/done.
    if (!isEdit && !sticker.dataUri && !stickerCooking) {
      sticker.generate(sticker.theme.trim() || name.trim());
    }
    if (!isEdit || sticker.dataUri || stickerCooking) {
      sticker.adoptPersona(targetId);
    }
    onCreated();
  };

  // Commit a freshly generated persona immediately (create mode): persist it,
  // make it active, and kick the portrait baking in the background (it patches
  // in by id once ready). Mirrors `handleSubmit`'s create path but reads the
  // just-generated values directly (form state may not have flushed yet). The
  // user's vibe doubles as a vivid sticker prompt when no theme is crafted.
  const commitGeneratedPersona = useCallback(
    (result: GeneratedPersonality) => {
      const input = {
        name: result.name.trim(),
        tagline: result.tagline.trim(),
        instructions: result.instructions.trim(),
        // The generator authors the voice from the vibe. No manual picker.
        voice: result.voice,
        glow: DEFAULT_GLOW,
      };
      const id = addCustomPersonality(input).id;
      setActivePersonality(id);
      if (!sticker.dataUri && !stickerCooking) {
        sticker.generate(sticker.theme.trim() || vibe.trim() || input.name);
      }
      sticker.adoptPersona(id);
    },
    [sticker, stickerCooking, vibe],
  );

  // Generate (create mode): hand off to the dedicated full-screen view and
  // STREAM the persona in, filling each slot as it lands (name first, hence
  // the monogram, then tagline). Once the object resolves we commit +
  // activate the persona and hold a short reveal beat before closing. The
  // voice is applied automatically by the data layer, so it isn't surfaced.
  // On failure, drop back to the idea screen where the error is shown.
  const handleGenerate = useCallback(() => {
    if (vibe.trim().length === 0 || generating) return;
    setGenError(null);
    setGenMode('describe');
    // Clear the slots so the generation view starts as skeletons and fills in
    // progressively as the stream lands each field.
    setName('');
    setTagline('');
    setInstructions('');
    setPhase('generating');
    void (async () => {
      try {
        const result = await streamPersonality(vibe, {
          onPartial: partial => {
            if (partial.name !== undefined) setName(partial.name);
            if (partial.tagline !== undefined) setTagline(partial.tagline);
          },
        });
        // Settle the form to the validated result (instructions land last).
        setName(result.name);
        setTagline(result.tagline);
        setInstructions(result.instructions);
        if (result.voice) setVoice(result.voice);
        commitGeneratedPersona(result);
        setPhase('reveal');
      } catch (err) {
        reportGenError(err);
        setPhase('idea');
      } finally {
        setGenMode(null);
      }
    })();
  }, [vibe, generating, commitGeneratedPersona, reportGenError]);

  // Latest `onCreated` kept in a ref so the reveal timer below depends ONLY
  // on `phase`. Otherwise a fresh `onCreated` identity (the host re-renders
  // constantly while the portrait bakes) would re-run the effect, clear the
  // pending timeout, and reset it every render - so the beat would never fire
  // until renders settled (~when the image finished). That was the "it waits
  // for the image to end" bug.
  const onCreatedRef = useRef(onCreated);
  useEffect(() => {
    onCreatedRef.current = onCreated;
  });

  // Reveal beat: once the persona is born + active, hold the celebratory
  // screen briefly, then close. The portrait keeps baking and lands on the
  // persistent band a moment later (a second mini-reveal).
  useEffect(() => {
    if (phase !== 'reveal') return;
    const timer = window.setTimeout(() => onCreatedRef.current(), 1600);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const handleDelete = () => {
    if (!isEdit || !editing) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    removeCustomPersonality(editing.id);
    (onDeleted ?? onCreated)();
  };

  // The create-mode "Meet" flow (generation + reveal) should take over the
  // panel area - replacing the personality band above it - WITHOUT covering the
  // app's top bar / bottom nav. We don't go `position: fixed` (that would eat
  // the whole viewport); instead we tell the host (`onImmersiveChange`) to hide
  // its personality band while this phase is up, so our embedded body simply
  // grows to fill the freed space. Edit mode and the idea/manual screens stay
  // embedded under the band.
  const meetOverlay = embedded && !isEdit && phase !== 'idea';
  const notifyImmersive = onImmersiveChange;
  useEffect(() => {
    notifyImmersive?.(meetOverlay);
  }, [meetOverlay, notifyImmersive]);
  // Always clear the flag when the form unmounts, so a close mid-reveal can't
  // leave the host's band hidden.
  useEffect(() => () => notifyImmersive?.(false), [notifyImmersive]);
  return (
    <Box
      role={embedded ? 'group' : 'dialog'}
      aria-modal={embedded ? undefined : 'true'}
      aria-label={embedded ? 'Create your own agent' : undefined}
      aria-labelledby={embedded ? undefined : 'create-personality-title'}
      sx={
        embedded
          ? {
              // In-flow: fill the host's body slot, sitting BELOW the
              // persistent personality band (which owns title + close).
              // Full-bleed escape (`100vw` + negative margin) so we break
              // out of the host's `px` gutter - otherwise the scroll
              // container is inset and its scrollbar floats ~24px off the
              // app's right edge. The fields keep their own inner padding;
              // only the scroll surface goes edge-to-edge.
              flex: 1,
              minHeight: 0,
              width: '100vw',
              mx: 'calc(50% - 50vw)',
              bgcolor: 'background.default',
              color: 'text.primary',
              display: 'flex',
              flexDirection: 'column',
            }
          : {
              position: 'fixed',
              inset: 0,
              zIndex: 1500,
              bgcolor: 'background.default',
              color: 'text.primary',
              display: 'flex',
              flexDirection: 'column',
              pt: `calc(${LAYOUT.safeAreaTop} + 8px)`,
              pb: `calc(${LAYOUT.safeAreaBottom} + 8px)`,
            }
      }
    >
      {/* Sticky header: title + close. Suppressed in embedded mode - the
          personality band above owns the title and the close affordance
          (its "+" morphs into a "✕"). */}
      {!embedded && (
        <Stack
          direction="row"
          sx={{
            alignItems: 'center',
            justifyContent: 'space-between',
            px: 2,
            py: 1,
            borderBottom: t => `1px solid ${t.palette.divider}`,
          }}
        >
          <Typography
            id="create-personality-title"
            component="h2"
            sx={{
              fontSize: TYPO.xl,
              fontWeight: FONT_WEIGHT.bold,
              letterSpacing: '-0.3px',
            }}
          >
            {isEdit ? 'Edit personality' : 'Create your own agent'}
          </Typography>
          <IconButton aria-label="Cancel" onClick={onCancel} edge="end" color="primary">
            <CloseIcon />
          </IconButton>
        </Stack>
      )}

      {/* Scrollable form body. No avatar/identity preview at the top: the
          persistent personality band above already stands in for the persona
          being authored, so a second preview here would just duplicate it. */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          pl: 3,
          pr: 2,
          // Extra top breathing room in embedded mode: the personality band
          // above now lets its avatar disc spill downward, so the first
          // field needs clearance to not sit under the overflowing circle.
          // The fullscreen Meet overlay has no band above it, so it drops back
          // to the normal padding.
          pt: embedded && !meetOverlay ? 7 : 3,
          pb: 3,
        }}
      >
        {!isEdit && phase !== 'idea' ? (
          // Dedicated generation screen: the model authors the persona
          // ('generating'), then a short reveal beat once it's committed +
          // active ('reveal'), before the overlay closes.
          <CreatePersonalityGenerating
            ready={phase === 'reveal'}
            name={name}
            tagline={tagline}
            onCancel={onCancel}
          />
        ) : !isEdit && !detailsOpen ? (
          <CreatePersonalityHero
            vibe={vibe}
            onVibeChange={setVibe}
            generating={generating}
            rolling={rolling}
            genError={genError}
            onGenerate={handleGenerate}
            onRandom={handleRandom}
            onWriteManually={() => setDetailsOpen(true)}
          />
        ) : (
          <CreatePersonalityFields
            isEdit={isEdit}
            name={name}
            onNameChange={setName}
            tagline={tagline}
            onTaglineChange={setTagline}
            voice={voice}
            onVoiceChange={selectVoice}
            instructions={instructions}
            onInstructionsChange={setInstructions}
            playingVoice={playingVoice}
            onBack={() => setDetailsOpen(false)}
          />
        )}
      </Box>

      {/* Sticky action plate. Hidden on the create landing: you can never
          submit straight from the "describe it" view - generating, Surprise
          me, or "set it up manually" all move you into the form first
          (detailsOpen), where the CTA lives. */}
      {detailsOpen && (
        <CreatePersonalityActions
          isEdit={isEdit}
          confirmingDelete={confirmingDelete}
          canSubmit={canSubmit}
          editDirty={editDirty}
          onSubmit={handleSubmit}
          onDelete={handleDelete}
          onKeep={() => setConfirmingDelete(false)}
        />
      )}
    </Box>
  );
}
