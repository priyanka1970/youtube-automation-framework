import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const root = process.cwd();
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const hasArg = name => args.includes(name);
const pipelineArg = argValue('--project', 'scripting/projects/youtube-automation-20261015093729601/pipeline.json');
const pipelinePath = path.resolve(root, pipelineArg);
const profileDir = path.join(root, 'production', '.chrome-profile');
const outputDir = path.join(root, 'production', 'outputs', 'youtube-automation-20261015093729601');
const diagnosticsDir = path.join(root, 'production', 'outputs', 'flow-recovery-diagnostics');
const targetScenes = argValue('--scenes', '2,3,10,12').split(',').map(v => Number(v.trim())).filter(n => Number.isInteger(n) && n > 0);
const mode = hasArg('--recover') ? 'recover' : 'plan';
const maxScrollSteps = 100;
const waitPerScrollMs = 300;

// Fingerprints taken from the existing Flow video-option thumbnail alt text.
// These signatures are deliberately specific. A non-match never triggers generation.
const fingerprints = {
  2: 'driver bholaram, holding the steering wheel, turns his head toward radhika',
  3: 'a sudden gust of wind swirls through the area by the third seat',
  10: "close-up on the driver bholaram's face; a strange, subtle glint appears in his eyes",
  12: 'the bus slowly drives away down the road, eventually disappearing into a thickening mist',
};

const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const nowStamp = () => new Date().toISOString().replaceAll(':', '-');
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const sourceIdentity = source => {
  try {
    const u = new URL(source);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(source ?? '').split(/[?#]/, 1)[0];
  }
};
const sceneFile = n => path.join(outputDir, `scene-${String(n).padStart(4, '0')}.mp4`);

if (!targetScenes.length) throw new Error('No valid scene numbers supplied with --scenes.');
for (const n of targetScenes) {
  if (!fingerprints[n]) throw new Error(`No verified Flow-card fingerprint is configured for Scene ${n}. No UI actions were taken.`);
}

let pipeline;
try {
  pipeline = JSON.parse(await fs.readFile(pipelinePath, 'utf8'));
} catch (error) {
  console.error(`Cannot read pipeline JSON at ${pipelinePath}: ${String(error)}`);
  process.exit(2);
}
const scenes = Array.isArray(pipeline.scenes) ? pipeline.scenes : [];
const getScene = number => scenes.find((scene, i) => Number(scene.scene_number ?? i + 1) === number);
for (const number of targetScenes) {
  if (!getScene(number)) throw new Error(`Scene ${number} does not exist in the pipeline. No UI actions were taken.`);
}
const flowUrl = String(pipeline.flow_project_url ?? pipeline.project_url ?? 'https://flow.google.com/project/ca1b2a2a-1840-4580-9198-92b97a5aedb7');
const projectIdMatch = new URL(flowUrl).pathname.match(/^\/project\/([^/]+)/);
const projectId = projectIdMatch?.[1];
const isProjectChatUrl = url => {
  try {
    const u = new URL(url);
    return u.hostname === 'flow.google.com' && /^\/project\/[^/]+\/?$/.test(u.pathname)
      && (!projectId || u.pathname.includes(`/project/${projectId}`));
  } catch { return false; }
};
const isEditorUrl = url => {
  try { return /\/project\/[^/]+\/edit\/[^/]+\/?$/.test(new URL(url).pathname); }
  catch { return false; }
};

async function visibleCards(page) {
  return page.locator('flow-a2ui-video-option').evaluateAll(cards => cards.map((card, index) => {
    const image = card.querySelector('img.video-thumbnail');
    const style = getComputedStyle(card);
    const imgStyle = image ? getComputedStyle(image) : null;
    const visible = Boolean(card.getClientRects().length) && style.visibility !== 'hidden' && style.display !== 'none'
      && Boolean(image) && Boolean(image.getClientRects().length) && imgStyle?.visibility !== 'hidden' && imgStyle?.display !== 'none';
    const alt = image?.getAttribute('alt') || image?.getAttribute('title') || '';
    const thumb = image?.currentSrc || image?.src || image?.getAttribute('src') || '';
    return { index, alt, visible, thumb, thumbPresent: Boolean(thumb), hasOpenEditor: Boolean(card.querySelector('[role="button"][aria-label="Open video in editor"]')) };
  }));
}

async function scrollChat(page, reset = false) {
  return page.evaluate((shouldReset) => {
    const bubbles = document.querySelectorAll('flow-chat-bubble').length;
    const root = document.scrollingElement;
    const all = Array.from(document.querySelectorAll('*'));
    if (root && root.scrollHeight > root.clientHeight + 8) all.push(root);
    const candidates = [];
    const seen = new Set();
    for (const el of all) {
      if (!(el instanceof HTMLElement) || seen.has(el)) continue;
      seen.add(el);
      if (el !== root && !/(auto|scroll|overlay)/i.test(getComputedStyle(el).overflowY)) continue;
      const range = el.scrollHeight - el.clientHeight;
      if (range <= 8 || el.clientHeight < 80 || el.querySelectorAll('flow-chat-bubble').length === 0) continue;
      let reverse = getComputedStyle(el).flexDirection === 'column-reverse';
      let parent = el.parentElement;
      for (let k = 0; !reverse && parent && k < 3; k++, parent = parent.parentElement) {
        reverse = getComputedStyle(parent).flexDirection === 'column-reverse';
      }
      candidates.push({ el, bubbleCount: el.querySelectorAll('flow-chat-bubble').length, range, reverse });
    }
    candidates.sort((a, b) => b.bubbleCount - a.bubbleCount || b.range - a.range);
    const picked = candidates[0];
    if (!picked) {
      if (root && root.scrollHeight > root.clientHeight + 8) {
        const before = root.scrollTop;
        if (shouldReset) root.scrollTop = 0;
        else root.scrollTop = Math.min(root.scrollHeight - root.clientHeight, before + Math.max(360, Math.floor(root.clientHeight * 0.7)));
        return { found: true, bubbles, moved: root.scrollTop !== before, scrollTop: root.scrollTop, direction: 'document' };
      }
      return { found: false, bubbles, moved: false, direction: 'none' };
    }
    const { el, range, reverse } = picked;
    const before = el.scrollTop;
    if (shouldReset) {
      el.scrollTop = 0;
      return { found: true, bubbles, moved: el.scrollTop !== before, scrollTop: el.scrollTop, range, reverse, direction: reverse ? 'reverse' : 'forward' };
    }
    const delta = Math.max(360, Math.floor(el.clientHeight * 0.68));
    const next = reverse ? Math.max(-range, before - delta) : Math.min(range, before + delta);
    el.scrollTop = next;
    return { found: true, bubbles, moved: el.scrollTop !== before, scrollTop: el.scrollTop, range, reverse, direction: reverse ? 'reverse' : 'forward' };
  }, reset);
}

function signatureMatches(sceneNumber, alt) {
  return normalize(alt).includes(fingerprints[sceneNumber]);
}

async function scanPlan(page) {
  const collected = new Map(targetScenes.map(n => [n, new Map()]));
  const firstScroll = await scrollChat(page, true);
  await page.waitForTimeout(350);
  for (let step = 0; step < maxScrollSteps; step++) {
    const cards = await visibleCards(page);
    for (const card of cards) {
      if (!card.visible || !card.alt) continue;
      for (const sceneNumber of targetScenes) {
        if (!signatureMatches(sceneNumber, card.alt)) continue;
        const key = `${normalize(card.alt)}|${sha256(Buffer.from(card.thumb || ''))}`;
        collected.get(sceneNumber).set(key, { domIndex: card.index, alt: card.alt, hasOpenEditor: card.hasOpenEditor });
      }
    }
    const move = await scrollChat(page, false);
    if (!move.moved) break;
    await page.waitForTimeout(waitPerScrollMs);
  }
  return {
    firstScroll,
    results: targetScenes.map(sceneNumber => {
      const cards = [...collected.get(sceneNumber).values()];
      return {
        sceneNumber,
        matchCount: cards.length,
        status: cards.length === 1 ? 'ONE_EXISTING_CARD_MATCH' : cards.length === 0 ? 'CARD_NOT_FOUND_NO_GENERATION' : 'AMBIGUOUS_MULTIPLE_CARDS_NO_ACTION',
        cards: cards.map(card => ({ domIndexObserved: card.domIndex, hasOpenEditor: card.hasOpenEditor, alt: card.alt.slice(0, 600) })),
      };
    }),
  };
}

async function findLiveCard(page, sceneNumber) {
  await scrollChat(page, true);
  await page.waitForTimeout(300);
  for (let step = 0; step < maxScrollSteps; step++) {
    const cards = await visibleCards(page);
    const matches = cards.filter(card => card.visible && card.alt && signatureMatches(sceneNumber, card.alt));
    if (matches.length === 1) return { match: matches[0], steps: step + 1 };
    if (matches.length > 1) return { ambiguous: matches.map(card => ({ domIndex: card.index, alt: card.alt.slice(0, 300) })), steps: step + 1 };
    const move = await scrollChat(page, false);
    if (!move.moved) break;
    await page.waitForTimeout(waitPerScrollMs);
  }
  return { missing: true, steps: maxScrollSteps };
}

async function getPlayableVideos(page) {
  return page.locator('video').evaluateAll(elements => elements.map((element, index) => {
    const video = element;
    const style = getComputedStyle(video);
    const visible = Boolean(video.getClientRects().length) && style.display !== 'none' && style.visibility !== 'hidden';
    const child = video.querySelector('source[src]');
    const source = video.currentSrc || video.src || video.getAttribute('src') || child?.src || child?.getAttribute('src') || '';
    return { index, source, visible, readyState: video.readyState, duration: video.duration, width: video.videoWidth, height: video.videoHeight };
  }).filter(v => v.visible && v.source && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0));
}

async function bytesFromSource(context, page, source) {
  if (source.startsWith('blob:') || source.startsWith('data:')) {
    const result = await page.evaluate(async sourceUrl => {
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error(`Browser fetch failed with HTTP ${response.status}`);
      const data = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let i = 0; i < data.length; i += 0x8000) {
        binary += String.fromCharCode(...data.subarray(i, Math.min(i + 0x8000, data.length)));
      }
      return { base64: btoa(binary), contentType: response.headers.get('content-type') || '' };
    }, source);
    return { buffer: Buffer.from(result.base64, 'base64'), contentType: result.contentType };
  }
  if (!/^https?:\/\//i.test(source)) throw new Error(`Unsupported media source type: ${source.slice(0, 24)}`);
  const response = await context.request.get(source, { timeout: 90000 });
  if (!response.ok()) throw new Error(`Media download returned HTTP ${response.status()} (${response.statusText()})`);
  return { buffer: await response.body(), contentType: response.headers()['content-type'] || '' };
}

function assertMp4(buffer, contentType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100_000) {
    throw new Error(`Downloaded body is too small to be a usable video (${buffer?.length ?? 0} bytes).`);
  }
  const boxType = buffer.subarray(4, 8).toString('ascii');
  if (boxType !== 'ftyp' && !/video\/(mp4|quicktime)/i.test(contentType)) {
    throw new Error(`Downloaded body does not look like MP4 (box type '${boxType}', content-type '${contentType}'). Existing output was not replaced.`);
  }
}

async function existingSceneHashes(excludeScene) {
  const hashes = [];
  const files = await fs.readdir(outputDir).catch(() => []);
  for (const name of files) {
    const m = name.match(/^scene-(\d{4})\.mp4$/i);
    if (!m || Number(m[1]) === excludeScene) continue;
    const full = path.join(outputDir, name);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat?.isFile()) continue;
    hashes.push({ sceneNumber: Number(m[1]), file: name, hash: sha256(await fs.readFile(full)) });
  }
  return hashes;
}

async function savePipelineSafely() {
  const json = JSON.stringify(pipeline, null, 2);
  const temp = `${pipelinePath}.${process.pid}.${Date.now()}.save.tmp`;
  await fs.writeFile(temp, json, 'utf8');
  JSON.parse(await fs.readFile(temp, 'utf8'));
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fs.rename(temp, pipelinePath);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(error?.code)) break;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  const fallbackBackup = `${pipelinePath}.pre_fallback_${nowStamp()}.bak`;
  await fs.copyFile(pipelinePath, fallbackBackup);
  try {
    await fs.copyFile(temp, pipelinePath);
    JSON.parse(await fs.readFile(pipelinePath, 'utf8'));
    await fs.unlink(temp).catch(() => {});
    console.log(`Pipeline rename blocked; verified copy fallback succeeded. Backup: ${fallbackBackup}`);
  } catch (error) {
    await fs.copyFile(fallbackBackup, pipelinePath).catch(() => {});
    throw new Error(`Cannot persist pipeline safely: ${String(error)}; original restored from ${fallbackBackup}; rename error=${String(lastError)}`);
  }
}

async function recoverScene(context, page, sceneNumber) {
  const scene = getScene(sceneNumber);
  const existingState = scene.flow_generation ?? {};
  const oldTargetFile = sceneFile(sceneNumber);
  if (String(scene.status).toLowerCase() === 'done' && await fs.stat(oldTargetFile).then(() => true).catch(() => false)) {
    const oldHash = sha256(await fs.readFile(oldTargetFile));
    const sameHash = (await existingSceneHashes(sceneNumber)).some(item => item.hash === oldHash);
    if (!sameHash) {
      console.log(`Scene ${sceneNumber}: already marked done and local MP4 is unique; skipping to avoid replacing it.`);
      return { sceneNumber, status: 'SKIPPED_ALREADY_DONE_UNIQUE' };
    }
  }
  const found = await findLiveCard(page, sceneNumber);
  if (found.missing) throw new Error(`Scene ${sceneNumber}: no exact existing video card matched its fingerprint after scrolling. No click or generation was made.`);
  if (found.ambiguous) throw new Error(`Scene ${sceneNumber}: ${found.ambiguous.length} matching card descriptions found; refusing to choose. No click or generation was made.`);
  const cardMeta = found.match;
  if (!cardMeta.hasOpenEditor) throw new Error(`Scene ${sceneNumber}: matching card has no exact 'Open video in editor' control. Refusing to click the card itself.`);

  const card = page.locator('flow-a2ui-video-option').nth(cardMeta.index);
  const openButton = card.locator('[role="button"][aria-label="Open video in editor"]');
  if (await openButton.count() !== 1 || !await openButton.isVisible().catch(() => false) || !await openButton.isEnabled().catch(() => false)) {
    throw new Error(`Scene ${sceneNumber}: exact open-editor control is missing, hidden, or disabled. No other control will be clicked.`);
  }

  const beforeUrl = page.url();
  console.log(`Scene ${sceneNumber}: opening existing card only (DOM card index ${cardMeta.index}); no generation or approval controls will be clicked.`);
  await openButton.click({ timeout: 8000 });
  try {
    await page.waitForURL(url => isEditorUrl(String(url)), { timeout: 20000 });
  } catch {
    throw new Error(`Scene ${sceneNumber}: clicking the existing card did not open the expected video editor. URL remained/changed to ${page.url()}. No generation was submitted.`);
  }
  if (page.url() === beforeUrl) throw new Error(`Scene ${sceneNumber}: editor route did not change.`);
  await page.waitForTimeout(900);
  try {
    await page.waitForFunction(() => Array.from(document.querySelectorAll('video')).some(video => {
      const v = video;
      const style = getComputedStyle(v);
      const source = v.currentSrc || v.src || v.querySelector('source[src]')?.getAttribute('src') || '';
      return Boolean(v.getClientRects().length) && style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(source) && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
    }), null, { timeout: 35000 });
  } catch {
    throw new Error(`Scene ${sceneNumber}: editor opened, but no playable video source appeared within 35 seconds. No new generation was requested.`);
  }

  const videos = await getPlayableVideos(page);
  const unique = [...new Map(videos.map(v => [sourceIdentity(v.source), v])).values()];
  if (unique.length !== 1) {
    throw new Error(`Scene ${sceneNumber}: expected one playable editor source, found ${unique.length}. Refusing to guess.`);
  }
  const media = unique[0];
  const stateRejected = [...(existingState.excluded_sources ?? []), ...(existingState.rejected_sources ?? [])].filter(Boolean).map(sourceIdentity);
  if (/^https?:\/\//i.test(media.source) && stateRejected.includes(sourceIdentity(media.source))) {
    throw new Error(`Scene ${sceneNumber}: selected card resolves to a previously rejected source. Output not changed.`);
  }

  const downloaded = await bytesFromSource(context, page, media.source);
  assertMp4(downloaded.buffer, downloaded.contentType);
  const recoveredHash = sha256(downloaded.buffer);
  await fs.mkdir(outputDir, { recursive: true });
  const duplicates = (await existingSceneHashes(sceneNumber)).filter(item => item.hash === recoveredHash);
  if (duplicates.length) {
    throw new Error(`Scene ${sceneNumber}: recovered card produced a byte-identical clip to existing scene(s) ${duplicates.map(d => d.sceneNumber).join(', ')}. Refusing to overwrite the target MP4 or mark the scene done.`);
  }

  const target = sceneFile(sceneNumber);
  const tmpVideo = `${target}.${process.pid}.${Date.now()}.recovery.tmp`;
  const oldBackup = `${target}.before_existing_flow_recovery_${nowStamp()}.bak`;
  await fs.writeFile(tmpVideo, downloaded.buffer);
  assertMp4(await fs.readFile(tmpVideo), downloaded.contentType);
  const oldExists = await fs.stat(target).then(() => true).catch(() => false);
  if (oldExists) await fs.copyFile(target, oldBackup);
  try {
    if (oldExists) await fs.rename(target, oldBackup).catch(async () => { await fs.copyFile(target, oldBackup); await fs.unlink(target); });
    await fs.rename(tmpVideo, target);
    const verifyBytes = await fs.readFile(target);
    if (sha256(verifyBytes) !== recoveredHash) throw new Error('Saved output hash did not match the downloaded bytes.');

    const previousState = scene.flow_generation ?? {};
    scene.flow_generation = previousState;
    previousState.phase = 'complete';
    previousState.source = /^https?:\/\//i.test(media.source) ? media.source : null;
    previousState.recovery_selection = 'existing-flow-card-matched-by-specific-action-signature';
    previousState.recovery_scene_number = sceneNumber;
    previousState.recovery_card_alt = cardMeta.alt.slice(0, 600);
    previousState.recovery_download_sha256 = recoveredHash;
    previousState.recovered_from_existing_flow_card_at = new Date().toISOString();
    previousState.recovery_video_duration_seconds = media.duration;
    previousState.recovery_video_dimensions = `${media.width}x${media.height}`;
    scene.status = 'done';
    delete scene.error;
    if (scene.updated_at !== undefined) scene.updated_at = new Date().toISOString();
    await savePipelineSafely();
  } catch (error) {
    await fs.unlink(target).catch(() => {});
    if (oldExists) await fs.copyFile(oldBackup, target).catch(() => {});
    await fs.unlink(tmpVideo).catch(() => {});
    throw error;
  }
  console.log(`Scene ${sceneNumber}: recovered existing video successfully; ${verifyBytes.length} bytes; SHA256 ${recoveredHash}; duration ${media.duration.toFixed(2)}s.`);
  if (oldExists) console.log(`Scene ${sceneNumber}: previous duplicate file preserved at ${oldBackup}`);
  console.log('No prompt was submitted and no approval/credit control was clicked.');
  return { sceneNumber, status: 'RECOVERED_FROM_EXISTING_CARD', bytes: verifyBytes.length, sha256: recoveredHash, duration: media.duration, cardAlt: cardMeta.alt.slice(0, 600) };
}

await fs.mkdir(diagnosticsDir, { recursive: true });
const stamp = nowStamp();
const reportPath = path.join(diagnosticsDir, `existing-flow-video-recovery-${mode}-${stamp}.json`);
let context;
const report = {
  createdAt: new Date().toISOString(),
  mode,
  safety: 'This script never submits prompts, never clicks Generate, Approve, Always approve, or Reject. In --recover mode, it only clicks a uniquely matched existing card control labelled Open video in editor; it downloads the playable video if available and refuses local duplicates.',
  pipelinePath,
  flowUrl,
  scenes: [],
};

try {
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome', headless: false, acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
  });
  const pages = context.pages();
  let page = pages.find(p => isProjectChatUrl(p.url())) ?? pages[0];
  if (!page) page = await context.newPage();
  if (!isProjectChatUrl(page.url())) await page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('body').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForTimeout(4500);
  if (!page.url().includes(`/project/${projectId}`)) throw new Error(`Flow did not open the expected project. Current URL: ${page.url()}`);

  if (mode === 'plan') {
    console.log('READ-ONLY PLAN: no controls will be clicked, no prompts submitted, no credits requested.');
    const plan = await scanPlan(page);
    report.firstScroll = plan.firstScroll;
    report.scenes = plan.results;
    for (const result of plan.results) {
      console.log(`Scene ${result.sceneNumber}: ${result.status}; matching existing cards=${result.matchCount}`);
      for (const card of result.cards) console.log(`  Card index ${card.domIndexObserved}; Open editor=${card.hasOpenEditor}; ${card.alt}`);
    }
    console.log('No media generated or credit approval made.');
  } else {
    const backup = `${pipelinePath}.before_existing_flow_recovery_${stamp}.bak`;
    await fs.copyFile(pipelinePath, backup);
    report.pipelineBackup = backup;
    console.log(`RECOVERY MODE: only existing card selections; no prompt/approval/generation controls are used. Pipeline backup: ${backup}`);
    for (const sceneNumber of targetScenes) {
      if (!isProjectChatUrl(page.url())) await page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
      try {
        const result = await recoverScene(context, page, sceneNumber);
        report.scenes.push(result);
      } catch (error) {
        report.scenes.push({ sceneNumber, status: 'NOT_RECOVERED_NO_GENERATION', error: String(error) });
        console.error(`Scene ${sceneNumber}: NOT RECOVERED — ${String(error)}`);
        // If card click navigated to editor and recovery failed, return to the project chat before continuing.
        if (!isProjectChatUrl(page.url())) {
          await page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          await page.waitForTimeout(2500);
        }
      }
    }
  }
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
} catch (error) {
  report.fatalError = String(error?.stack ?? error);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8').catch(() => {});
  console.error(String(error?.stack ?? error));
  process.exitCode = 1;
} finally {
  if (context) await context.close().catch(() => {});
}
console.log(`Report: ${reportPath}`);
