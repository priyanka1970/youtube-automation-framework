import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import type { Locator, Page } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchProfile } from './browserSession.js';
import { loadEnvironment } from './setupConfig.js';

type NarrationScene = { scene_number: number; text: string };
type NarrationManifest = { voice_direction: string; scenes: NarrationScene[] };

type DownloadButtonState = {
  index: number;
  label: string;
  title: string;
  disabled: boolean;
  visible: boolean;
};

const isMojibake = (value: string) => /(?:à¤|à¥|Ã.|â€|ï¿½|\uFFFD)/u.test(value);
const hasDevanagari = (value: string) => /[\u0900-\u097F]/u.test(value);

function validateSceneText(text: string, sceneNumber: number) {
  if (!text || !text.trim()) throw new Error(`Scene ${sceneNumber}: narration text is empty.`);
  if (isMojibake(text)) {
    throw new Error(`Scene ${sceneNumber}: narration contains likely mojibake. No Run click was made.`);
  }
  // This project narration is Hindi. Refuse to send unreadable/non-Hindi text to paid TTS.
  if (!hasDevanagari(text)) {
    throw new Error(`Scene ${sceneNumber}: no Devanagari characters found. Refusing to generate potentially corrupted narration.`);
  }
}

async function readManifestSafely(manifestFile: string): Promise<NarrationManifest> {
  const original = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as NarrationManifest;
  if (!Array.isArray(original.scenes) || original.scenes.length === 0) {
    throw new Error(`No scenes found in narration manifest: ${manifestFile}`);
  }

  const badScenes = original.scenes.filter(scene => typeof scene.text !== 'string' || isMojibake(scene.text));
  if (badScenes.length === 0) {
    for (const scene of original.scenes) validateSceneText(scene.text, scene.scene_number);
    return original;
  }

  // v26 writes a separate candidate and never overwrites the original manifest.
  const candidateFile = path.join(path.dirname(manifestFile), 'narration-manifest.repaired-candidate.json');
  let candidate: NarrationManifest;
  try {
    candidate = JSON.parse(await fs.readFile(candidateFile, 'utf8')) as NarrationManifest;
  } catch {
    throw new Error(
      `The original narration manifest contains corrupted text, and the repair candidate was not found.\n` +
      `Expected: ${candidateFile}\n` +
      `No speech was generated. Re-run inspector v26 or repair the manifest before continuing.`
    );
  }

  const originalIds = original.scenes.map(scene => scene.scene_number).join(',');
  const candidateIds = (candidate.scenes || []).map(scene => scene.scene_number).join(',');
  if (originalIds !== candidateIds || candidate.scenes.length !== original.scenes.length) {
    throw new Error('Repair candidate scene numbers do not match the original manifest. No speech was generated.');
  }
  for (const scene of candidate.scenes) validateSceneText(scene.text, scene.scene_number);
  console.log(`Original manifest has encoding corruption. Using validated repair candidate: ${candidateFile}`);
  console.log('Original manifest is unchanged.');
  return candidate;
}

async function speechBlock(page: Page): Promise<Locator> {
  // Confirmed by the user's v26 DOM inspection. Check fallbacks sequentially to avoid
  // Playwright Locator.or() matching the same textarea twice and causing strict-mode errors.
  const exact = page.locator('textarea[aria-label="Speech block text"]').first();
  if (await exact.count()) return exact;
  const byPlaceholder = page.getByPlaceholder(/Type.*for tags/i).first();
  if (await byPlaceholder.count()) return byPlaceholder;
  return page.locator('textarea').first();
}

async function ensureSpeechEditor(page: Page) {
  const textArea = await speechBlock(page);
  try {
    await textArea.waitFor({ state: 'visible', timeout: 9000 });
    return;
  } catch {
    // On the landing page, open only the non-generating Create new dialog card.
    const card = page.locator('mat-card').filter({ hasText: /Create new dialog/i });
    const count = await card.count();
    if (count !== 1 || !(await card.isVisible().catch(() => false))) {
      const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 1600);
      throw new Error(`Could not uniquely locate the Create new dialog card. No generation was attempted.\nPage text:\n${body}`);
    }
    await card.click();
    await textArea.waitFor({ state: 'visible', timeout: 20000 });
  }
}

async function visibleEditableFields(page: Page) {
  const fields = page.locator('textarea, input, [contenteditable="true"], [role="textbox"]');
  const output: { index: number; tag: string; label: string; placeholder: string; name: string; parentText: string; visible: boolean }[] = [];
  const count = await fields.count();
  for (let index = 0; index < count; index++) {
    const field = fields.nth(index);
    const meta = await field.evaluate(el => {
      const element = el as HTMLElement;
      const parentText = element.parentElement?.parentElement?.innerText || '';
      return {
        tag: element.tagName.toLowerCase(),
        label: element.getAttribute('aria-label') || '',
        placeholder: (element as HTMLInputElement).placeholder || '',
        name: element.getAttribute('name') || '',
        parentText: parentText.replace(/\s+/g, ' ').trim().slice(0, 160),
      };
    }).catch(() => ({ tag: '', label: '', placeholder: '', name: '', parentText: '' }));
    const visible = await field.isVisible().catch(() => false);
    output.push({ index, ...meta, visible });
  }
  return output;
}

async function locateStyleField(page: Page): Promise<Locator | null> {
  const fields = page.locator('textarea, input, [contenteditable="true"], [role="textbox"]');
  const count = await fields.count();
  for (let index = 0; index < count; index++) {
    const field = fields.nth(index);
    if (!(await field.isVisible().catch(() => false))) continue;
    const meta = await field.evaluate(el => {
      const element = el as HTMLElement;
      const label = element.getAttribute('aria-label') || '';
      const placeholder = (element as HTMLInputElement).placeholder || '';
      const name = element.getAttribute('name') || '';
      const parentText = (element.parentElement?.parentElement?.innerText || '').replace(/\s+/g, ' ').trim();
      return { label, placeholder, name, parentText };
    }).catch(() => ({ label: '', placeholder: '', name: '', parentText: '' }));
    if (/speech block text/i.test(`${meta.label} ${meta.placeholder} ${meta.name}`)) continue;
    if (/style|speaking style|style instructions/i.test(`${meta.label} ${meta.placeholder} ${meta.name}`)) return field;
  }
  return null;
}

async function setStyleDirection(page: Page, direction: string, sceneNumber: number) {
  const styleText = (direction || '').trim();
  if (!styleText) return;

  let styleField = await locateStyleField(page);
  if (!styleField) {
    const styleButton = page.getByRole('button', { name: /^Style$/i }).first();
    if (!(await styleButton.isVisible().catch(() => false))) {
      throw new Error(`Scene ${sceneNumber}: Style control was not found. No Run click was made.`);
    }
    await styleButton.click();
    await page.waitForTimeout(250);
    styleField = await locateStyleField(page);
  }

  if (!styleField) {
    const fields = await visibleEditableFields(page);
    throw new Error(
      `Scene ${sceneNumber}: clicked the non-generating Style control but could not identify its style editor. ` +
      `No Run click was made. Visible fields: ${JSON.stringify(fields)}`
    );
  }
  await styleField.fill(styleText);
}

async function readAudioSources(page: Page): Promise<string[]> {
  return page.locator('audio').evaluateAll(elements => elements.map(element => {
    const audio = element as HTMLAudioElement;
    return audio.currentSrc || audio.src || audio.querySelector('source')?.src || '';
  }).filter(Boolean));
}

async function readDownloadButtons(page: Page): Promise<DownloadButtonState[]> {
  const buttons = page.locator('button[aria-label*="download" i], button[title*="download" i], [role="button"][aria-label*="download" i]');
  const count = await buttons.count();
  const states: DownloadButtonState[] = [];
  for (let index = 0; index < count; index++) {
    const button = buttons.nth(index);
    const visible = await button.isVisible().catch(() => false);
    if (!visible) continue;
    const meta = await button.evaluate(el => {
      const element = el as HTMLElement;
      return {
        label: element.getAttribute('aria-label') || element.textContent?.trim() || '',
        title: element.getAttribute('title') || '',
        disabled: (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true',
      };
    }).catch(() => ({ label: '', title: '', disabled: true }));
    states.push({ index, ...meta, visible });
  }
  return states;
}

function audioSignature(states: DownloadButtonState[]) {
  return states.map(state => `${state.label}|${state.title}`).join('||');
}

type FetchedAudio = { bytes: Buffer; mimeType: string };

function attemptMarkerPath(target: string) {
  return `${target}.attempt.json`;
}

async function validateWavFile(filePath: string) {
  const bytes = await fs.readFile(filePath);
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Missing RIFF/WAVE header.');
  }
  const probe = await promisify(execFile)('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', filePath
  ], { timeout: 30000, maxBuffer: 1024 * 1024 });
  if (!probe.stdout.trim()) throw new Error('ffprobe found no audio stream.');
}

async function saveAsValidatedWav(bytes: Buffer, target: string, mimeType: string, sceneNumber: number) {
  if (!bytes.length) throw new Error(`Scene ${sceneNumber}: AI Studio returned an empty audio response.`);
  await fs.mkdir(path.dirname(target), { recursive: true });

  const temporaryWav = `${target}.tmp.wav`;
  const rawDump = `${target}.received-audio-${new Date().toISOString().replace(/[:.]/g, '-')}.bin`;
  const isWav = bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';

  if (isWav) {
    try {
      await fs.writeFile(temporaryWav, bytes);
      await validateWavFile(temporaryWav);
      await fs.rename(temporaryWav, target);
      console.log(`Scene ${sceneNumber}: received valid WAV (${mimeType || 'MIME type not reported'}).`);
      return;
    } catch (error) {
      await fs.rm(temporaryWav, { force: true }).catch(() => undefined);
      await fs.writeFile(rawDump, bytes);
      throw new Error(`Scene ${sceneNumber}: AI Studio claimed/returned WAV-like bytes, but validation failed. Raw result preserved at ${rawDump}. ${String(error)}`);
    }
  }

  // Preserve the exact returned bytes before attempting a format conversion. If conversion
  // fails, the audio result is still available for diagnosis and won't be silently lost.
  await fs.writeFile(rawDump, bytes);
  const normalizedMime = mimeType.toLowerCase().split(';')[0].trim();
  const isRawPcm = normalizedMime === 'audio/l16' || normalizedMime === 'audio/pcm' || normalizedMime === 'audio/linear16';
  const ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (isRawPcm) ffmpegArgs.push('-f', 's16le', '-ar', '24000', '-ac', '1');
  ffmpegArgs.push('-i', rawDump, '-vn', '-c:a', 'pcm_s16le', '-ar', '24000', '-ac', '1', temporaryWav);

  try {
    await promisify(execFile)('ffmpeg', ffmpegArgs, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    await validateWavFile(temporaryWav);
    await fs.rename(temporaryWav, target);
    await fs.rm(rawDump, { force: true });
    console.log(`Scene ${sceneNumber}: converted returned audio (${mimeType || 'unknown MIME'}) to validated WAV.`);
  } catch (error) {
    await fs.rm(temporaryWav, { force: true }).catch(() => undefined);
    const signature = bytes.subarray(0, 32).toString('hex').match(/.{1,2}/g)?.join(' ') || '(empty)';
    const reportPath = `${rawDump}.txt`;
    await fs.writeFile(reportPath, [
      `Scene: ${sceneNumber}`,
      `MIME type: ${mimeType || '(not reported)'}`,
      `Byte length: ${bytes.length}`,
      `First 32 bytes (hex): ${signature}`,
      `Conversion error: ${String(error)}`,
      ''
    ].join('\n'), 'utf8');
    throw new Error(`Scene ${sceneNumber}: returned bytes were not a valid WAV and FFmpeg could not convert them. ` +
      `The original response was preserved at ${rawDump}; details: ${reportPath}. No second Run click was made. ${String(error)}`);
  }
}

async function fetchAudioFromPage(page: Page, source: string): Promise<FetchedAudio> {
  const result = await page.evaluate(async url => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Generated audio fetch returned HTTP ${response.status}.`);
    const blob = await response.blob();
    const mimeType = blob.type || response.headers.get('content-type') || '';
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('Could not read generated audio blob.'));
      reader.readAsDataURL(blob);
    });
    return { base64, mimeType, byteLength: blob.size };
  }, source);
  const bytes = Buffer.from(result.base64, 'base64');
  if (bytes.length !== result.byteLength) {
    throw new Error(`Generated audio byte-length mismatch (blob=${result.byteLength}, decoded=${bytes.length}).`);
  }
  return { bytes, mimeType: result.mimeType };
}

async function readAttemptCount(target: string) {
  try {
    const parsed = JSON.parse(await fs.readFile(attemptMarkerPath(target), 'utf8')) as { attempt_count?: number };
    return Math.max(0, Number(parsed.attempt_count) || 0);
  } catch {
    return 0;
  }
}

async function writeAttemptMarker(target: string, sceneNumber: number, text: string, count: number, status: string) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(attemptMarkerPath(target), JSON.stringify({
    scene_number: sceneNumber,
    status,
    attempt_count: count,
    updated_at: new Date().toISOString(),
    text_sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    note: 'A Run click may consume TTS quota. Missing output must be reconciled before automatic retry.'
  }, null, 2), 'utf8');
}

async function generateNarration(page: Page, text: string, direction: string, target: string, sceneNumber: number) {
  validateSceneText(text, sceneNumber);
  const input = await speechBlock(page);
  await input.waitFor({ state: 'visible', timeout: 20000 });

  await setStyleDirection(page, direction, sceneNumber);
  await input.fill(text);

  const run = page.getByRole('button', { name: /^Run\b/i }).first();
  await run.waitFor({ state: 'visible', timeout: 10000 });
  if (await run.isDisabled().catch(() => true)) {
    throw new Error(`Scene ${sceneNumber}: Run is disabled after entering valid text. No generation click was made.`);
  }

  const baselineSources = await readAudioSources(page);
  const baselineDownloads = await readDownloadButtons(page);
  console.log(`Scene ${sceneNumber}: ready to submit once; no automatic retry is allowed.`);

  // A prior failed submission is retried only when this run explicitly names the scene in
  // ALLOW_TTS_REGEN_SCENES. Record the attempt before the click so a crash cannot silently
  // cause another paid submission on the next workflow run.
  const priorAttempts = await readAttemptCount(target);
  await writeAttemptMarker(target, sceneNumber, text, priorAttempts + 1, 'about-to-submit');
  // CRITICAL: exactly one generation click for this scene.
  await run.click();
  await writeAttemptMarker(target, sceneNumber, text, priorAttempts + 1, 'submitted');

  const deadline = Date.now() + 180000;
  let sawDownloadControlDisabled = baselineDownloads.some(state => state.disabled);
  let lastDownloadStates = baselineDownloads;
  while (Date.now() < deadline) {
    const sources = await readAudioSources(page).catch(() => []);
    const source = sources.find(item => !baselineSources.includes(item));
    if (source) {
      const fetched = await fetchAudioFromPage(page, source);
      await saveAsValidatedWav(fetched.bytes, target, fetched.mimeType, sceneNumber);
      await fs.rm(attemptMarkerPath(target), { force: true });
      return;
    }

    const downloadStates = await readDownloadButtons(page).catch(() => []);
    if (downloadStates.some(state => state.disabled)) sawDownloadControlDisabled = true;
    // If AI Studio exposes a download control instead of an <audio> source, use it only after
    // observing a state transition associated with this submission. Never click a stale control.
    const baselineNames = new Set(baselineDownloads.map(state => `${state.label}|${state.title}`));
    const newlyEnabled = downloadStates.find(state => !state.disabled && !baselineNames.has(`${state.label}|${state.title}`));
    const transitioned = sawDownloadControlDisabled && downloadStates.some(state => !state.disabled &&
      baselineDownloads.some(old => old.label === state.label && old.title === state.title && old.disabled));
    if (newlyEnabled || transitioned) {
      const selected = newlyEnabled || downloadStates.find(state => !state.disabled)!;
      const all = page.locator('button[aria-label*="download" i], button[title*="download" i], [role="button"][aria-label*="download" i]');
      const button = all.nth(selected.index);
      try {
        const downloadPromise = page.waitForEvent('download', { timeout: 12000 });
        await button.click();
        const download = await downloadPromise;
        const downloadPath = await download.path();
        if (!downloadPath) throw new Error('Browser did not expose the downloaded audio file path.');
        const bytes = await fs.readFile(downloadPath);
        const mimeType = download.suggestedFilename().toLowerCase().endsWith('.wav') ? 'audio/wav' : '';
        await saveAsValidatedWav(bytes, target, mimeType, sceneNumber);
        await fs.rm(attemptMarkerPath(target), { force: true });
        return;
      } catch (error) {
        // If a known new download control did not work, do not re-run generation.
        throw new Error(`Scene ${sceneNumber}: generated result may be ready, but the audio download failed. No second Run click was made. ${String(error)}`);
      }
    }

    lastDownloadStates = downloadStates;
    await page.waitForTimeout(1000);
  }

  const diagnosticPath = path.join(path.dirname(target), `narration-scene-${String(sceneNumber).padStart(4, '0')}-ui-timeout.png`);
  await page.screenshot({ path: diagnosticPath, fullPage: true }).catch(() => undefined);
  const body = (await page.locator('body').innerText().catch(() => '')).slice(-1800);
  throw new Error(
    `Scene ${sceneNumber}: one Run click was made, but no new audio source/download could be confirmed within 180 seconds. ` +
    `The script did NOT click Run again. Screenshot: ${diagnosticPath}. ` +
    `Download controls: ${JSON.stringify(lastDownloadStates)}. Page excerpt: ${body}`
  );
}

export async function narrateManifest(manifestFile: string, profile: string) {
  await loadEnvironment();
  const manifest = await readManifestSafely(manifestFile);
  const outputFolder = path.dirname(manifestFile);
  const narrationFolder = path.join(outputFolder, 'narration');
  const files = new Map<number, string>();

  for (const scene of manifest.scenes) {
    for (const extension of ['wav', 'mp3', 'm4a']) {
      const existing = path.join(narrationFolder, `narration-${String(scene.scene_number).padStart(4, '0')}.${extension}`);
      try {
        await fs.access(existing);
        const probe = await promisify(execFile)('ffprobe', [
          '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', existing
        ]);
        if (probe.stdout.trim()) {
          files.set(scene.scene_number, existing);
          await fs.rm(attemptMarkerPath(existing), { force: true }).catch(() => undefined);
          break;
        }
      } catch {
        // Missing or unreadable existing files are regenerated only after validation below.
      }
    }
  }

  if (files.size === manifest.scenes.length) {
    console.log('All narration already downloaded; reusing existing audio.');
    return;
  }

  const explicitlyAllowedRetries = new Set(
    (process.env.ALLOW_TTS_REGEN_SCENES || '').split(',').map(value => Number(value.trim())).filter(Number.isFinite)
  );
  const blockedRetries: number[] = [];
  for (const scene of manifest.scenes) {
    if (files.has(scene.scene_number)) continue;
    const target = path.join(narrationFolder, `narration-${String(scene.scene_number).padStart(4, '0')}.wav`);
    try {
      await fs.access(attemptMarkerPath(target));
      if (!explicitlyAllowedRetries.has(scene.scene_number)) blockedRetries.push(scene.scene_number);
      else console.warn(`Scene ${scene.scene_number}: retry explicitly authorized for this process only by ALLOW_TTS_REGEN_SCENES.`);
    } catch {
      // No unresolved previous generation attempt marker.
    }
  }
  if (blockedRetries.length) {
    throw new Error(
      `Narration generation stopped BEFORE opening AI Studio because previous Run clicks may have consumed quota for scene(s): ${blockedRetries.join(', ')}. ` +
      `Recover/download the existing result first. Only if you confirm it cannot be recovered, explicitly authorize one new attempt for those scenes with $env:ALLOW_TTS_REGEN_SCENES="${blockedRetries.join(',')}" for a single PowerShell invocation.`
    );
  }

  const context = await launchProfile(profile);
  try {
    const page = await context.newPage();
    await page.goto(process.env.AI_STUDIO_SPEECH_URL || 'https://aistudio.google.com/generate-speech', { waitUntil: 'domcontentloaded' });
    await ensureSpeechEditor(page);
    console.log('AI Studio speech editor is ready. No generation has occurred yet.');

    for (const scene of manifest.scenes) {
      if (files.has(scene.scene_number)) {
        console.log(`Narration ${scene.scene_number}: using existing audio.`);
        continue;
      }
      const target = path.join(narrationFolder, `narration-${String(scene.scene_number).padStart(4, '0')}.wav`);
      await generateNarration(page, scene.text, manifest.voice_direction, target, scene.scene_number);
      console.log(`Narration ${scene.scene_number}: downloaded and WAV-validated.`);
    }
  } finally {
    await context.close();
  }
}
