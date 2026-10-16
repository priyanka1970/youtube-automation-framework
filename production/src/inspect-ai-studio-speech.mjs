import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const repo = process.cwd();
const project = path.resolve(repo, arg('--project', 'scripting/projects/youtube-automation-20261015093729601/pipeline.json'));
const profile = path.resolve(repo, arg('--profile', 'production/.chrome-profile'));
const url = arg('--url', process.env.AI_STUDIO_SPEECH_URL || 'https://aistudio.google.com/generate-speech');
const outDir = path.resolve(repo, 'production/outputs/flow-recovery-diagnostics');

if (!(await exists(project))) throw new Error(`Pipeline not found: ${project}`);
if (!(await exists(profile))) throw new Error(`Chrome profile not found: ${profile}`);

await fs.mkdir(outDir, { recursive: true });
console.log('READ-ONLY AI STUDIO SPEECH UI INSPECTION');
console.log('No buttons clicked. No text entered. No prompts submitted. No audio generated.');
console.log(`Profile: ${profile}`);
console.log(`URL: ${url}`);

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  acceptDownloads: true,
  viewport: null,
  args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
});

try {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);

  const snapshot = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
    };
    const describe = (el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 260),
      ariaLabel: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      placeholder: el.getAttribute('placeholder'),
      name: el.getAttribute('name'),
      type: el.getAttribute('type'),
      disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      visible: visible(el),
      contenteditable: el.getAttribute('contenteditable'),
      className: typeof el.className === 'string' ? el.className.slice(0, 180) : '',
      outerHTML: el.outerHTML.slice(0, 900),
    });
    const selectorSets = {
      inputs: [...document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]')],
      buttons: [...document.querySelectorAll('button, [role="button"], [role="radio"], [role="option"], mat-button, [role="tab"]')],
      audio: [...document.querySelectorAll('audio')],
      downloadLinks: [...document.querySelectorAll('a[download], a[href]')].filter(el => /download|audio|wav|mp3|speech/i.test(`${el.innerText} ${el.getAttribute('aria-label')} ${el.getAttribute('href')}`)),
    };
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      bodyText: (document.body?.innerText || '').slice(0, 12000),
      counts: Object.fromEntries(Object.entries(selectorSets).map(([k, v]) => [k, v.length])),
      selectors: Object.fromEntries(Object.entries(selectorSets).map(([k, v]) => [k, v.slice(0, 100).map(describe)])),
      currentSelectorCheck: {
        textboxes: document.querySelectorAll('[role="textbox"], textarea, [contenteditable="true"]').length,
        inputPlaceholders: [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].map(el => ({
          tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), placeholder: el.getAttribute('placeholder'), ariaLabel: el.getAttribute('aria-label'),
          visible: visible(el)
        })).slice(0, 40),
        audioSourceCount: document.querySelectorAll('audio').length,
        runLikeButtons: [...document.querySelectorAll('button,[role="button"]')].filter(el => /^(run|generate( speech| audio)?|create audio)$/i.test((el.innerText || el.getAttribute('aria-label') || '').trim())).map(el => describe(el, -1)),
      }
    };
  });

  const stamp = new Date().toISOString().replace(/:/g, '-');
  const report = path.join(outDir, `ai-studio-speech-ui-${stamp}.json`);
  const screenshot = path.join(outDir, `ai-studio-speech-ui-${stamp}.png`);
  await fs.writeFile(report, JSON.stringify({ createdAt: new Date().toISOString(), safety: 'Read-only: no buttons clicked, no text entered, no prompts submitted, and no audio generated.', project, profile, requestedUrl: url, page: snapshot, screenshotPath: screenshot }, null, 2), 'utf8');
  await page.screenshot({ path: screenshot, fullPage: false }).catch(() => {});

  console.log('\nINSPECTION COMPLETE');
  console.log(`Actual URL: ${snapshot.url}`);
  console.log(`Title: ${snapshot.title}`);
  console.log('Element counts:', JSON.stringify(snapshot.counts));
  console.log('\nVisible text inputs/editors:');
  for (const x of snapshot.selectors.inputs.filter(x => x.visible)) {
    console.log(`- <${x.tag}> role=${x.role || ''} label=${x.ariaLabel || ''} placeholder=${x.placeholder || ''} text=${x.text.slice(0, 100)}`);
  }
  console.log('\nVisible buttons (first 70):');
  for (const x of snapshot.selectors.buttons.filter(x => x.visible).slice(0, 70)) {
    console.log(`- <${x.tag}> role=${x.role || ''} text=${x.text || ''} aria=${x.ariaLabel || ''} title=${x.title || ''} disabled=${x.disabled}`);
  }
  console.log('\nBody text excerpt:');
  console.log(snapshot.bodyText.slice(0, 5000));
  console.log(`\nJSON report: ${report}`);
  console.log(`Screenshot: ${screenshot}`);
  console.log('No prompts submitted. No audio generated.');
} finally {
  await context.close();
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
