import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const root = process.cwd();
const profile = path.resolve(arg('--profile', path.join(root, 'production', '.chrome-profile')));
const url = arg('--url', 'https://aistudio.google.com/generate-speech');
const manifestPath = arg('--manifest', '');
const outDir = path.resolve(arg('--out', path.join(root, 'production', 'outputs', 'flow-recovery-diagnostics')));
await fs.mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(outDir, `ai-studio-speech-editor-v26-${stamp}.json`);
const shotPath = path.join(outDir, `ai-studio-speech-editor-v26-${stamp}.png`);
const repairedCandidatePath = manifestPath ? path.resolve(manifestPath).replace(/\.json$/i, '.repaired-candidate.json') : '';

const suspiciousPattern = /(?:à¤|à¥|Ã.|Â.|â€|ðŸ|ï¿½|�)/u;
const cp1252Special = new Map([
  ['€',0x80],['‚',0x82],['ƒ',0x83],['„',0x84],['…',0x85],['†',0x86],['‡',0x87],['ˆ',0x88],['‰',0x89],
  ['Š',0x8A],['‹',0x8B],['Œ',0x8C],['Ž',0x8E],['‘',0x91],['’',0x92],['“',0x93],['”',0x94],['•',0x95],
  ['–',0x96],['—',0x97],['˜',0x98],['™',0x99],['š',0x9A],['›',0x9B],['œ',0x9C],['ž',0x9E],['Ÿ',0x9F]
]);
function reverseWindows1252ToUtf8(s) {
  const bytes = [];
  for (const c of s) {
    const cp = c.codePointAt(0);
    if (cp <= 0x7F) bytes.push(cp);
    else if (cp1252Special.has(c)) bytes.push(cp1252Special.get(c));
    else if ((cp >= 0xA0 && cp <= 0xFF) || (cp >= 0x80 && cp <= 0x9F)) bytes.push(cp);
    else return { ok: false, reason: `Character U+${cp.toString(16).toUpperCase()} is not reversible through Windows-1252.` };
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    return { ok: true, text: decoded };
  } catch (e) {
    return { ok: false, reason: `Bytes are not valid UTF-8: ${String(e?.message ?? e)}` };
  }
}
function auditText(s) {
  const chars = [...s];
  return {
    length: chars.length,
    suspiciousMojibakePattern: suspiciousPattern.test(s),
    replacementCharacterCount: chars.filter(c => c === '\uFFFD').length,
    devanagariCharacterCount: chars.filter(c => /[\u0900-\u097F]/u.test(c)).length,
    first120: chars.slice(0, 120).join(''),
    jsonEscapedFirst120: JSON.stringify(chars.slice(0, 120).join('')),
    first40CodePoints: chars.slice(0, 40).map(c => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
  };
}

let manifestAudit = null;
let candidateSummary = null;
if (manifestPath) {
  const resolvedManifest = path.resolve(manifestPath);
  const source = JSON.parse(await fs.readFile(resolvedManifest, 'utf8'));
  const candidate = structuredClone(source);
  const repairs = [];
  let repairFailures = [];
  const tryRepair = (field, value) => {
    const before = auditText(String(value ?? ''));
    if (!before.suspiciousMojibakePattern) return { value, audit: { before, attempted: false, success: false } };
    const converted = reverseWindows1252ToUtf8(String(value ?? ''));
    const after = converted.ok ? auditText(converted.text) : null;
    const valid = Boolean(converted.ok && after && !after.suspiciousMojibakePattern && after.replacementCharacterCount === 0 && after.devanagariCharacterCount > 0);
    const item = { field, before: before.jsonEscapedFirst120, conversionOk: converted.ok, reason: converted.reason ?? '', after: after?.jsonEscapedFirst120 ?? '', devanagariBefore: before.devanagariCharacterCount, devanagariAfter: after?.devanagariCharacterCount ?? 0, success: valid };
    repairs.push(item);
    if (!valid) repairFailures.push(item);
    return { value: valid ? converted.text : value, audit: { before, attempted: true, conversionOk: converted.ok, reason: converted.reason ?? '', after, success: valid } };
  };
  if (typeof candidate.voice_direction === 'string') {
    const r = tryRepair('voice_direction', candidate.voice_direction);
    candidate.voice_direction = r.value;
  }
  if (Array.isArray(candidate.scenes)) {
    candidate.scenes = candidate.scenes.map((scene, i) => {
      const r = tryRepair(`scenes[${i}].text (scene ${scene.scene_number})`, scene.text);
      return { ...scene, text: r.value };
    });
  }
  const suspiciousRemaining = [candidate.voice_direction, ...(candidate.scenes ?? []).map(s => s.text)]
    .filter(v => typeof v === 'string' && suspiciousPattern.test(v)).length;
  const anyRepairs = repairs.some(r => r.success);
  const allAttemptedSucceeded = repairFailures.length === 0;
  // A separate candidate is created only if every attempted conversion succeeds and each changed field validates.
  if (anyRepairs && allAttemptedSucceeded && suspiciousRemaining === 0) {
    await fs.writeFile(repairedCandidatePath, JSON.stringify(candidate, null, 2) + '\n', 'utf8');
    candidateSummary = { written: true, path: repairedCandidatePath, repairs, originalModified: false };
  } else {
    candidateSummary = { written: false, proposedPath: repairedCandidatePath, repairs, suspiciousRemaining, reason: !anyRepairs ? 'No validated repair was possible.' : 'At least one suspicious field could not be safely repaired; no candidate manifest was written.', originalModified: false };
  }
  manifestAudit = {
    originalPath: resolvedManifest,
    originalModified: false,
    voiceDirection: auditText(String(source.voice_direction ?? '')),
    scenes: (source.scenes ?? []).map(s => ({ scene_number: s.scene_number, text: auditText(String(s.text ?? '')) })),
    candidate: candidateSummary
  };
}

console.log('READ-ONLY AI STUDIO SPEECH EDITOR INSPECTION v26');
console.log('Allowed UI action: one click on the exact “Create new dialog” card only.');
console.log('No narration entered, no Run button clicked, no speech generated, no pipeline edits.');
console.log('Manifest repair, if valid, is saved as a SEPARATE candidate file; original manifest is never overwritten.');
console.log(`Profile: ${profile}`);
console.log(`URL: ${url}`);

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  acceptDownloads: true,
  viewport: null,
  args: ['--no-first-run', '--disable-blink-features=AutomationControlled']
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  const initial = await page.evaluate(() => ({ url: location.href, title: document.title, bodyText: (document.body?.innerText ?? '').slice(0, 6000) }));

  // The card is a <mat-card role="button">, not a native <button>; target only that card.
  const cardLocator = page.locator('mat-card[role="button"]').filter({ hasText: 'Create new dialog' });
  const cardCount = await cardLocator.count().catch(() => 0);
  let createNewDialog = { found: cardCount > 0, count: cardCount, clicked: false, message: '' };
  if (cardCount === 1) {
    const state = await cardLocator.evaluate(el => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return { text: (el.innerText || '').replace(/\s+/g, ' ').trim(), visible: r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden', disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled') };
    });
    createNewDialog.state = state;
    if (state.visible && !state.disabled && /^add\s*Create new dialog$/i.test(state.text)) {
      await cardLocator.click({ timeout: 10000 });
      createNewDialog.clicked = true;
      createNewDialog.message = 'Clicked only the exact Create new dialog card.';
      await page.waitForTimeout(5000);
    } else {
      createNewDialog.message = 'Safety guard declined click because card state/text did not match expected exact card.';
    }
  } else {
    createNewDialog.message = 'Safety guard declined click because Create new dialog card was not unique.';
  }

  const dom = await page.evaluate(() => {
    const isVisible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const summary = (el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '', ariaLabel: el.getAttribute('aria-label') || '', placeholder: el.getAttribute('placeholder') || '',
        title: el.getAttribute('title') || '', contenteditable: el.getAttribute('contenteditable') || '',
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'), visible: isVisible(el),
        text: (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 240),
        outerHTML: el.outerHTML.slice(0, 600), rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
      };
    };
    const unique = sel => [...document.querySelectorAll(sel)].map(summary);
    return {
      url: location.href, title: document.title,
      counts: { input: document.querySelectorAll('input').length, textarea: document.querySelectorAll('textarea').length, contenteditable: document.querySelectorAll('[contenteditable="true"]').length, buttons: document.querySelectorAll('button').length, audio: document.querySelectorAll('audio').length, downloadLinks: document.querySelectorAll('a[download], a[href*="download"]').length },
      inputs: unique('input, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]'),
      buttons: unique('button, [role="button"], mat-card[role="button"]').filter(x => x.visible).slice(0, 120),
      audio: unique('audio'), downloadLinks: unique('a[download], a[href*="download"]'),
      bodyText: (document.body?.innerText ?? '').slice(0, 14000)
    };
  });
  await page.screenshot({ path: shotPath, fullPage: true });
  const report = { createdAt: new Date().toISOString(), initial, createNewDialog, dom, manifestAudit, screenshot: shotPath };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\nEDITOR INSPECTION COMPLETE');
  console.log(`Initial URL/title: ${initial.url} | ${initial.title}`);
  console.log(`Create new dialog: ${JSON.stringify(createNewDialog)}`);
  console.log(`Final URL/title: ${dom.url} | ${dom.title}`);
  console.log(`Element counts: ${JSON.stringify(dom.counts)}`);
  console.log('\nVisible inputs/editors:');
  for (const el of dom.inputs.filter(x => x.visible)) console.log(`- <${el.tag}> role=${el.role} name=${el.name} aria=${el.ariaLabel} placeholder=${el.placeholder} contenteditable=${el.contenteditable} text=${el.text}`);
  console.log('\nVisible relevant buttons/roles:');
  for (const el of dom.buttons.filter(x => /run|generate|speech|dialog|speaker|download|style|expression|add block|voice|text to speech/i.test(`${x.text} ${x.ariaLabel} ${x.title}`)).slice(0, 80)) console.log(`- <${el.tag}> role=${el.role} text=${el.text} aria=${el.ariaLabel} title=${el.title} disabled=${el.disabled}`);
  console.log('\nBody excerpt:'); console.log(dom.bodyText.slice(0, 6000));
  if (manifestAudit) {
    console.log('\nMANIFEST UNICODE AUDIT:');
    for (const s of manifestAudit.scenes) console.log(`- scene ${s.scene_number}: suspicious=${s.text.suspiciousMojibakePattern}, devanagari=${s.text.devanagariCharacterCount}, replacementChars=${s.text.replacementCharacterCount}, first=${s.text.jsonEscapedFirst120}`);
    console.log('\nREPAIR CANDIDATE RESULT (original manifest unchanged):');
    console.log(JSON.stringify(candidateSummary));
  }
  console.log(`\nJSON report: ${reportPath}`);
  console.log(`Screenshot: ${shotPath}`);
  console.log('No narration submitted. No Run button clicked. No speech generated.');
} finally { await context.close(); }
