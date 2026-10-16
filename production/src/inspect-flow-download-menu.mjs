import fs from 'node:fs/promises';
import path from 'node:path';
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
const diagnosticsDir = path.join(root, 'production', 'outputs', 'flow-recovery-diagnostics');
const fingerprints = {
  2: 'driver bholaram, holding the steering wheel, turns his head toward radhika',
  3: 'a sudden gust of wind swirls through the area by the third seat',
  10: "close-up on the driver bholaram's face; a strange, subtle glint appears in his eyes",
  12: 'the bus slowly drives away down the road, eventually disappearing into a thickening mist',
};
if (!fingerprints[sceneNumber]) throw new Error('Use --scene 2, 3, 10, or 12.');

const normalize = v => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const stamp = () => new Date().toISOString().replaceAll(':', '-');
const sanitizeUrl = input => {
  try { const u = new URL(input); return `${u.origin}${u.pathname}${u.search ? '?[query-redacted]' : ''}${u.hash ? '#[fragment-redacted]' : ''}`; }
  catch { return String(input ?? '').slice(0, 300); }
};
const isProjectChatUrl = (value, projectId) => {
  try { const u = new URL(value); return u.hostname === 'flow.google.com' && /^\/project\/[^/]+\/?$/.test(u.pathname) && (!projectId || u.pathname.includes(`/project/${projectId}`)); }
  catch { return false; }
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

async function inspectDownloadMenu(page) {
  return page.evaluate(() => {
    const visible = el => {
      const s = getComputedStyle(el);
      return Boolean(el.getClientRects().length) && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const text = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    const attrs = el => {
      const out = {};
      for (const name of ['aria-label','title','role','data-testid','download','type','href','name','id','class','disabled']) {
        if (el.hasAttribute(name)) out[name] = el.getAttribute(name);
      }
      return out;
    };
    const menuSelectors = [
      '[role="menu"]', '[role="menuitem"]', '[role="option"]',
      'mat-menu', '.mat-mdc-menu-panel', '.mat-mdc-menu-item',
      'button[role="menuitem"]', 'a[role="menuitem"]',
      '[role="listbox"]', '.cdk-overlay-pane', '.mat-mdc-dialog-container'
    ].join(',');
    const menuNodes = Array.from(document.querySelectorAll(menuSelectors)).filter(visible).slice(0, 120).map((el, index) => ({
      index, tag: el.tagName.toLowerCase(), text: text(el), attrs: attrs(el),
      outerHtml: el.outerHTML.slice(0, 1800)
    }));
    const menuItems = Array.from(document.querySelectorAll('[role="menuitem"],button.mat-mdc-menu-item,a.mat-mdc-menu-item,[role="option"]'))
      .filter(visible).map((el, index) => ({ index, tag: el.tagName.toLowerCase(), text: text(el), attrs: attrs(el) })).slice(0, 100);
    const relevantControls = Array.from(document.querySelectorAll('button,[role="button"],a,input'))
      .filter(visible).map((el, index) => ({ index, tag: el.tagName.toLowerCase(), text: text(el), attrs: attrs(el) }))
      .filter(x => /download|save|export|video|media|file|mp4|quality|resolution/i.test([x.text, ...Object.values(x.attrs)].join(' '))).slice(0, 100);
    return {
      capturedAt: new Date().toISOString(), url: location.href, title: document.title,
      bodyText: (document.body?.innerText || '').slice(0, 12000),
      counts: { menus: document.querySelectorAll('[role="menu"],mat-menu,.mat-mdc-menu-panel,.cdk-overlay-pane').length, menuItems: menuItems.length },
      menuNodes, menuItems, relevantControls,
      menuText: menuNodes.map(n => n.text).filter(Boolean).join('\n--- MENU NODE ---\n').slice(0, 10000),
    };
  });
}

const pipeline = JSON.parse(await fs.readFile(pipelinePath, 'utf8'));
const flowUrl = String(pipeline.flow_project_url ?? pipeline.project_url ?? 'https://flow.google.com/project/ca1b2a2a-1840-4580-9198-92b97a5aedb7');
const projectId = new URL(flowUrl).pathname.match(/^\/project\/([^/]+)/)?.[1];
await fs.mkdir(diagnosticsDir, { recursive: true });
const ts = stamp();
const reportPath = path.join(diagnosticsDir, `flow-download-menu-scene-${sceneNumber}-${ts}.json`);
const screenshotPath = path.join(diagnosticsDir, `flow-download-menu-scene-${sceneNumber}-${ts}.png`);
const report = {
  createdAt: new Date().toISOString(), sceneNumber, mode: 'inspect existing editor download menu only',
  safety: 'Opens a uniquely matching existing video card, then clicks only the Download media menu trigger. It does NOT click any menu item, initiate a download, submit prompts, click Generate, Approve, Always approve, or Reject, or modify pipeline/files. Query strings are redacted.',
  flowUrl: sanitizeUrl(flowUrl), pipelinePath, reportPath, screenshotPath,
};
let context;
try {
  context = await chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: false, acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  const pages = context.pages();
  let page = pages.find(p => isProjectChatUrl(p.url(), projectId)) ?? pages[0];
  if (!page) page = await context.newPage();
  if (!isProjectChatUrl(page.url(), projectId)) await page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('body').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForTimeout(3500);
  if (!isProjectChatUrl(page.url(), projectId)) throw new Error(`Expected project chat URL but found ${sanitizeUrl(page.url())}`);

  console.log(`Finding the existing Scene ${sceneNumber} card; no new generation will be requested.`);
  const found = await findCard(page);
  report.cardSearch = found;
  if (found.missing) throw new Error(`No uniquely matched existing card found for Scene ${sceneNumber}; no controls were clicked.`);
  if (found.ambiguous) throw new Error(`Multiple existing cards match Scene ${sceneNumber}; refusing to choose.`);
  if (!found.card.hasOpenEditor) throw new Error(`Matching card has no exact Open video in editor control.`);
  report.matchedCard = { domIndex: found.card.index, description: found.card.alt.slice(0, 1200) };
  const open = page.locator('flow-a2ui-video-option').nth(found.card.index).locator('[role="button"][aria-label="Open video in editor"]');
  if (await open.count() !== 1 || !await open.isVisible().catch(() => false) || !await open.isEnabled().catch(() => false)) throw new Error('Existing card editor control was not uniquely visible/enabled.');
  await open.click({ timeout: 8000 });
  try { await page.waitForURL(url => isEditorUrl(String(url)), { timeout: 20000 }); }
  catch { throw new Error(`Existing card did not navigate to editor. Current URL: ${sanitizeUrl(page.url())}`); }
  report.editorUrl = sanitizeUrl(page.url());
  await page.waitForTimeout(5000);

  const downloadButton = page.locator('button[aria-label="Download media"]');
  const count = await downloadButton.count();
  report.downloadMenuTriggerCount = count;
  if (count !== 1 || !await downloadButton.isVisible().catch(() => false) || !await downloadButton.isEnabled().catch(() => false)) {
    report.beforeMenu = await inspectDownloadMenu(page);
    throw new Error(`Expected exactly one visible/enabled Download media menu trigger; count=${count}. It was not clicked.`);
  }

  // This control is a menu trigger in Flow's DOM, not a download item.
  await downloadButton.click({ timeout: 8000 });
  await page.waitForTimeout(900);
  report.downloadMenu = await inspectDownloadMenu(page);
  await page.screenshot({ path: screenshotPath, fullPage: false }).catch(e => { report.screenshotError = String(e); });
  console.log(`Download menu inspected for Scene ${sceneNumber}.`);
  console.log(`Visible menu nodes: ${report.downloadMenu.counts.menus}; selectable menu items: ${report.downloadMenu.counts.menuItems}`);
  console.log(`Menu items (no item was selected):`);
  for (const item of report.downloadMenu.menuItems) console.log(`- ${item.text || item.attrs['aria-label'] || item.attrs.title || '(unnamed)'} [${item.tag}]`);
  console.log(`Report: ${reportPath}`);
  console.log(`Screenshot: ${screenshotPath}`);
  console.log('No download-menu item was selected. No prompt submitted. No credits approved or spent by this script.');
} catch (error) {
  report.error = String(error?.stack ?? error);
  console.error(String(error?.message ?? error));
} finally {
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8').catch(() => {});
  if (context) await context.close().catch(() => {});
}
console.log(`Report: ${reportPath}`);
if (report.error) process.exitCode = 1;
