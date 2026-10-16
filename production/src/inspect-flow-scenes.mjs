import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const argIndex = process.argv.indexOf('--project');
const pipelineArg = argIndex >= 0 && process.argv[argIndex + 1]
  ? process.argv[argIndex + 1]
  : 'scripting/projects/youtube-automation-20261015093729601/pipeline.json';
const pipelinePath = path.resolve(root, pipelineArg);
const fallbackFlowUrl = 'https://flow.google.com/project/ca1b2a2a-1840-4580-9198-92b97a5aedb7';
const profileDir = path.join(root, 'production', '.chrome-profile');
const outputDir = path.join(root, 'production', 'outputs', 'flow-recovery-diagnostics');
const targetNumbers = [2, 3, 10, 12];

const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const nice = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function makeAnchor(scene) {
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
  const actionSnippet = String(actionMatch?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
  if (!backgroundTag || (!dialogue && actionSnippet.length < 20)) return null;
  return {
    prefix: 'Generate exactly one 16:9 VIDEO scene using the saved reference assets',
    backgroundTag,
    dialogue,
    actionSnippet,
  };
}

async function hashFile(file) {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256');
  const stream = (await import('node:fs')).createReadStream(file);
  for await (const chunk of stream) h.update(chunk);
  return h.digest('hex');
}

function fieldExists(obj, field) {
  return obj && Object.prototype.hasOwnProperty.call(obj, field);
}

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
const flowUrl = String(pipeline.flow_project_url ?? pipeline.project_url ?? fallbackFlowUrl);
await fs.mkdir(outputDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-');
const reportPath = path.join(outputDir, `scene-availability-${stamp}.json`);
const screenshotPath = path.join(outputDir, `scene-availability-${stamp}.png`);

const sceneRows = [];
const hashes = new Map();
for (const s of scenes) {
  const n = Number(s.scene_number);
  const file = path.join(root, 'production', 'outputs', path.basename(path.dirname(pipelinePath)), `scene-${String(n).padStart(4,'0')}.mp4`);
  // The output folder is parallel to the pipeline project key, not the pipeline directory.
  const outputRoot = path.join(root, 'production', 'outputs', path.basename(path.dirname(pipelinePath)));
  const actualFile = path.join(outputRoot, `scene-${String(n).padStart(4,'0')}.mp4`);
  let local = { exists: false, hash: null, sizeBytes: null, duplicateOf: null };
  try {
    const st = await fs.stat(actualFile);
    const hash = await hashFile(actualFile);
    const previous = hashes.get(hash);
    local = { exists: true, hash, sizeBytes: st.size, duplicateOf: previous ?? null };
    if (!previous) hashes.set(hash, n);
  } catch {}
  const state = s.flow_generation ?? null;
  sceneRows.push({
    sceneNumber: n,
    status: s.status ?? null,
    phase: state?.phase ?? null,
    sourceSaved: Boolean(state?.source),
    approvalAccepted: state?.approval_accepted ?? null,
    error: s.error ?? null,
    promptAnchorAvailable: Boolean(makeAnchor(s)),
    localMP4: local,
  });
}

const backgroundRows = (pipeline.backgrounds ?? []).map((x,i) => ({ index: i+1, status: x.status ?? null, generationPhase: x.flow_generation?.phase ?? null, sourceSaved: Boolean(x.flow_generation?.source) }));
const characterRows = (pipeline.characters ?? []).map((x,i) => ({ index: i+1, name: x.name ?? null, status: x.status ?? null, generationPhase: x.flow_generation?.phase ?? null, sourceSaved: Boolean(x.flow_generation?.source) }));

let context;
let ui = { opened: false, url: null, title: null, loginOrVerificationLikely: false, scrollSteps: 0, targetScenes: {} };
try {
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome', headless: false, acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
  });
  let page = context.pages().find(p => p.url().includes('/project/')) ?? context.pages()[0];
  if (!page) page = await context.newPage();
  if (!page.url().includes('/project/')) {
    await page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await page.locator('body').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForTimeout(4500);
  ui.opened = true;

  const anchors = scenes.map(s => ({
    sceneNumber: Number(s.scene_number),
    anchor: makeAnchor(s),
  })).filter(x => x.anchor);
  const selected = anchors.filter(x => targetNumbers.includes(x.sceneNumber));
  const best = new Map();
  let lastScan = null;
  const maxSteps = 70;

  for (let step = 0; step <= maxSteps; step++) {
    const scan = await page.evaluate((inputs) => {
      const normalize = v => String(v ?? '').replace(/\s+/g,' ').trim().toLowerCase();
      const textOf = el => String(el?.innerText || el?.textContent || '').replace(/\s+/g,' ').trim();
      const bubbles = Array.from(document.querySelectorAll('flow-chat-bubble'));
      const targets = inputs.map(input => {
        if (!input.anchor) return { sceneNumber: input.sceneNumber, promptFound: false, galleryFound: false, permissionFound: false, reason: 'no_prompt_anchor' };
        const a = input.anchor;
        const matchesTarget = text => {
          const txt = normalize(text);
          if (!txt.includes(normalize(a.prefix)) || !txt.includes(normalize(a.backgroundTag))) return false;
          const d = normalize(a.dialogue);
          const action = normalize(a.actionSnippet);
          if (d && txt.includes(d)) return true;
          return Boolean(action && action.length >= 20 && txt.includes(action));
        };
        const bubbleText = b => (b.innerText || b.textContent || '');
        let targetIndex = -1;
        for (let i=0; i<bubbles.length; i++) if (matchesTarget(bubbleText(bubbles[i]))) targetIndex = i;
        const isScenePrompt = txt => normalize(txt).includes(normalize(a.prefix));
        let nextPromptIndex = bubbles.length;
        if (targetIndex >= 0) {
          for (let i=targetIndex+1; i<bubbles.length; i++) {
            const t = bubbleText(bubbles[i]);
            if (isScenePrompt(t) && !matchesTarget(t)) { nextPromptIndex = i; break; }
          }
        }
        const bubbleIndexForNode = node => {
          for (let i=bubbles.length-1; i>=0; i--) if (bubbles[i] === node || bubbles[i].contains(node)) return i;
          return -1;
        };
        const targetBubble = targetIndex >= 0 ? bubbles[targetIndex] : null;
        const nextBubble = nextPromptIndex < bubbles.length ? bubbles[nextPromptIndex] : null;
        const inSceneSegment = node => {
          const idx = bubbleIndexForNode(node);
          const inBubbleSegment = idx >= targetIndex && idx < nextPromptIndex && targetIndex >= 0;
          const inDomSegment = idx < 0 && Boolean(targetBubble) &&
            (targetBubble.contains(node) || Boolean(targetBubble.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) &&
            (!nextBubble || nextBubble.contains(node) || Boolean(node.compareDocumentPosition(nextBubble) & Node.DOCUMENT_POSITION_FOLLOWING));
          return inBubbleSegment || inDomSegment;
        };
        const permissionNodes = Array.from(document.querySelectorAll('flow-permission-message'));
        const permission = permissionNodes.find(node => inSceneSegment(node) && /would you like me to kick off/i.test(textOf(node)) && /costing\s+\d[\d,]*\s+credits?/i.test(textOf(node)));
        const multi = Array.from(document.querySelectorAll('flow-a2ui-multiple-choice')).filter(node => node.querySelector('flow-a2ui-video-option img.video-thumbnail'));
        const optionNodes = Array.from(document.querySelectorAll('flow-a2ui-video-option')).filter(node => node.querySelector('img.video-thumbnail'));
        const hosts = [...new Set([...multi, ...optionNodes.map(n => n.closest('flow-a2ui-multiple-choice') || n)])];
        const gallery = hosts.find(node => inSceneSegment(node));
        const thumbs = gallery ? Array.from(gallery.querySelectorAll('flow-a2ui-video-option img.video-thumbnail')) : [];
        const allGalleryHostsInRange = hosts.filter(node => inSceneSegment(node)).length;
        const body = normalize(document.body?.innerText ?? '');
        const url = location.href;
        return {
          sceneNumber: input.sceneNumber,
          promptFound: targetIndex >= 0,
          promptIndex: targetIndex,
          bubbleCount: bubbles.length,
          permissionFound: Boolean(permission),
          approvalTextMentionsCredits: Boolean(permission),
          galleryFound: Boolean(gallery),
          galleryCountInSceneSegment: allGalleryHostsInRange,
          optionCount: thumbs.length,
          thumbnailLabels: thumbs.slice(0,12).map(img => String(img.getAttribute('alt') || img.getAttribute('title') || img.closest('flow-a2ui-video-option')?.getAttribute('aria-label') || '').slice(0,100)),
          bodyHasSomethingWentWrong: body.includes('something went wrong'),
          url,
        };
      });
      const all = Array.from(document.querySelectorAll('*'));
      const root = document.scrollingElement;
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
        for (let k=0; !reverse && parent && k<3; k++, parent=parent.parentElement) reverse = getComputedStyle(parent).flexDirection === 'column-reverse';
        candidates.push({ el, bubbleCount: el.querySelectorAll('flow-chat-bubble').length, range, reverse });
      }
      candidates.sort((a,b) => b.bubbleCount-a.bubbleCount || b.range-a.range);
      let didScroll = false;
      let scrollInfo = null;
      for (const c of candidates) {
        const before = c.el.scrollTop;
        const delta = Math.max(320, Math.floor(c.el.clientHeight * 0.72));
        const next = c.reverse ? Math.max(-c.range, before-delta) : (before > 2 ? Math.max(0,before-delta) : before);
        if (next !== before) {
          c.el.scrollTop = next;
          didScroll = true;
          scrollInfo = { before, after: c.el.scrollTop, range: c.range, bubbleCount: c.bubbleCount, reverse: c.reverse };
          break;
        }
      }
      return { targets, didScroll, scrollInfo, bubbleCount: bubbles.length, url: location.href, title: document.title,
        loginOrVerificationLikely: /accounts\.google\.com|signin|sign-in|challenge/i.test(location.href) || /sign in to continue|verify it.s you/i.test(normalize(document.body?.innerText ?? '')) };
    }, anchors);
    lastScan = scan;
    ui.scrollSteps = step;
    ui.url = scan.url;
    ui.title = scan.title;
    ui.loginOrVerificationLikely = scan.loginOrVerificationLikely;
    for (const r of scan.targets) {
      const prev = best.get(r.sceneNumber);
      if (!prev || (!prev.galleryFound && r.galleryFound) || (!prev.promptFound && r.promptFound)) best.set(r.sceneNumber, r);
    }
    const allTargetGalleriesFound = selected.length > 0 && selected.every(x => best.get(x.sceneNumber)?.galleryFound);
    if (allTargetGalleriesFound || !scan.didScroll) break;
    await page.waitForTimeout(450);
  }

  for (const s of targetNumbers) {
    const scene = scenes.find(x => Number(x.scene_number) === s);
    const result = best.get(s);
    ui.targetScenes[s] = {
      pipelineStatus: scene?.status ?? null,
      phase: scene?.flow_generation?.phase ?? null,
      savedSourceExists: Boolean(scene?.flow_generation?.source),
      uiAssessment: result?.galleryFound ? 'MATCHING_VIDEO_GALLERY_FOUND_IN_FLOW_DOM'
        : result?.promptFound ? 'PROMPT_FOUND_BUT_NO_MATCHING_VIDEO_GALLERY_IN_SCANNED_DOM'
        : result ? 'PROMPT_ANCHOR_UNAVAILABLE' : 'NOT_DETECTED_IN_SCANNED_DOM',
      promptFound: result?.promptFound ?? false,
      galleryFound: result?.galleryFound ?? false,
      permissionFound: result?.permissionFound ?? false,
      approvalTextMentionsCredits: result?.approvalTextMentionsCredits ?? false,
      galleryCountInSceneSegment: result?.galleryCountInSceneSegment ?? 0,
      optionCount: result?.optionCount ?? 0,
      thumbnailLabels: result?.thumbnailLabels ?? [],
      inspectedBubbleCount: result?.bubbleCount ?? lastScan?.bubbleCount ?? 0,
      caveat: result?.galleryFound ? 'Gallery was found associated with this exact scene anchor during the scan.' : 'Not found is not proof that the server has no result; the UI may virtualize or structure this scene differently. No generation was submitted during this diagnostic.',
    };
  }
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
} catch (e) {
  ui.error = String(e?.stack ?? e);
} finally {
  if (context) await context.close().catch(() => {});
}

const duplicateGroups = new Map();
for (const row of sceneRows) {
  if (!row.localMP4.exists) continue;
  if (!duplicateGroups.has(row.localMP4.hash)) duplicateGroups.set(row.localMP4.hash, []);
  duplicateGroups.get(row.localMP4.hash).push(row.sceneNumber);
}
const duplicates = [...duplicateGroups.entries()].filter(([,nums])=>nums.length>1).map(([hash,sceneNumbers])=>({hash,sceneNumbers}));
const report = {
  generatedAt: new Date().toISOString(),
  safety: 'READ-ONLY diagnostic: this script does not click buttons, approve credits, submit prompts, or generate media. It only reads pipeline/local files and inspects the Flow DOM while scrolling existing chat history.',
  pipelinePath,
  outputDir: path.join(root, 'production', 'outputs', path.basename(path.dirname(pipelinePath))),
  characters: characterRows,
  backgrounds: backgroundRows,
  scenes: sceneRows,
  localDuplicateGroups: duplicates,
  ui,
  screenshotPath,
};
await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
console.log('\nREAD-ONLY SCENE AVAILABILITY CHECK COMPLETE');
console.log('No buttons clicked. No prompts submitted. No credits spent by this script.');
console.log(`Pipeline scenes: ${sceneRows.length}; characters: ${characterRows.length}; backgrounds: ${backgroundRows.length}`);
console.log(`Local MP4 files: ${sceneRows.filter(s=>s.localMP4.exists).length}; byte-identical duplicate groups: ${duplicates.length}`);
for (const n of targetNumbers) {
  const r = ui.targetScenes[n];
  console.log(`Scene ${String(n).padStart(2,'0')}: ${r?.uiAssessment ?? 'NOT_CHECKED'}; localMP4=${sceneRows.find(s=>s.sceneNumber===n)?.localMP4.exists ?? false}; duplicateOf=${sceneRows.find(s=>s.sceneNumber===n)?.localMP4.duplicateOf ?? 'none'}`);
}
if (ui.loginOrVerificationLikely) console.log('WARNING: Flow may be showing sign-in/verification. The UI scan cannot confirm scene galleries until that is completed.');
if (ui.error) console.log(`UI inspection error: ${ui.error}`);
console.log(`JSON report: ${reportPath}`);
console.log(`Screenshot: ${screenshotPath}`);
