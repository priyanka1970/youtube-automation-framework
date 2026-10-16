import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

// Read-only diagnostic: switches only between Flow's Characters and Videos library filters.
// It never clicks Approve, Always approve, Generate, or submits a prompt.
const projectRoot = process.cwd();
const productionDir = path.resolve(projectRoot, 'production');
const profileDir = path.join(productionDir, '.chrome-profile');
const flowUrl = 'https://flow.google.com/project/ca1b2a2a-1840-4580-9198-92b97a5aedb7';
const outputDir = path.join(productionDir, 'outputs', 'flow-diagnostics');
await fs.mkdir(outputDir, { recursive: true });

const selector = 'button,[role="button"],[role="tab"],a';

async function clickLibraryFilter(page, label) {
  const found = await page.evaluate(({ selector, label }) => {
    const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
    const visible = el => {
      const st = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || 1) > 0 && r.width > 0 && r.height > 0;
    };
    const all = Array.from(document.querySelectorAll(selector));
    const candidates = [];
    all.forEach((el, index) => {
      if (!visible(el)) return;
      const text = clean(el.innerText || el.textContent);
      const aria = clean(el.getAttribute('aria-label'));
      const title = clean(el.getAttribute('title'));
      const vals = [text, aria, title].filter(Boolean);
      const exact = vals.some(v => v.toLowerCase() === label.toLowerCase());
      const suffix = vals.some(v => new RegExp('(?:^|\\s)' + label + '$', 'i').test(v));
      if (!exact && !suffix) return;
      // Prefer an exact, short label; avoid large parent buttons/containers.
      const best = vals.sort((a, b) => a.length - b.length)[0] || '';
      candidates.push({ index, text, aria, title, best, score: (exact ? 0 : 100) + best.length });
    });
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0] ?? null;
  }, { selector, label });

  if (!found) {
    return { clicked: false, label, reason: `No visible ${label} filter/control matched safely.` };
  }
  try {
    await page.locator(selector).nth(found.index).click({ timeout: 4000 });
    await page.waitForTimeout(3500);
    return { clicked: true, label, matchedControl: found };
  } catch (error) {
    return { clicked: false, label, matchedControl: found, reason: String(error?.message ?? error).slice(0, 400) };
  }
}

async function capture(page, section) {
  return await page.evaluate((section) => {
    const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
    const visible = el => {
      const st = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || 1) > 0 && r.width > 0 && r.height > 0;
    };
    const bodyText = document.body?.innerText ?? '';
    const searchRE = /radhika|bholaram|savita|char-01-radhika|char-02-bholaram|queued|something went wrong|scene-0001|video|character reference/i;
    const relevantNodes = [];
    const seen = new Set();
    for (const el of Array.from(document.querySelectorAll('img,button,[role="button"],[role="listitem"],article,[data-testid],[class*="card"],[class*="tile"],[class*="asset"],[aria-label],[title]'))) {
      if (!visible(el)) continue;
      const own = clean(el.innerText || el.textContent);
      const accessible = clean([el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('alt')].filter(Boolean).join(' '));
      const combined = clean(`${own} ${accessible}`);
      if (!combined || combined.length > 1400 || !searchRE.test(combined)) continue;
      const signature = `${el.tagName}|${combined.slice(0, 280)}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      const ancestors = [];
      let p = el.parentElement;
      for (let i = 0; p && i < 3; i++, p = p.parentElement) {
        const t = clean(p.innerText || p.textContent);
        ancestors.push({ tag: p.tagName.toLowerCase(), role: p.getAttribute('role'), className: String(p.className || '').slice(0, 120), text: t.slice(0, 400) });
      }
      relevantNodes.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
        title: el.getAttribute('title'),
        alt: el.getAttribute('alt'),
        className: String(el.className || '').slice(0, 140),
        text: own.slice(0, 900),
        accessibleText: accessible.slice(0, 300),
        ancestors
      });
      if (relevantNodes.length >= 70) break;
    }
    const controls = Array.from(document.querySelectorAll('button,[role="button"],[role="tab"],a'))
      .filter(visible)
      .map(el => ({
        text: clean(el.innerText || el.textContent).slice(0, 120),
        ariaLabel: clean(el.getAttribute('aria-label')),
        title: clean(el.getAttribute('title')),
        role: el.getAttribute('role'),
        disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true'
      }))
      .filter(x => x.text || x.ariaLabel || x.title)
      .slice(0, 90);
    const terms = ['CHAR-01-RADHIKA', 'CHAR-02-BHOLARAM', 'Radhika', 'Bholaram', 'Queued', 'Something went wrong'];
    const snippets = {};
    for (const term of terms) {
      const lower = bodyText.toLowerCase();
      const index = lower.lastIndexOf(term.toLowerCase());
      if (index >= 0) snippets[term] = clean(bodyText.slice(Math.max(0, index - 140), Math.min(bodyText.length, index + term.length + 300)));
    }
    return {
      section,
      sampledAt: new Date().toISOString(),
      url: location.href,
      title: document.title,
      bodyTextLength: bodyText.length,
      tailText: bodyText.slice(-5000),
      snippets,
      relevantNodes,
      controls
    };
  }, section);
}

let context;
try {
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome', headless: false, acceptDownloads: true,
    viewport: { width: 1440, height: 1000 }
  });
  const pages = context.pages();
  const page = pages.find(p => p.url().includes('/project/ca1b2a2a-1840-4580-9198-92b97a5aedb7')) ?? pages[0] ?? await context.newPage();
  if (!page.url().includes('/project/ca1b2a2a-1840-4580-9198-92b97a5aedb7')) {
    await page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await page.locator('body').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForTimeout(6000);

  const results = [];
  const charactersNav = await clickLibraryFilter(page, 'Characters');
  results.push({ navigation: charactersNav, capture: await capture(page, 'Characters') });

  const videosNav = await clickLibraryFilter(page, 'Videos');
  results.push({ navigation: videosNav, capture: await capture(page, 'Videos') });

  const stamp = new Date().toISOString().replaceAll(':', '-');
  const reportPath = path.join(outputDir, `flow-assets-check-${stamp}.json`);
  const screenshotPath = path.join(outputDir, `flow-assets-check-${stamp}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  const report = {
    readOnly: true,
    warning: 'This script only switches between the Characters and Videos library filters. It does not approve, generate, delete, or submit anything.',
    projectUrl: flowUrl,
    profileDir,
    createdAt: new Date().toISOString(),
    results
  };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n=== FLOW ASSET CHECK COMPLETE (READ ONLY) ===');
  console.log(`Report: ${reportPath}`);
  console.log(`Screenshot (final Videos view): ${screenshotPath}`);
  for (const item of results) {
    console.log(`\n=== ${item.capture.section.toUpperCase()} ===`);
    console.log(`Navigation clicked: ${item.navigation.clicked}`);
    if (item.navigation.reason) console.log(`Navigation note: ${item.navigation.reason}`);
    console.log(`URL: ${item.capture.url}`);
    console.log('Latest keyword snippets:');
    console.log(JSON.stringify(item.capture.snippets, null, 2));
    console.log('Relevant visible UI elements:');
    for (const n of item.capture.relevantNodes.filter(n => /radhika|bholaram|savita|char-01-radhika|char-02-bholaram|queued|something went wrong|scene-0001/i.test(`${n.text} ${n.accessibleText} ${n.title} ${n.alt}`)).slice(0, 18)) {
      console.log(`- <${n.tag}> ${n.text || n.accessibleText || n.alt || n.title}`.slice(0, 260));
      if (n.ancestors?.[0]?.text) console.log(`  parent: ${n.ancestors[0].text.slice(0, 220)}`);
    }
  }
  console.log('\nUpload the JSON report if asset presence/status is still ambiguous.');
} catch (error) {
  console.error('\nFlow asset check did not complete. No generation was intentionally started.');
  console.error(error?.stack ?? String(error));
  console.error('\nIf Chrome reports the profile is already in use, close the Chrome window opened with production\\.chrome-profile and rerun.');
  process.exitCode = 1;
} finally {
  if (context) await context.close().catch(() => {});
}
