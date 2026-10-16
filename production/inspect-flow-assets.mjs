import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

// Read-only Flow diagnostic. It may open the existing project's asset picker,
// but never selects an asset or clicks Generate/Approve/Always approve.
const projectRoot = process.cwd();
const productionDir = path.resolve(projectRoot, 'production');
const profileDir = path.join(productionDir, '.chrome-profile');
const flowUrl = 'https://flow.google.com/project/ca1b2a2a-1840-4580-9198-92b97a5aedb7';
const projectPath = new URL(flowUrl).pathname.replace(/\/$/, '');
const outputDir = path.join(productionDir, 'outputs', 'flow-diagnostics');
await fs.mkdir(outputDir, { recursive: true });
const controlSelector = 'button,[role="button"],[role="tab"],a';

async function navigateToProjectRoot(page, label) {
  const current = (() => { try { return new URL(page.url()).pathname.replace(/\/$/, ''); } catch { return ''; } })();
  if (current !== projectPath) {
    await page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('body').waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForTimeout(4500);
    return { label, navigated: true, from: current, to: projectPath };
  }
  return { label, navigated: false, from: current, to: projectPath };
}

async function clickControl(page, label) {
  const found = await page.evaluate(({ selector, label }) => {
    const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
    const visible = el => {
      const st = getComputedStyle(el), r = el.getBoundingClientRect();
      return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || 1) > 0 && r.width > 0 && r.height > 0;
    };
    const all = Array.from(document.querySelectorAll(selector));
    const candidates = [];
    all.forEach((el, index) => {
      if (!visible(el)) return;
      const vals = [clean(el.innerText || el.textContent), clean(el.getAttribute('aria-label')), clean(el.getAttribute('title'))].filter(Boolean);
      const exact = vals.some(v => v.toLowerCase() === label.toLowerCase());
      const suffix = vals.some(v => new RegExp('(?:^|\\s)' + label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '$', 'i').test(v));
      if (!exact && !suffix) return;
      const best = vals.sort((a,b) => a.length-b.length)[0] || '';
      candidates.push({ index, text: vals[0] || '', ariaLabel: clean(el.getAttribute('aria-label')), title: clean(el.getAttribute('title')), exact, best, score: (exact ? 0 : 100) + best.length });
    });
    candidates.sort((a,b) => a.score-b.score);
    return candidates[0] ?? null;
  }, { selector: controlSelector, label });

  if (!found) return { clicked: false, label, reason: `No visible control matched ${label}.` };
  try {
    await page.locator(controlSelector).nth(found.index).click({ timeout: 5000 });
    await page.waitForTimeout(3000);
    return { clicked: true, label, matchedControl: found, resultingUrl: page.url() };
  } catch (e) {
    return { clicked: false, label, matchedControl: found, reason: String(e?.message ?? e).slice(0, 400) };
  }
}

async function capture(page, section) {
  return await page.evaluate(({ section, controlSelector }) => {
    const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
    const visible = el => {
      const st = getComputedStyle(el), r = el.getBoundingClientRect();
      return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || 1) > 0 && r.width > 0 && r.height > 0;
    };
    const bodyText = document.body?.innerText ?? '';
    const controls = Array.from(document.querySelectorAll(controlSelector)).filter(visible).map(el => ({
      text: clean(el.innerText || el.textContent).slice(0, 180),
      ariaLabel: clean(el.getAttribute('aria-label')),
      title: clean(el.getAttribute('title')),
      role: el.getAttribute('role'),
      href: el.getAttribute('href'),
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true'
    })).filter(x => x.text || x.ariaLabel || x.title).slice(0, 120);
    const query = /radhika|bholaram|savita|char-01-radhika|char-02-bholaram|queued|something went wrong|scene-0001|video|character reference|add from project/i;
    const elements = [];
    const seen = new Set();
    for (const el of Array.from(document.querySelectorAll('img,button,[role="button"],[role="tab"],[role="listitem"],article,[data-testid],[class*="card"],[class*="tile"],[class*="asset"],[aria-label],[title]'))) {
      if (!visible(el)) continue;
      const text = clean(el.innerText || el.textContent);
      const accessible = clean([el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('alt')].filter(Boolean).join(' '));
      const combined = clean(`${text} ${accessible}`);
      if (!combined || combined.length > 1600 || !query.test(combined)) continue;
      const sig = `${el.tagName}|${combined.slice(0,240)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const parents = [];
      let p = el.parentElement;
      for (let i=0; p && i<3; i++, p=p.parentElement) parents.push({tag:p.tagName.toLowerCase(), role:p.getAttribute('role'), className:String(p.className || '').slice(0,100), text:clean(p.innerText || p.textContent).slice(0,300)});
      elements.push({tag:el.tagName.toLowerCase(), role:el.getAttribute('role'), text:text.slice(0,700), accessibleText:accessible.slice(0,250), href:el.getAttribute('href'), parents});
      if (elements.length >= 80) break;
    }
    const terms = ['CHAR-01-RADHIKA','CHAR-02-BHOLARAM','Radhika','Bholaram','Savita','Queued','Something went wrong','video','Add from project'];
    const snippets = {};
    const lower = bodyText.toLowerCase();
    for (const term of terms) {
      const i = lower.lastIndexOf(term.toLowerCase());
      if (i >= 0) snippets[term] = clean(bodyText.slice(Math.max(0,i-160), Math.min(bodyText.length,i+term.length+350)));
    }
    return { section, sampledAt:new Date().toISOString(), url:location.href, title:document.title, bodyTextLength:bodyText.length, bodyText:bodyText.slice(0,18000), tailText:bodyText.slice(-5000), snippets, controls, elements };
  }, { section, controlSelector });
}

let context;
try {
  context = await chromium.launchPersistentContext(profileDir, { channel:'chrome', headless:false, acceptDownloads:true, viewport:{width:1440,height:1000} });
  const pages = context.pages();
  const page = pages.find(p => { try { return new URL(p.url()).origin === 'https://flow.google.com' && new URL(p.url()).pathname.startsWith(projectPath); } catch { return false; } }) ?? pages[0] ?? await context.newPage();
  await navigateToProjectRoot(page, 'initial project root');
  await page.locator('body').waitFor({ state:'visible', timeout:30000 });
  await page.waitForTimeout(2500);
  const results = [];

  results.push({ navigation:{label:'Project home', clicked:false, note:'Captured the project root before changing views.'}, capture:await capture(page,'Project home') });

  // Check video category from the project root first.
  const toVideosRoot = await navigateToProjectRoot(page, 'reset before Videos');
  const videosNav = await clickControl(page, 'Videos');
  results.push({ navigation:{...videosNav, rootReset:toVideosRoot}, capture:await capture(page,'Videos') });

  // The Characters control may open the character creator. Inspect its existing-project picker without selecting anything.
  await navigateToProjectRoot(page, 'reset before Characters');
  const charactersNav = await clickControl(page, 'Characters');
  results.push({ navigation:charactersNav, capture:await capture(page,'Characters entry') });
  if (charactersNav.clicked && /\/character\/?$/i.test(new URL(page.url()).pathname)) {
    const pickerNav = await clickControl(page, 'Add from project');
    results.push({ navigation:pickerNav, capture:await capture(page,'Add from project picker') });
    // Close picker if a dialog is open; do not select any item.
    await page.keyboard.press('Escape').catch(()=>{});
    await page.waitForTimeout(500);
  }

  const stamp = new Date().toISOString().replaceAll(':','-');
  const out = path.join(outputDir,`flow-assets-check-v2-${stamp}.json`);
  const screenshot = path.join(outputDir,`flow-assets-check-v2-${stamp}.png`);
  await page.screenshot({path:screenshot,fullPage:false});
  await fs.writeFile(out,JSON.stringify({readOnly:true, note:'No asset was selected; no prompt was submitted; no Generate/Approve/Always approve controls were clicked.',projectUrl:flowUrl,createdAt:new Date().toISOString(),results},null,2),'utf8');
  console.log('\n=== FLOW ASSET CHECK V2 (READ ONLY) ===');
  console.log(`Report: ${out}`);
  console.log(`Screenshot: ${screenshot}`);
  for (const r of results) {
    console.log(`\n=== ${r.capture.section.toUpperCase()} ===`);
    console.log(`URL: ${r.capture.url}`);
    console.log(`Navigation: ${JSON.stringify(r.navigation)}`);
    console.log(`Keywords: ${JSON.stringify(r.capture.snippets)}`);
    console.log('Visible matching elements:');
    for (const el of r.capture.elements.filter(x => /radhika|bholaram|savita|char-01-radhika|char-02-bholaram|queued|something went wrong|video|add from project/i.test(`${x.text} ${x.accessibleText} ${x.href} ${x.parents.map(p=>p.text).join(' ')}`)).slice(0,12)) {
      console.log(`- <${el.tag}> ${(el.text || el.accessibleText || el.href).slice(0,240)}`);
    }
    console.log('Visible controls (first 30):');
    for (const c of r.capture.controls.slice(0,30)) console.log(`- text=${JSON.stringify(c.text)} aria=${JSON.stringify(c.ariaLabel)} title=${JSON.stringify(c.title)} href=${JSON.stringify(c.href)} role=${c.role}`);
  }
} catch (error) {
  console.error('\nFlow asset check v2 did not complete. It did not intentionally generate anything.');
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
} finally {
  if (context) await context.close().catch(()=>{});
}
