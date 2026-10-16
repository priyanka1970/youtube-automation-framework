import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const root = process.cwd();
const idx = process.argv.indexOf('--project');
const pipelineArg = idx >= 0 && process.argv[idx + 1]
  ? process.argv[idx + 1]
  : 'scripting/projects/youtube-automation-20261015093729601/pipeline.json';
const pipelinePath = path.resolve(root, pipelineArg);
const profileDir = path.join(root, 'production', '.chrome-profile');
const outputDir = path.join(root, 'production', 'outputs', 'flow-recovery-diagnostics');
const fallbackUrl = 'https://flow.google.com/project/ca1b2a2a-1840-4580-9198-92b97a5aedb7';
const targetNumbers = [2, 3, 10, 12];
const norm = v => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const compact = (v, max = 900) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + ' …[truncated]' : s;
};

function sceneAnchor(scene) {
  const assets = scene.assets ?? {};
  const backgroundTag = String(assets.background_tag ?? scene.background_tag ?? '').trim();
  const prompt = String(
    scene.speaker === 'NARRATOR' || scene.speaker === 'none'
      ? (scene.animation_prompt_NARRATOR_ONLY ?? '')
      : (scene.animation_prompt_WITH_lipsync ?? '')
  );
  let dialogue = String(scene.devanagari_dialogue ?? '').trim();
  if (!dialogue) {
    const m = prompt.match(/DIALOGUE\s*\(DEVANAGARI ONLY\)\s*:\s*["“']([\s\S]*?)["”']\s*(?:SOUND DESIGN:|### NEGATIVE|$)/i);
    dialogue = String(m?.[1] ?? '').trim();
  }
  const actionMatch = prompt.match(/SCENE ACTION:\s*([\s\S]*?)(?:\s+CAMERA:|$)/i);
  return {
    sceneNumber: Number(scene.scene_number),
    backgroundTag,
    dialogue: compact(dialogue, 180),
    promptFieldAvailable: Boolean(prompt),
    promptPrefix: compact(prompt, 220),
    anchorAvailable: Boolean(backgroundTag && (dialogue || prompt.length > 20)),
  };
}

function sha(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

let pipeline;
try {
  pipeline = JSON.parse(await fs.readFile(pipelinePath, 'utf8'));
} catch (e) {
  console.error(`Cannot read pipeline JSON: ${pipelinePath}\n${String(e)}`);
  process.exit(2);
}
const scenes = Array.isArray(pipeline.scenes) ? [...pipeline.scenes].sort((a,b) => Number(a.scene_number)-Number(b.scene_number)) : [];
if (!scenes.length) {
  console.error('No scenes[] array found in pipeline.json. No UI was opened.');
  process.exit(2);
}
const flowUrl = String(pipeline.flow_project_url ?? pipeline.project_url ?? fallbackUrl);
await fs.mkdir(outputDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-');
const reportPath = path.join(outputDir, `flow-dom-inspection-${stamp}.json`);
const screenshotPath = path.join(outputDir, `flow-dom-inspection-${stamp}.png`);
const collectedBubbles = new Map();
const collectedCards = new Map();
let targetAnchorChecks = [];
let context;
const ui = { opened: false, url: null, title: null, scrollSteps: 0, scanErrors: [], lastCounts: null };

try {
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome', headless: false, acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
  });
  let page = context.pages().find(p => p.url().includes('/project/')) ?? context.pages()[0];
  if (!page) page = await context.newPage();
  if (!page.url().includes('/project/')) await page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('body').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForTimeout(4000);
  ui.opened = true;

  const maxSteps = 72;
  for (let step = 0; step <= maxSteps; step++) {
    let scan;
    try {
      scan = await page.evaluate(() => {
        const textOf = el => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
        const bubbles = Array.from(document.querySelectorAll('flow-chat-bubble'));
        const bubbleData = bubbles.map((b, index) => ({
          index,
          text: textOf(b).slice(0, 3200),
          tagName: b.tagName.toLowerCase(),
          ariaLabel: b.getAttribute('aria-label') || '',
          role: b.getAttribute('role') || '',
          className: String(b.className || '').slice(0, 180),
        }));
        const gallerySelectors = [
          'flow-a2ui-multiple-choice', 'flow-a2ui-video-option', 'img.video-thumbnail',
          'video', '[role="option"]', '[data-testid*="video"]', '[aria-label*="video" i]'
        ];
        const selectorCounts = {};
        for (const sel of gallerySelectors) {
          try { selectorCounts[sel] = document.querySelectorAll(sel).length; }
          catch { selectorCounts[sel] = -1; }
        }
        const cardNodes = Array.from(document.querySelectorAll('flow-a2ui-video-option, flow-a2ui-multiple-choice, img.video-thumbnail, video, [role="option"], [data-testid*="video"], [aria-label*="video" i]'));
        const cardData = cardNodes.slice(0, 250).map((el, index) => {
          const imgs = el.matches('img') ? [el] : Array.from(el.querySelectorAll('img'));
          const videos = el.matches('video') ? [el] : Array.from(el.querySelectorAll('video'));
          const img = imgs[0];
          let parent = el;
          for (let i=0; i<5 && parent && !parent.matches('flow-chat-bubble'); i++) parent = parent.parentElement;
          const bubbleIndex = parent?.matches('flow-chat-bubble') ? bubbles.indexOf(parent) : -1;
          return {
            index,
            tagName: el.tagName.toLowerCase(),
            text: textOf(el).slice(0, 500),
            ariaLabel: el.getAttribute('aria-label') || '',
            title: el.getAttribute('title') || '',
            role: el.getAttribute('role') || '',
            className: String(el.className || '').slice(0, 160),
            bubbleIndex,
            imageCount: imgs.length,
            videoCount: videos.length,
            hasVideoThumbnailClass: Boolean(el.matches('img.video-thumbnail') || el.querySelector('img.video-thumbnail')),
            imageAlts: imgs.slice(0,4).map(i => i.getAttribute('alt') || i.getAttribute('title') || ''),
            videoReadyState: videos.slice(0,3).map(v => v.readyState),
          };
        });
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
          let par = el.parentElement;
          for (let k=0; !reverse && par && k<3; k++, par=par.parentElement) reverse = getComputedStyle(par).flexDirection === 'column-reverse';
          candidates.push({ el, bubbleCount: el.querySelectorAll('flow-chat-bubble').length, range, reverse });
        }
        candidates.sort((a,b) => b.bubbleCount-a.bubbleCount || b.range-a.range);
        let didScroll = false, scrollInfo = null;
        for (const c of candidates) {
          const before = c.el.scrollTop;
          const delta = Math.max(360, Math.floor(c.el.clientHeight * 0.7));
          let next;
          if (c.reverse) next = Math.max(-c.range, before - delta);
          else if (before > 2) next = Math.max(0, before - delta);
          else next = Math.min(c.range, before + delta);
          if (next !== before) {
            c.el.scrollTop = next;
            didScroll = c.el.scrollTop !== before;
            scrollInfo = { before, after: c.el.scrollTop, range: c.range, bubbleCount: c.bubbleCount, reverse: c.reverse };
            if (didScroll) break;
          }
        }
        const bodyText = textOf(document.body);
        return {
          url: location.href,
          title: document.title,
          bubbleData,
          bubbleCount: bubbles.length,
          selectorCounts,
          cardData,
          bodyText: bodyText.slice(0, 12000),
          didScroll,
          scrollInfo,
          documentScroll: root ? { top: root.scrollTop, height: root.scrollHeight, clientHeight: root.clientHeight } : null,
        };
      });
    } catch (e) {
      ui.scanErrors.push(`step ${step}: ${String(e)}`);
      break;
    }
    ui.scrollSteps = step;
    ui.url = scan.url;
    ui.title = scan.title;
    ui.lastCounts = { bubbleCount: scan.bubbleCount, selectorCounts: scan.selectorCounts, scrollInfo: scan.scrollInfo, documentScroll: scan.documentScroll };

    for (const b of scan.bubbleData) {
      const key = sha(norm(b.text));
      if (b.text && !collectedBubbles.has(key)) collectedBubbles.set(key, { ...b, hash: key });
    }
    for (const c of scan.cardData) {
      const key = sha(norm(`${c.tagName}|${c.text}|${c.ariaLabel}|${c.imageAlts.join('|')}|${c.hasVideoThumbnailClass}`));
      if (!collectedCards.has(key)) collectedCards.set(key, { ...c, hash: key });
    }
    if (!scan.didScroll) break;
    await page.waitForTimeout(300);
  }

  const allText = [...collectedBubbles.values()].map(x => x.text).join('\n');
  targetAnchorChecks = targetNumbers.map(n => {
    const s = scenes.find(x => Number(x.scene_number) === n);
    return s ? sceneAnchor(s) : { sceneNumber: n, anchorAvailable: false };
  }).map(a => {
    const text = norm(allText);
    const tagFound = Boolean(a.backgroundTag && text.includes(norm(a.backgroundTag)));
    const dialogueCore = norm(a.dialogue).slice(0, Math.min(70, norm(a.dialogue).length));
    return { ...a, backgroundTagFoundInCapturedBubbleText: tagFound, dialogueSnippetFoundInCapturedBubbleText: Boolean(dialogueCore && text.includes(dialogueCore)) };
  });
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(e => ui.scanErrors.push(`screenshot: ${String(e)}`));

  const report = {
    generatedAt: new Date().toISOString(),
    safety: 'READ-ONLY: no buttons clicked, no prompts submitted, no approval actions, no media generation. Scrolls existing chat only.',
    pipelinePath,
    flowUrl,
    ui,
    targetAnchorChecks,
    bubbleCountUnique: collectedBubbles.size,
    bubbleSnapshots: [...collectedBubbles.values()].map(b => ({ ...b, text: compact(b.text, 1400) })),
    galleryAndMediaElements: [...collectedCards.values()],
    screenshotPath,
  };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
} catch (e) {
  ui.error = String(e?.stack ?? e);
} finally {
  if (context) await context.close().catch(() => {});
}

console.log('\nREAD-ONLY FLOW DOM INSPECTION COMPLETE');
console.log('No buttons clicked. No prompts submitted. No credits spent by this script.');
console.log(`Flow URL: ${ui.url ?? '(unavailable)'}`);
console.log(`Title: ${ui.title ?? '(unavailable)'}`);
console.log(`Scroll steps: ${ui.scrollSteps}`);
console.log(`Unique chat bubbles captured: ${collectedBubbles.size}`);
console.log(`Distinct candidate gallery/media elements captured: ${collectedCards.size}`);
for (const a of targetAnchorChecks) console.log(`Scene ${a.sceneNumber}: bgTagInCapturedText=${a.backgroundTagFoundInCapturedBubbleText}; dialogueSnippetInCapturedText=${a.dialogueSnippetFoundInCapturedBubbleText}; anchorAvailable=${a.anchorAvailable}`);
console.log(`JSON report: ${reportPath}`);
console.log(`Screenshot: ${screenshotPath}`);
if (ui.error) console.log(`UI inspection error: ${ui.error}`);
