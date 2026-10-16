import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const root = process.cwd();
const profile = path.resolve(arg('--profile', path.join(root, 'production', '.chrome-profile')));
const url = arg('--url', 'https://aistudio.google.com/generate-speech');
const manifestFile = path.resolve(arg('--manifest', path.join(root, 'production', 'outputs', 'youtube-automation-20261015093729601', 'narration-manifest.repaired-candidate.json')));
const sceneNumber = Number(arg('--scene', '3'));
const outDir = path.resolve(arg('--out', path.join(root, 'production', 'outputs', 'flow-recovery-diagnostics')));
await fs.mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(outDir, `ai-studio-history-inspection-v30-${stamp}.json`);
const screenshotPath = path.join(outDir, `ai-studio-history-inspection-v30-${stamp}.png`);

let sceneText = '';
try {
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  sceneText = String((manifest.scenes || []).find(s => Number(s.scene_number) === sceneNumber)?.text || '');
} catch (error) {
  console.warn(`Could not read optional manifest ${manifestFile}: ${String(error)}`);
}
const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
const snippet = sceneText.slice(0, 48);

console.log('READ-ONLY AI STUDIO HISTORY INSPECTION v30');
console.log('Allowed UI action: click the History navigation item only.');
console.log('No prompt entered. No Run/generate buttons clicked. No downloads started. No files or pipeline data modified.');
console.log(`Profile: ${profile}`);
console.log(`Target scene: ${sceneNumber}`);
console.log(`Manifest used only for comparison: ${manifestFile}`);

let context;
try {
  context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', // Use installed Google Chrome to match the profile's newer browser version.
  headless: false,
  acceptDownloads: true,
  viewport: null,
  args: ['--no-first-run', '--disable-blink-features=AutomationControlled']
  });
} catch (error) {
  console.error('Could not launch installed Google Chrome with the automation profile.');
  console.error('The profile may still be open elsewhere. Close only Chrome windows using this project profile, then retry.');
  console.error('This inspector did not navigate to History and did not generate or download anything.');
  console.error(String(error));
  process.exit(2);
}
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  const initial = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    bodyText: (document.body?.innerText || '').slice(0, 7000)
  }));

  // Inspect candidates first. We click only if a single visible, interactive target
  // has the exact History label (allowing for a duplicated Material icon ligature).
  const candidateInfo = await page.locator('a,button,[role="button"],[role="menuitem"]').evaluateAll(elements => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const clean = el => (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    return elements.map((el, index) => {
      const text = clean(el);
      const aria = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const r = el.getBoundingClientRect();
      const accessible = `${aria} ${title}`.trim();
      const exact = /^(?:history\s*)?history$/i.test(text) || /^history$/i.test(accessible);
      return { index, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', text, aria, title, href: el.getAttribute('href') || '', visible: visible(el), exactHistory: exact, area: Math.round(r.width * r.height), outerHTML: el.outerHTML.slice(0, 500) };
    });
  });
  const eligible = candidateInfo.filter(item => item.visible && item.exactHistory);
  let historyClick = { attempted: false, clicked: false, message: '' };
  if (eligible.length === 1) {
    historyClick.attempted = true;
    const selectedIndex = eligible[0].index;
    try {
      await page.locator('a,button,[role="button"],[role="menuitem"]').nth(selectedIndex).click({ timeout: 8000 });
      historyClick.clicked = true;
      historyClick.message = `Clicked History navigation only: ${eligible[0].tag} text=${eligible[0].text}`;
      await page.waitForTimeout(5000);
    } catch (error) {
      historyClick.message = `History target was identified but click failed: ${String(error)}`;
    }
  } else {
    historyClick.message = `Did not click: found ${eligible.length} visible exact History navigation candidates; safety rule requires exactly one.`;
  }

  const dom = await page.evaluate(({ targetScene, sceneSnippet }) => {
    const isVisible = el => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const summarize = el => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
        text: (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 260),
        aria: el.getAttribute('aria-label') || '', title: el.getAttribute('title') || '',
        href: el.getAttribute('href') || '', disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        visible: isVisible(el), width: Math.round(r.width), height: Math.round(r.height),
        outerHTML: el.outerHTML.slice(0, 500)
      };
    };
    const bodyText = document.body?.innerText || '';
    const interactive = [...document.querySelectorAll('a,button,[role="button"],[role="menuitem"],mat-card')]
      .filter(isVisible).map(summarize).slice(0, 180);
    const audio = [...document.querySelectorAll('audio,video')].map(summarize);
    const links = [...document.querySelectorAll('a[href]')].filter(isVisible).map(summarize).slice(0, 100);
    return {
      url: location.href, title: document.title,
      bodyText: bodyText.slice(0, 16000),
      sceneSnippetVisible: Boolean(sceneSnippet && bodyText.includes(sceneSnippet)),
      sceneSnippet: sceneSnippet,
      targetScene: targetScene,
      counts: {
        visibleInteractive: interactive.length,
        visibleLinks: links.length,
        audioVideo: document.querySelectorAll('audio,video').length,
        downloadControls: [...document.querySelectorAll('a,button,[role="button"]')].filter(el => isVisible(el) && /download|export/i.test(`${el.innerText || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`)).length
      },
      interactive, audio, links
    };
  }, { targetScene: sceneNumber, sceneSnippet: snippet });

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  const report = {
    createdAt: new Date().toISOString(),
    readOnly: true,
    initial,
    historyCandidates: candidateInfo.filter(item => item.visible && /history/i.test(`${item.text} ${item.aria} ${item.title}`)).slice(0, 40),
    historyClick,
    resultPage: dom,
    screenshotPath,
    note: 'A missing scene-text match does not prove no result exists; some history views show only conversation titles or omit prompt contents.'
  };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\nHISTORY INSPECTION COMPLETE');
  console.log(`Initial page: ${initial.url} | ${initial.title}`);
  console.log(`History candidates: ${JSON.stringify(report.historyCandidates)}`);
  console.log(`History click: ${JSON.stringify(historyClick)}`);
  console.log(`Final page: ${dom.url} | ${dom.title}`);
  console.log(`Counts: ${JSON.stringify(dom.counts)}`);
  console.log(`Scene ${sceneNumber} text snippet visible in page: ${dom.sceneSnippetVisible}`);
  console.log('\nVisible links/buttons (first 80):');
  for (const item of dom.interactive.filter(x => x.visible).slice(0, 80)) {
    console.log(`- <${item.tag}> role=${item.role} text=${item.text} aria=${item.aria} title=${item.title} href=${item.href} disabled=${item.disabled}`);
  }
  console.log('\nPage text excerpt:');
  console.log(dom.bodyText.slice(0, 8000));
  console.log(`\nJSON report: ${reportPath}`);
  console.log(`Screenshot: ${screenshotPath}`);
  console.log('No generation performed. No download initiated.');
} finally {
  await context.close();
}
