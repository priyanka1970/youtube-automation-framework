import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const root = process.cwd();
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const pipelinePath = path.resolve(root, argValue('--project', 'scripting/projects/youtube-automation-20261015093729601/pipeline.json'));
const sceneNumber = Number(argValue('--scene', '2'));
const profileDir = path.join(root, 'production', '.chrome-profile');
const diagnosticDir = path.join(root, 'production', 'outputs', 'flow-recovery-diagnostics');
const outputDir = path.join(root, 'production', 'outputs', 'youtube-automation-20261015093729601');
const fingerprints = {
  2: 'driver bholaram, holding the steering wheel, turns his head toward radhika',
  3: 'a sudden gust of wind swirls through the area by the third seat',
  10: "close-up on the driver bholaram's face; a strange, subtle glint appears in his eyes",
  12: 'the bus slowly drives away down the road, eventually disappearing into a thickening mist',
};
if (!fingerprints[sceneNumber]) throw new Error('Use --scene 2, 3, 10, or 12.');
const normalize = v => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const stamp = () => new Date().toISOString().replaceAll(':', '-');
const safeUrl = input => { try { const u = new URL(input); return `${u.origin}${u.pathname}`; } catch { return String(input ?? '').slice(0, 250); } };
const isProjectChatUrl = (value, projectId) => {
  try { const u = new URL(value); return u.hostname === 'flow.google.com' && /^\/project\/[^/]+\/?$/.test(u.pathname) && (!projectId || u.pathname.includes(`/project/${projectId}`)); } catch { return false; }
};
const isEditorUrl = value => { try { return /\/project\/[^/]+\/edit\/[^/]+\/?$/.test(new URL(value).pathname); } catch { return false; } };

async function scrollChat(page, reset = false) {
  return page.evaluate((shouldReset) => {
    const all = Array.from(document.querySelectorAll('*'));
    const root = document.scrollingElement;
    if (root && root.scrollHeight > root.clientHeight + 8) all.push(root);
    const candidates = [], seen = new Set();
    for (const el of all) {
      if (!(el instanceof HTMLElement) || seen.has(el)) continue;
      seen.add(el);
      if (el !== root && !/(auto|scroll|overlay)/i.test(getComputedStyle(el).overflowY)) continue;
      const range = el.scrollHeight - el.clientHeight;
      if (range <= 8 || el.clientHeight < 80 || el.querySelectorAll('flow-chat-bubble').length === 0) continue;
      let reverse = getComputedStyle(el).flexDirection === 'column-reverse';
      let parent = el.parentElement;
      for (let k = 0; !reverse && parent && k < 3; k++, parent = parent.parentElement) reverse = getComputedStyle(parent).flexDirection === 'column-reverse';
      candidates.push({ el, bubbleCount: el.querySelectorAll('flow-chat-bubble').length, range, reverse });
    }
    candidates.sort((a, b) => b.bubbleCount - a.bubbleCount || b.range - a.range);
    const picked = candidates[0];
    if (!picked) {
      if (root && root.scrollHeight > root.clientHeight + 8) {
        const before = root.scrollTop;
        root.scrollTop = shouldReset ? 0 : Math.min(root.scrollHeight - root.clientHeight, before + Math.max(360, Math.floor(root.clientHeight * 0.7)));
        return { moved: root.scrollTop !== before };
      }
      return { moved: false };
    }
    const before = picked.el.scrollTop;
    if (shouldReset) picked.el.scrollTop = 0;
    else {
      const delta = Math.max(360, Math.floor(picked.el.clientHeight * 0.68));
      picked.el.scrollTop = picked.reverse ? Math.max(-picked.range, before - delta) : Math.min(picked.range, before + delta);
    }
    return { moved: picked.el.scrollTop !== before };
  }, reset);
}

async function cardsOnPage(page) {
  return page.locator('flow-a2ui-video-option').evaluateAll(cards => cards.map((card, index) => {
    const image = card.querySelector('img.video-thumbnail') || card.querySelector('img');
    const style = getComputedStyle(card), imageStyle = image ? getComputedStyle(image) : null;
    const visible = Boolean(card.getClientRects().length) && style.visibility !== 'hidden' && style.display !== 'none' && Boolean(image) && Boolean(image.getClientRects().length) && imageStyle?.visibility !== 'hidden' && imageStyle?.display !== 'none';
    const alt = image?.getAttribute('alt') || image?.getAttribute('title') || '';
    const openButton = card.querySelector('[role="button"][aria-label="Open video in editor"]');
    return { index, alt, visible, hasOpenEditor: Boolean(openButton) };
  }));
}

async function findCard(page) {
  await scrollChat(page, true);
  await page.waitForTimeout(300);
  for (let step = 0; step < 120; step++) {
    const cards = await cardsOnPage(page);
    const matches = cards.filter(c => c.visible && normalize(c.alt).includes(fingerprints[sceneNumber]));
    if (matches.length === 1) return { card: matches[0], steps: step + 1 };
    if (matches.length > 1) return { ambiguous: matches.map(c => ({ index: c.index, alt: c.alt.slice(0, 300) })), steps: step + 1 };
    const movement = await scrollChat(page, false);
    if (!movement.moved) break;
    await page.waitForTimeout(250);
  }
  return { missing: true };
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    const stream = handle.createReadStream();
    for await (const chunk of stream) hash.update(chunk);
  } finally { await handle.close().catch(() => {}); }
  return hash.digest('hex').toUpperCase();
}

const pipeline = JSON.parse(await fs.readFile(pipelinePath, 'utf8'));
const flowUrl = String(pipeline.flow_project_url ?? pipeline.project_url ?? 'https://flow.google.com/project/ca1b2a2a-1840-4580-9198-92b97a5aedb7');
const projectId = new URL(flowUrl).pathname.match(/^\/project\/([^/]+)/)?.[1];
await fs.mkdir(diagnosticDir, { recursive: true });
await fs.mkdir(outputDir, { recursive: true });
const ts = stamp();
const reportPath = path.join(diagnosticDir, `existing-flow-video-download-scene-${sceneNumber}-${ts}.json`);
const report = {
  createdAt: new Date().toISOString(), sceneNumber, mode: 'download existing Flow result at 720p Original size',
  safety: 'Does not submit prompts, click Generate/Approve/Always approve/Reject, or edit pipeline.json. Clicks only a uniquely matched existing video card, the Download media menu trigger, and the exact 720p Original size menu item. Saves to a separate recovery candidate path and reports duplicate hashes without overwriting scene files.',
  flowUrl: safeUrl(flowUrl), pipelinePath, reportPath,
};
let context;
let downloadCandidate = null;
try {
  context = await chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: false, acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  const pages = context.pages();
  let page = pages.find(p => isProjectChatUrl(p.url(), projectId)) ?? pages[0];
  if (!page) page = await context.newPage();
  if (!isProjectChatUrl(page.url(), projectId)) await page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('body').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForTimeout(3500);
  if (!isProjectChatUrl(page.url(), projectId)) throw new Error(`Expected project chat URL but found ${safeUrl(page.url())}`);

  console.log(`Finding existing Scene ${sceneNumber} card. No generation/approval controls will be used.`);
  const found = await findCard(page);
  report.cardSearch = found.missing ? { missing: true } : found.ambiguous ? { ambiguous: found.ambiguous } : { domIndex: found.card.index, steps: found.steps, description: found.card.alt.slice(0, 1200) };
  if (found.missing) throw new Error(`No matching existing video card found for Scene ${sceneNumber}; stopped without clicking a card.`);
  if (found.ambiguous) throw new Error(`Multiple cards match Scene ${sceneNumber}; refusing to choose.`);
  if (!found.card.hasOpenEditor) throw new Error('Matched card does not expose the exact Open video in editor control.');
  const open = page.locator('flow-a2ui-video-option').nth(found.card.index).locator('[role="button"][aria-label="Open video in editor"]');
  if (await open.count() !== 1 || !await open.isVisible().catch(() => false) || !await open.isEnabled().catch(() => false)) throw new Error('Existing card editor control is not uniquely visible/enabled.');
  await open.click({ timeout: 8000 });
  await page.waitForURL(url => isEditorUrl(String(url)), { timeout: 20000 });
  report.editorUrl = safeUrl(page.url());
  await page.waitForTimeout(3000);

  const downloadButton = page.locator('button[aria-label="Download media"]');
  if (await downloadButton.count() !== 1 || !await downloadButton.isVisible().catch(() => false) || !await downloadButton.isEnabled().catch(() => false)) throw new Error('Could not uniquely identify the Download media button.');
  await downloadButton.click({ timeout: 8000 });
  await page.waitForTimeout(500);

  // Flow currently exposes the resolution choices as Angular Material menu buttons.
  // getByRole('button', { name }) did not resolve them reliably, despite the menu
  // inspector observing these as visible button elements. Inspect actual DOM text,
  // then click only the one uniquely matching enabled menu button.
  const menuItemSelector = 'button.mat-mdc-menu-item, a.mat-mdc-menu-item, button[role="menuitem"], a[role="menuitem"], [role="option"]';
  const menuCandidates = page.locator(menuItemSelector);
  const menuSnapshot = await menuCandidates.evaluateAll(elements => elements.map((el, index) => {
    const style = getComputedStyle(el);
    const rects = el.getClientRects();
    return {
      index,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
      ariaDisabled: el.getAttribute('aria-disabled') || '',
      disabled: Boolean(el.disabled),
      visible: Boolean(rects.length) && style.display !== 'none' && style.visibility !== 'hidden',
      className: String(el.className || '').slice(0, 200)
    };
  }));
  report.menuCandidates = menuSnapshot;
  const wanted = '720p Original size';
  const matching = menuSnapshot.filter(x => normalize(x.text) === normalize(wanted) && x.visible && !x.disabled && x.ariaDisabled !== 'true');
  report.originalSizeMenuItemCount = matching.length;
  if (matching.length !== 1) {
    report.menuText = (await page.locator('body').innerText().catch(() => '')).slice(-5000);
    report.menuScreenshot = path.join(diagnosticDir, `scene-${String(sceneNumber).padStart(4,'0')}.download-menu-${ts}.png`);
    await page.screenshot({ path: report.menuScreenshot, fullPage: false }).catch(e => { report.screenshotError = String(e); });
    throw new Error(`Expected exactly one visible enabled menu element with text '${wanted}'; found ${matching.length}. No menu item was selected.`);
  }

  console.log(`Selecting existing media's '720p Original size' download for Scene ${sceneNumber}. This is not a generation action.`);
  const originalItem = menuCandidates.nth(matching[0].index);
  const downloadPromise = page.waitForEvent('download', { timeout: 90000 });
  await originalItem.click({ timeout: 10000 });
  const download = await downloadPromise;
  report.suggestedFilename = download.suggestedFilename();
  const failure = await download.failure().catch(() => null);
  if (failure) throw new Error(`Flow download failed: ${failure}`);
  const suggestedExt = path.extname(download.suggestedFilename()).toLowerCase();
  const ext = ['.mp4', '.webm', '.mov'].includes(suggestedExt) ? suggestedExt : '.mp4';
  downloadCandidate = path.join(diagnosticDir, `scene-${String(sceneNumber).padStart(4,'0')}.recovery-candidate-${ts}${ext}`);
  await download.saveAs(downloadCandidate);
  const stat = await fs.stat(downloadCandidate);
  if (stat.size < 50000) throw new Error(`Downloaded candidate is unexpectedly small (${stat.size} bytes); retained for diagnostics, not accepted.`);
  const signatureHandle = await fs.open(downloadCandidate, 'r');
  const sigBuf = Buffer.alloc(32);
  let readResult;
  try { readResult = await signatureHandle.read(sigBuf, 0, sigBuf.length, 0); }
  finally { await signatureHandle.close(); }
  const sig = sigBuf.subarray(0, readResult.bytesRead).toString('latin1');
  const looksLikeMp4 = sig.includes('ftyp');
  report.download = { candidatePath: downloadCandidate, bytes: stat.size, megabytes: Math.round(stat.size / 1024 / 1024 * 100) / 100, extension: ext, sha256: await sha256(downloadCandidate), hasMp4FtypSignature: looksLikeMp4 };

  const clips = await fs.readdir(outputDir).catch(() => []);
  const comparisons = [];
  for (const name of clips.filter(n => /^scene-\d+\.mp4$/i.test(n))) {
    const match = name.match(/^scene-(\d+)\.mp4$/i);
    if (Number(match[1]) === sceneNumber) continue; // Ignore the known-bad existing target file itself.
    const full = path.join(outputDir, name);
    comparisons.push({ file: name, sha256: await sha256(full) });
  }
  report.duplicateMatches = comparisons.filter(x => x.sha256 === report.download.sha256).map(x => x.file);
  report.acceptance = report.duplicateMatches.length ? 'DUPLICATE_HASH_REFUSED_FOR_PIPELINE_UPDATE' : looksLikeMp4 ? 'UNIQUE_CANDIDATE_DOWNLOADED_NOT_YET_INSTALLED' : 'DOWNLOADED_FILE_SIGNATURE_UNCONFIRMED_NOT_INSTALLED';
  console.log(`Downloaded candidate: ${downloadCandidate}`);
  console.log(`Size: ${stat.size} bytes; SHA256: ${report.download.sha256}`);
  console.log(`MP4 signature detected: ${looksLikeMp4}`);
  console.log(report.duplicateMatches.length ? `DUPLICATE with: ${report.duplicateMatches.join(', ')}. Pipeline and target MP4 were not changed.` : 'No matching hash found in other scene MP4 files. Pipeline and target MP4 remain unchanged pending review.');
} catch (error) {
  report.error = String(error?.stack ?? error);
  console.error(String(error?.message ?? error));
} finally {
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8').catch(() => {});
  if (context) await context.close().catch(() => {});
}
console.log(`Report: ${reportPath}`);
if (report.error) process.exitCode = 1;
