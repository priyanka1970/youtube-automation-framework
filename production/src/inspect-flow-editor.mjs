import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const hasArg = name => args.includes(name);
const pipelinePath = path.resolve(root, argValue('--project', 'scripting/projects/youtube-automation-20261015093729601/pipeline.json'));
const sceneNumber = Number(argValue('--scene', '2'));
const profileDir = path.join(root, 'production', '.chrome-profile');
const diagnosticsDir = path.join(root, 'production', 'outputs', 'flow-recovery-diagnostics');
const fingerprints = {
  2: 'driver bholaram, holding the steering wheel, turns his head toward radhika',
  3: 'a sudden gust of wind swirls through the area by the third seat',
  10: "close-up on the driver bholaram's face; a strange, subtle glint appears in his eyes",
  12: 'the bus slowly drives away down the road, eventually disappearing into a thickening mist',
};
if (!fingerprints[sceneNumber]) throw new Error('Use --scene 2, 3, 10, or 12.');

const normalize = v => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const timestamp = () => new Date().toISOString().replaceAll(':', '-');
const sanitizeUrl = input => {
  try {
    const u = new URL(input);
    // Never emit query strings or fragments; these can contain signed URLs or tokens.
    return `${u.origin}${u.pathname}${u.search ? '?[query-redacted]' : ''}${u.hash ? '#[fragment-redacted]' : ''}`;
  } catch { return String(input ?? '').slice(0, 300); }
};
const isProjectChatUrl = (value, projectId) => {
  try {
    const u = new URL(value);
    return u.hostname === 'flow.google.com' && /^\/project\/[^/]+\/?$/.test(u.pathname)
      && (!projectId || u.pathname.includes(`/project/${projectId}`));
  } catch { return false; }
};
const isEditorUrl = value => {
  try { return /\/project\/[^/]+\/edit\/[^/]+\/?$/.test(new URL(value).pathname); }
  catch { return false; }
};

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
      for (let k = 0; !reverse && parent && k < 3; k++, parent = parent.parentElement) reverse = getComputedStyle(parent).flexDirection === 'column-reverse';
      candidates.push({ el, bubbleCount: el.querySelectorAll('flow-chat-bubble').length, range, reverse });
    }
    candidates.sort((a, b) => b.bubbleCount - a.bubbleCount || b.range - a.range);
    const picked = candidates[0];
    if (!picked) {
      if (root && root.scrollHeight > root.clientHeight + 8) {
        const before = root.scrollTop;
        if (shouldReset) root.scrollTop = 0;
        else root.scrollTop = Math.min(root.scrollHeight - root.clientHeight, before + Math.max(360, Math.floor(root.clientHeight * 0.7)));
        return { found: true, bubbles, moved: root.scrollTop !== before };
      }
      return { found: false, bubbles, moved: false };
    }
    const { el, range, reverse } = picked;
    const before = el.scrollTop;
    if (shouldReset) el.scrollTop = 0;
    else {
      const delta = Math.max(360, Math.floor(el.clientHeight * 0.68));
      el.scrollTop = reverse ? Math.max(-range, before - delta) : Math.min(range, before + delta);
    }
    return { found: true, bubbles, moved: el.scrollTop !== before };
  }, reset);
}

async function cardsOnPage(page) {
  return page.locator('flow-a2ui-video-option').evaluateAll(cards => cards.map((card, index) => {
    const image = card.querySelector('img.video-thumbnail') || card.querySelector('img');
    const style = getComputedStyle(card);
    const imgStyle = image ? getComputedStyle(image) : null;
    const visible = Boolean(card.getClientRects().length) && style.visibility !== 'hidden' && style.display !== 'none'
      && Boolean(image) && Boolean(image.getClientRects().length) && imgStyle?.visibility !== 'hidden' && imgStyle?.display !== 'none';
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
    if (matches.length > 1) return { ambiguous: matches.map(c => ({ index: c.index, alt: c.alt.slice(0, 350) })), steps: step + 1 };
    const movement = await scrollChat(page, false);
    if (!movement.moved) break;
    await page.waitForTimeout(250);
  }
  return { missing: true };
}

async function inspectEditor(page) {
  return page.evaluate(() => {
    const visible = el => {
      const s = getComputedStyle(el);
      return Boolean(el.getClientRects().length) && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const text = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    const attrs = el => {
      const out = {};
      for (const name of ['aria-label','title','role','data-testid','download','type','controls','src','href','name','id','class']) {
        if (el.hasAttribute(name)) out[name] = el.getAttribute(name);
      }
      return out;
    };
    const relevant = /download|save|export|video|media|play|open|more|share|file|asset/i;
    const controls = Array.from(document.querySelectorAll('button,[role="button"],a,input,[role="menuitem"]'))
      .filter(visible)
      .map((el, i) => ({ index: i, tag: el.tagName.toLowerCase(), text: text(el), attrs: attrs(el) }))
      .filter(item => relevant.test([item.text, ...Object.values(item.attrs)].join(' ')))
      .slice(0, 160);
    const videos = Array.from(document.querySelectorAll('video')).map((v, i) => ({
      index: i, visible: visible(v), attrs: attrs(v), currentSrc: v.currentSrc || '', src: v.getAttribute('src') || '',
      readyState: v.readyState, networkState: v.networkState, duration: Number.isFinite(v.duration) ? v.duration : null,
      width: v.videoWidth, height: v.videoHeight, paused: v.paused, errorCode: v.error?.code ?? null,
      sources: Array.from(v.querySelectorAll('source')).map(s => ({ attrs: attrs(s), src: s.getAttribute('src') || '' })),
    }));
    const images = Array.from(document.querySelectorAll('img')).filter(visible).slice(0, 100).map((img, i) => ({
      index: i, alt: img.alt || '', title: img.title || '', src: img.getAttribute('src') || '',
      currentSrc: img.currentSrc || '', className: typeof img.className === 'string' ? img.className : ''
    }));
    const mediaNodes = Array.from(document.querySelectorAll('flow-a2ui-video-option,flow-a2ui-multiple-choice,video,source,audio,canvas,iframe,[aria-label]'))
      .filter(visible).slice(0, 200).map((el, i) => ({ index: i, tag: el.tagName.toLowerCase(), text: text(el).slice(0, 220), attrs: attrs(el) }));
    const resourceEntries = performance.getEntriesByType('resource').map(e => ({
      name: e.name, initiatorType: e.initiatorType, durationMs: Math.round(e.duration), transferSize: e.transferSize || 0
    })).filter(e => /\.mp4|\.webm|\.m3u8|\.mpd|video|media|download|storage|usercontent|blob:/i.test(e.name))
      .slice(-120).map(e => ({ ...e, name: (() => { try { const u = new URL(e.name); return `${u.origin}${u.pathname}${u.search ? '?[query-redacted]' : ''}`; } catch { return e.name.slice(0,300); } })() }));
    return {
      capturedAt: new Date().toISOString(), url: location.href, title: document.title,
      bodyText: (document.body?.innerText || '').slice(0, 16000),
      counts: { buttons: document.querySelectorAll('button').length, roleButtons: document.querySelectorAll('[role="button"]').length, anchors: document.querySelectorAll('a').length, videos: videos.length, visibleImages: images.length, iframes: document.querySelectorAll('iframe').length },
      controls, videos, images, mediaNodes, resourceEntries,
      iframes: Array.from(document.querySelectorAll('iframe')).map((el, i) => ({ index: i, title: el.title, src: el.getAttribute('src') || '', attrs: attrs(el) })),
    };
  });
}

const pipeline = JSON.parse(await fs.readFile(pipelinePath, 'utf8'));
const flowUrl = String(pipeline.flow_project_url ?? pipeline.project_url ?? 'https://flow.google.com/project/ca1b2a2a-1840-4580-9198-92b97a5aedb7');
const projectId = new URL(flowUrl).pathname.match(/^\/project\/([^/]+)/)?.[1];
await fs.mkdir(diagnosticsDir, { recursive: true });
const stamp = timestamp();
const reportPath = path.join(diagnosticsDir, `flow-editor-inspection-scene-${sceneNumber}-${stamp}.json`);
const screenshotPath = path.join(diagnosticsDir, `flow-editor-inspection-scene-${sceneNumber}-${stamp}.png`);
let context;
const report = {
  createdAt: new Date().toISOString(), sceneNumber, mode: 'read-only editor inspection',
  safety: 'This diagnostic opens only a uniquely matched existing video card through its Open video in editor control. It does not click Generate, Approve, Always approve, Reject, or submit prompts. Query strings are redacted from report URLs.',
  flowUrl: sanitizeUrl(flowUrl), pipelinePath, screenshotPath, reportPath,
};
try {
  context = await chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: false, acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  const pages = context.pages();
  let page = pages.find(p => isProjectChatUrl(p.url(), projectId)) ?? pages[0];
  if (!page) page = await context.newPage();
  if (!isProjectChatUrl(page.url(), projectId)) await page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('body').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForTimeout(4000);
  if (!isProjectChatUrl(page.url(), projectId)) throw new Error(`Expected project chat URL but found ${sanitizeUrl(page.url())}`);
  console.log(`Read-only inspector for Scene ${sceneNumber}: locating existing matching card. No generation/approval controls will be used.`);
  const found = await findCard(page);
  report.cardSearch = found;
  if (found.missing) throw new Error(`No existing card matched the verified Scene ${sceneNumber} fingerprint. No controls were clicked.`);
  if (found.ambiguous) throw new Error(`Multiple cards matched Scene ${sceneNumber}; refusing to choose. No controls were clicked.`);
  if (!found.card.hasOpenEditor) throw new Error(`Scene ${sceneNumber}'s matching card has no exact Open video in editor control. No controls were clicked.`);
  report.matchedCard = { domIndex: found.card.index, alt: found.card.alt.slice(0, 1200) };
  const card = page.locator('flow-a2ui-video-option').nth(found.card.index);
  const open = card.locator('[role="button"][aria-label="Open video in editor"]');
  if (await open.count() !== 1 || !await open.isVisible().catch(() => false) || !await open.isEnabled().catch(() => false)) throw new Error('Exact Open video in editor control was not uniquely visible/enabled. No controls were clicked.');
  await open.click({ timeout: 8000 });
  try { await page.waitForURL(url => isEditorUrl(String(url)), { timeout: 20000 }); }
  catch { throw new Error(`Existing card click did not navigate to expected editor route. Current URL: ${sanitizeUrl(page.url())}`); }
  report.editorUrl = sanitizeUrl(page.url());
  await page.waitForTimeout(9000);
  report.editor = await inspectEditor(page);
  await page.screenshot({ path: screenshotPath, fullPage: false }).catch(e => { report.screenshotError = String(e); });
  console.log(`Editor inspection captured for Scene ${sceneNumber}.`);
  console.log(`URL: ${report.editorUrl}`);
  console.log(`Visible controls matching download/media keywords: ${report.editor.controls.length}`);
  console.log(`Video elements: ${report.editor.videos.length}; matching media/network resource entries: ${report.editor.resourceEntries.length}`);
  console.log(`Report: ${reportPath}`);
  console.log(`Screenshot: ${screenshotPath}`);
  console.log('No prompts submitted. No credit approval or generation controls clicked.');
} catch (error) {
  report.error = String(error?.stack ?? error);
  console.error(String(error?.message ?? error));
} finally {
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8').catch(() => {});
  if (context) await context.close().catch(() => {});
}
console.log(`Report: ${reportPath}`);
if (report.error) process.exitCode = 1;
