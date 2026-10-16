import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Pipeline, Item } from './types.js';
import { FlowClient, FlowGenerationQueuedError } from './flowClient.js';
import { FlowActionRequiredError } from './generation.js';
import { S } from './selectors.js';

async function save(file: string, p: Pipeline) { // saveFallbackCopyAfterRenameFailure
  const payload = JSON.stringify(p, null, 2);
  // Use a unique staging name so a stale pipeline.json.tmp from an earlier
  // Windows rename failure cannot collide with the current save.
  const tmp = `${file}.${process.pid}.${Date.now()}.save.tmp`;
  await fs.writeFile(tmp, payload, 'utf8');

  // Validate the complete staged JSON before replacing the live pipeline.
  JSON.parse(await fs.readFile(tmp, 'utf8'));

  let lastRenameError: unknown;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (error) {
      lastRenameError = error;
      const code = String((error as any)?.code ?? '');
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw error;
      // Antivirus, indexing, or sync software can briefly hold the target.
      await new Promise<void>(resolve => setTimeout(resolve, 150 * attempt));
    }
  }

  // Last-resort Windows fallback. Preserve the last known-good pipeline first,
  // then copy and validate the staged JSON. If copy also fails, leave the
  // staging file in place for recovery and fail loudly rather than losing state.
  const backup = `${file}.pre_fallback_${Date.now()}.bak`;
  try {
    await fs.copyFile(file, backup);
  } catch (backupError) {
    throw new Error(
      `Pipeline save rename failed after retries (${String(lastRenameError)}). ` +
      `Could not create fallback backup (${String(backupError)}); updated state remains at ${tmp}.`
    );
  }

  try {
    await fs.copyFile(tmp, file);
    const expected = JSON.stringify(JSON.parse(payload));
    const actual = JSON.stringify(JSON.parse(await fs.readFile(file, 'utf8')));
    if (actual !== expected) throw new Error('Fallback copy validation mismatch.');
    await fs.rm(tmp, { force: true });
  } catch (copyError) {
    throw new Error(
      `Pipeline save rename failed (${String(lastRenameError)}); fallback copy failed (${String(copyError)}). ` +
      `Original state backup: ${backup}. Updated state remains at ${tmp}.`
    );
  }
}

function retryable(item: Item) {
  return item.status !== 'done';
}

function mark(item: Item, status: 'done' | 'failed', error?: unknown) {
  item.status = status;
  item.error = status === 'failed' ? String(error) : null;
  item.updated_at = new Date().toISOString();
}

function sourceIdentityForScenes(value: unknown): string {
  const source = String(value ?? '').trim();
  if (!source) return '';
  try {
    const url = new URL(source);
    return `${url.origin}${url.pathname}`;
  } catch {
    return source.split(/[?#]/, 1)[0];
  }
}

function sceneOutputFile(out: string, sceneNumber: unknown): string {
  return path.join(out, `scene-${String(sceneNumber).padStart(4, '0')}.mp4`);
}

function configureSceneSourceExclusions(p: Pipeline, current: Item) {
  const currentNumber = Number((current as any).scene_number);
  const currentSourceKey = sourceIdentityForScenes((current as any).flow_generation?.source);
  const excludedSources = [...new Set(p.scenes
    .filter(scene => scene !== current)
    .filter(scene => !(Number((scene as any).scene_number) > currentNumber && currentSourceKey && sourceIdentityForScenes((scene as any).flow_generation?.source) === currentSourceKey))
    .map(scene => String((scene as any).flow_generation?.source ?? ''))
    .filter(Boolean))];
  Object.defineProperty(current as any, '__flow_source_exclusions', {
    value: excludedSources,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  const state = (current as any).flow_generation;
  if (state) state.excluded_sources = excludedSources;
}

async function priorDuplicateSceneOutputs(p: Pipeline, current: Item, out: string): Promise<{ sourceScenes: number[]; fileScenes: number[] }> {
  const currentNumber = Number((current as any).scene_number);
  if (!Number.isFinite(currentNumber)) return { sourceScenes: [], fileScenes: [] };
  const currentSourceKey = sourceIdentityForScenes((current as any).flow_generation?.source);
  const sourceScenes: number[] = [];
  const fileScenes: number[] = [];
  for (const other of p.scenes) {
    const otherNumber = Number((other as any).scene_number);
    if (!Number.isFinite(otherNumber) || otherNumber >= currentNumber) continue;
    const otherKey = sourceIdentityForScenes((other as any).flow_generation?.source);
    if (currentSourceKey && otherKey === currentSourceKey) sourceScenes.push(otherNumber);
  }

  let currentHash = '';
  try {
    const bytes = await fs.readFile(sceneOutputFile(out, currentNumber));
    if (bytes.length > 0) currentHash = createHash('sha256').update(bytes).digest('hex');
  } catch {}
  if (currentHash) {
    for (const other of p.scenes) {
      const otherNumber = Number((other as any).scene_number);
      if (!Number.isFinite(otherNumber) || otherNumber >= currentNumber) continue;
      try {
        const bytes = await fs.readFile(sceneOutputFile(out, otherNumber));
        if (bytes.length > 0 && createHash('sha256').update(bytes).digest('hex') === currentHash) fileScenes.push(otherNumber);
      } catch {}
    }
  }
  return { sourceScenes: [...new Set(sourceScenes)], fileScenes: [...new Set(fileScenes)] };
}

async function assertCurrentSceneOutputDistinct(p: Pipeline, current: Item, out: string, filename: string) {
  const currentNumber = Number((current as any).scene_number);
  const outputPath = path.join(out, filename);
  let currentHash = '';
  try {
    const bytes = await fs.readFile(outputPath);
    if (bytes.length > 0) currentHash = createHash('sha256').update(bytes).digest('hex');
  } catch {}
  if (!currentHash || !Number.isFinite(currentNumber)) return;

  const duplicates: number[] = [];
  for (const other of p.scenes) {
    const otherNumber = Number((other as any).scene_number);
    if (!Number.isFinite(otherNumber) || otherNumber >= currentNumber) continue;
    try {
      const bytes = await fs.readFile(sceneOutputFile(out, otherNumber));
      if (bytes.length > 0 && createHash('sha256').update(bytes).digest('hex') === currentHash) duplicates.push(otherNumber);
    } catch {}
  }
  if (duplicates.length === 0) return;

  const state = (current as any).flow_generation;
  const rejectedSource = String(state?.source ?? '');
  if (state) {
    if (rejectedSource) state.rejected_sources = [...new Set([...(state.rejected_sources ?? []), rejectedSource])];
    state.source = undefined;
    state.phase = 'submitted';
    delete state.completed_at;
  }
  throw new FlowGenerationQueuedError(`Scene ${currentNumber} downloaded bytes identical to earlier scene(s) ${duplicates.join(', ')}. The duplicate was rejected; keep this scene pending and recover a distinct result before continuing.`);
}

async function once(
  label: string,
  item: Item,
  fn: () => Promise<void>,
  p: Pipeline,
  file: string,
  log: (e: string, d?: any) => void
) {
  if (!retryable(item)) return;

  try {
    log('start', { label });
    await fn();
    mark(item, 'done');
    log('done', { label });
  } catch (e) {
    if (e instanceof FlowActionRequiredError) {
      item.status = 'pending';
      item.error = String(e);
      item.updated_at = new Date().toISOString();
      log('paused_for_flow_action', {
        label,
        action: e.action,
        message: e.message,
      });
      throw e;
    }

    if (e instanceof FlowGenerationQueuedError) {
      item.status = 'pending';
      item.error = String(e);
      item.updated_at = new Date().toISOString();
      log('paused_for_flow_queue', { label, message: e.message });
      throw e;
    }

    mark(item, 'failed', e);
    log('failed', { label, error: String(e) });
    throw e;
  } finally {
    await save(file, p);
  }
}

export async function run(
  flow: FlowClient,
  page: any,
  p: Pipeline,
  file: string,
  out: string,
  log: (e: string, d?: any) => void
) {
  await fs.mkdir(out, { recursive: true });

  // Current Flow agent UI has no All media or active model selector. Use its
  // composer as intended, with explicit media kind and reusable asset names.
  if (await flow.agentComposer()) {
    for (const [i, c] of p.characters.entries()) {
      await once(`character:${i + 1}`, c, async () => {
        const resume = await flow.bind(c, () => save(file, p), 'image');
        if (!resume) {
          await flow.agentPrompt(
            `Generate one 16:9 character reference IMAGE and save it as ${c.tag ?? c.name} for reuse in this project. Character appearance: ${c.full_prompt}. Voice identity for later videos: ${c.voice_description ?? 'Native North Indian Hindi pronunciation'}.`
          );
        }
        await flow.generate();
      }, p, file, log);
    }

    for (const [i, b] of p.backgrounds.entries()) {
      await once(`background:${i + 1}`, b, async () => {
        const resume = await flow.bind(b, () => save(file, p), 'image');
        if (!resume) {
          await flow.agentPrompt(
            `Generate one empty 16:9 background IMAGE and save it as ${b.tag ?? b.location_name} for reuse in this project: ${b.full_prompt}`
          );
        }
        await flow.generate();
      }, p, file, log);
    }

    for (const s of [...p.scenes].sort((a, b) => Number(a.scene_number) - Number(b.scene_number))) {
      const filename = `scene-${String(s.scene_number).padStart(4, '0')}.mp4`;
      const priorDuplicates = await priorDuplicateSceneOutputs(p, s, out);
      const duplicateSceneNumbers = [...new Set([...priorDuplicates.sourceScenes, ...priorDuplicates.fileScenes])];
      if (s.status === 'done' && duplicateSceneNumbers.length > 0) {
        const state = (s as any).flow_generation;
        const oldSource = String(state?.source ?? '');
        if (state) {
          if (oldSource) state.rejected_sources = [...new Set([...(state.rejected_sources ?? []), oldSource])];
          state.source = undefined;
          state.phase = 'submitted';
          delete state.completed_at;
        }
        s.status = 'pending';
        s.error = `Saved scene output duplicates earlier scene(s): ${duplicateSceneNumbers.join(', ')}.`;
        log('scene_duplicate_output_invalidated', {
          label: `scene:${s.scene_number}`,
          duplicateSceneNumbers,
          duplicateSourceScenes: priorDuplicates.sourceScenes,
          duplicateFileScenes: priorDuplicates.fileScenes,
          policy: 'Do not keep a duplicate clip marked done. Recover the current scene from its own prompt-specific gallery.',
        });
      }
      if (s.status === 'done') {
        try {
          if (!(await fs.stat(path.join(out, filename))).size) throw new Error();
        } catch {
          if (!s.flow_generation) {
            throw new Error(`Scene ${s.scene_number} is done but has no local download or saved media reference.`);
          }
          s.status = 'pending';
        }
      }

      await once(`scene:${s.scene_number}`, s, async () => {
        if (!s.flow_generation && /FLOW_GENERATION_QUEUED|scheduled.*high demand/i.test(String(s.error ?? ''))) {
          s.flow_generation_resume_required = true;
        }
        if (s.flow_generation_resume_required && !s.flow_generation) {
          throw new Error(`Recover the existing submission reference for scene ${s.scene_number}; refusing a duplicate generation.`);
        }

        const resume = await flow.bind(s, () => save(file, p), 'video');
        configureSceneSourceExclusions(p, s);
        if ((s as any).flow_generation) await save(file, p);
        if (!resume) {
          const narrator = s.speaker === 'NARRATOR' || s.speaker === 'none';
          const assets = s.assets as any;
          await flow.agentPrompt(
            `Generate exactly one 16:9 VIDEO scene using the saved reference assets ${assets?.background_tag ?? s.background_tag} ${(assets?.character_tags ?? s.character_tags ?? []).join(' ')}. Preserve their appearances. Use a natural duration sufficient for all actions and dialogue. ${narrator ? s.animation_prompt_NARRATOR_ONLY : s.animation_prompt_WITH_lipsync}`
          );
        }

        await flow.generate();
        await flow.download(out, filename);
        await assertCurrentSceneOutputDistinct(p, s, out, filename);
      }, p, file, log);
    }
    return;
  }

  for (const [i, c] of p.characters.entries()) {
    await once(`character:${i + 1}`, c, async () => {
      const resume = await flow.bind(c, () => save(file, p), 'image');
      if (!resume) {
        await flow.click(S.addMedia);
        await flow.click(S.addCharacter);
        await flow.prompt(String(c.full_prompt));
      }
      await flow.generate();
      await flow.rename(String(c.tag ?? c.name));

      const look = String(c.look_summary ?? '');
      const voice = (c.voice ?? {}) as any;
      const gender = voice.gender ?? (look.match(/\b(female|woman|girl|à¤¸à¥à¤¤à¥à¤°à¥€|à¤®à¤¹à¤¿à¤²à¤¾)\b/i) ? 'female' : 'male');
      const age = String(voice.age ?? (look.match(/\b\d{2}\s*(?:year|yr|à¤µà¤°à¥à¤·)/i)?.[0] ?? ''));
      const descriptor = String(voice.descriptor ?? (look.match(/(?:region|accent|à¤²à¤¹à¤œà¤¾|à¤•à¥à¤·à¥‡à¤¤à¥à¤°)[^,.;]*/i)?.[0] ?? 'à¤‰à¤¤à¥à¤¤à¤° à¤­à¤¾à¤°à¤¤à¥€à¤¯ à¤²à¤¹à¤œà¤¾'));
      await flow.configureVoice({ gender, age, descriptor, name: String(c.name ?? c.tag) });
    }, p, file, log);
  }

  for (const [i, b] of p.backgrounds.entries()) {
    await once(`background:${i + 1}`, b, async () => {
      const resume = await flow.bind(b, () => save(file, p), 'image');
      if (!resume) {
        await flow.click(S.allMedia);
        await flow.prompt(String(b.full_prompt));
        await flow.click(S.aspect16x9);
      }
      await flow.generate();
      await flow.rename(String(b.tag ?? b.location_name));
    }, p, file, log);
  }

  const scenes = [...p.scenes].sort((a, b) => Number(a.scene_number) - Number(b.scene_number));
  for (const s of scenes) {
    const clip = path.join(out, `scene-${String(s.scene_number).padStart(4, '0')}.mp4`);
    const priorDuplicates = await priorDuplicateSceneOutputs(p, s, out);
    const duplicateSceneNumbers = [...new Set([...priorDuplicates.sourceScenes, ...priorDuplicates.fileScenes])];
    if (s.status === 'done' && duplicateSceneNumbers.length > 0) {
      const state = (s as any).flow_generation;
      const oldSource = String(state?.source ?? '');
      if (state) {
        if (oldSource) state.rejected_sources = [...new Set([...(state.rejected_sources ?? []), oldSource])];
        state.source = undefined;
        state.phase = 'submitted';
        delete state.completed_at;
      }
      s.status = 'pending';
      s.error = `Saved scene output duplicates earlier scene(s): ${duplicateSceneNumbers.join(', ')}.`;
      log('scene_duplicate_output_invalidated', {
        label: `scene:${s.scene_number}`,
        duplicateSceneNumbers,
        duplicateSourceScenes: priorDuplicates.sourceScenes,
        duplicateFileScenes: priorDuplicates.fileScenes,
        policy: 'Do not keep a duplicate clip marked done. Recover the current scene from its own prompt-specific gallery.',
      });
    }
    if (s.status === 'done') {
      try {
        if ((await fs.stat(clip)).size === 0) throw new Error();
      } catch {
        if (!s.flow_generation) {
          throw new Error(`Completed scene ${s.scene_number} is missing its download and has no saved generation reference. Recover that existing clip before resuming.`);
        }
        s.status = 'pending';
      }
    }

    await once(`scene:${s.scene_number}`, s, async () => {
      if (!s.flow_generation && /FLOW_GENERATION_QUEUED|scheduled.*high demand/i.test(String(s.error ?? ''))) {
        s.flow_generation_resume_required = true;
      }
      if (s.flow_generation_resume_required && !s.flow_generation) {
        throw new Error(`Scene ${s.scene_number} was submitted by an older runner. Its generation URL must be recovered before continuing; refusing to submit a duplicate.`);
      }

      const resume = await flow.bind(s, () => save(file, p), 'video');
      configureSceneSourceExclusions(p, s);
      if ((s as any).flow_generation) await save(file, p);
      if (!resume) {
        const narrator = s.speaker === 'NARRATOR' || s.speaker === 'none';
        const prompt = narrator ? s.animation_prompt_NARRATOR_ONLY : s.animation_prompt_WITH_lipsync;
        const assets = s.assets as any;
        await flow.click(S.addMedia);
        await flow.click(S.addScene);
        await flow.prompt(String(prompt));
        await flow.selectAsset(
          String(assets?.background_tag),
          String(p.backgrounds.find(b => b.tag === assets?.background_tag)?.full_prompt ?? '')
        );
        for (const tag of assets?.character_tags ?? []) {
          await flow.selectAsset(
            String(tag),
            String(p.characters.find(c => c.tag === tag)?.full_prompt ?? '')
          );
        }
        await flow.click(S.aspect16x9);
      }
      await flow.generate();
      await flow.download(out, path.basename(clip));
      await assertCurrentSceneOutputDistinct(p, s, out, path.basename(clip));
    }, p, file, log);
  }
}
