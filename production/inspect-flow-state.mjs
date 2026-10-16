import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Read-only Google Flow diagnostic. It does NOT click buttons, submit prompts,
// approve generations, or delete/edit any project assets.
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = process.cwd();
const productionDir = path.resolve(projectRoot, 'production');
const profileDir = path.join(productionDir, '.chrome-profile');
const flowUrl = 'https://flow.google.com/project/ca1b2a2a-1840-4580-9198-92b97a5aedb7';
const outputDir = path.join(productionDir, 'outputs', 'flow-diagnostics');
const projectOutputDir = path.join(productionDir, 'outputs', 'youtube-automation-20261015093729601');
await fs.mkdir(outputDir, { recursive: true });

async function listOutputFiles(root) {
    const found = [];
    const pending = [root];
    while (pending.length) {
        const dir = pending.pop();
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) pending.push(full);
            else if (/\.(mp4|webm|mov|json|png|jpg|jpeg)$/i.test(entry.name)) {
                try {
                    const stat = await fs.stat(full);
                    found.push({ path: full, extension: path.extname(full).toLowerCase(), sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() });
                } catch { }
            }
        }
    }
    return found.sort((a, b) => a.path.localeCompare(b.path));
}

const stamp = new Date().toISOString().replaceAll(':', '-');
const reportPath = path.join(outputDir, `flow-diagnostic-${stamp}.json`);
const screenshotPath = path.join(outputDir, `flow-diagnostic-${stamp}.png`);

const keywords = [
    'Radhika', 'CHAR-01-RADHIKA', 'CHAR-02-BHOLARAM',
    'I couldn\'t find the reference asset', 'reference asset',
    'सावधान रहना', 'आज रात तो बस', 'Queued', 'Something went wrong',
    'movie', 'scene:1', 'scene:2'
];

let context;
try {
    context = await chromium.launchPersistentContext(profileDir, {
        channel: 'chrome',
        headless: false,
        acceptDownloads: true,
        viewport: { width: 1440, height: 1000 }
    });

    const pages = context.pages();
    const page = pages.find(p => p.url().includes('/project/ca1b2a2a-1840-4580-9198-92b97a5aedb7'))
        ?? pages[0]
        ?? await context.newPage();

    if (!page.url().includes('/project/ca1b2a2a-1840-4580-9198-92b97a5aedb7')) {
        await page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await page.locator('body').waitFor({ state: 'visible', timeout: 30000 });
    // Let Flow's client-side project/media panel populate; observation only.
    await page.waitForTimeout(8000);

    const snapshots = [];
    for (let sample = 1; sample <= 3; sample++) {
        const data = await page.evaluate((searchTerms) => {
            const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
            const visible = (el) => {
                const style = getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return style.visibility !== 'hidden' && style.display !== 'none' &&
                    Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
            };
            const bodyText = document.body?.innerText ?? '';
            const contexts = {};
            for (const term of searchTerms) {
                const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
                const found = [];
                let m;
                while ((m = re.exec(bodyText)) && found.length < 8) {
                    found.push(clean(bodyText.slice(Math.max(0, m.index - 240), Math.min(bodyText.length, m.index + term.length + 360))));
                    if (m.index === re.lastIndex) re.lastIndex++;
                }
                if (found.length) contexts[term] = found;
            }

            const matchedElements = [];
            const matchRe = /radhika|bholaram|char-01-radhika|char-02-bholaram|reference asset|couldn't find|queued|something went wrong|सावधान रहना|आज रात तो बस/i;
            for (const el of Array.from(document.querySelectorAll('body *'))) {
                if (!visible(el)) continue;
                const text = clean(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title'));
                if (!text || text.length > 1300 || !matchRe.test(text)) continue;
                // Keep compact nodes or nodes that introduce a relevant status/message.
                if (el.children.length > 8 && text.length > 500) continue;
                const ancestors = [];
                let p = el.parentElement;
                for (let level = 0; p && level < 3; level++, p = p.parentElement) {
                    const pt = clean(p.innerText);
                    ancestors.push({ tag: p.tagName.toLowerCase(), role: p.getAttribute('role'), cls: String(p.className || '').slice(0, 160), text: pt.slice(0, 500) });
                }
                matchedElements.push({
                    tag: el.tagName.toLowerCase(),
                    role: el.getAttribute('role'),
                    ariaLabel: el.getAttribute('aria-label'),
                    title: el.getAttribute('title'),
                    className: String(el.className || '').slice(0, 200),
                    text: text.slice(0, 1000),
                    ancestors
                });
                if (matchedElements.length >= 100) break;
            }

            const controls = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]'))
                .filter(visible)
                .map(el => ({
                    tag: el.tagName.toLowerCase(),
                    role: el.getAttribute('role'),
                    ariaLabel: el.getAttribute('aria-label'),
                    title: el.getAttribute('title'),
                    disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
                    text: clean(el.innerText || el.textContent).slice(0, 180)
                }))
                .filter(x => x.text || x.ariaLabel || x.title)
                .slice(0, 100);

            const mediaCandidates = [];
            const cardSelector = '[role="listitem"], article, [data-testid], [class*="card"], [class*="tile"], [class*="asset"]';
            for (const el of Array.from(document.querySelectorAll(cardSelector))) {
                if (!visible(el)) continue;
                const text = clean(el.innerText);
                if (!text || text.length > 1600 || !/queued|error|failed|radhika|bholaram|scene|video|something went wrong/i.test(text)) continue;
                mediaCandidates.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), className: String(el.className || '').slice(0, 160), text: text.slice(0, 1200) });
                if (mediaCandidates.length >= 50) break;
            }

            return {
                sampledAt: new Date().toISOString(),
                url: location.href,
                title: document.title,
                bodyTextLength: bodyText.length,
                bodyText: bodyText.slice(0, 40000),
                keywordContexts: contexts,
                matchedElements,
                visibleControls: controls,
                mediaCandidates
            };
        }, keywords);
        snapshots.push(data);
        if (sample < 3) await page.waitForTimeout(5000);
    }

    await page.screenshot({ path: screenshotPath, fullPage: false });
    const localArtifacts = await listOutputFiles(projectOutputDir);
    const report = {
        readOnly: true,
        note: 'No buttons were clicked and no prompts were submitted or approved.',
        projectUrl: flowUrl,
        profileDir,
        collectedAt: new Date().toISOString(),
        localArtifacts,
        samples: snapshots
    };
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

    console.log('\n=== FLOW DIAGNOSTIC COMPLETE (READ ONLY) ===');
    console.log(`Report: ${reportPath}`);
    console.log(`Screenshot: ${screenshotPath}`);
    console.log(`Current URL: ${snapshots.at(-1)?.url}`);
    console.log('\n=== LOCAL VIDEO/ARTIFACT FILES ===');
    if (localArtifacts.length) {
        for (const f of localArtifacts) console.log(`- ${f.path} (${f.sizeBytes} bytes, modified ${f.modifiedAt})`);
    } else {
        console.log(`No matching files found under ${projectOutputDir}`);
    }
    console.log('\n=== MATCHED KEYWORD CONTEXTS (latest sample) ===');
    const last = snapshots.at(-1);
    for (const [term, matches] of Object.entries(last.keywordContexts)) {
        console.log(`\n[${term}] (${matches.length} match(es))`);
        for (const snippet of matches.slice(0, 4)) console.log(` - ${snippet}`);
    }
    console.log('\n=== VISIBLE STATUS-LIKE ELEMENTS (latest sample) ===');
    for (const el of last.matchedElements.filter(x => /queued|something went wrong|couldn't find|reference asset|CHAR-01-RADHIKA|CHAR-02-BHOLARAM|सावधान रहना|आज रात तो बस/i.test(x.text)).slice(0, 25)) {
        console.log(`- <${el.tag}> role=${el.role ?? '-'} aria=${el.ariaLabel ?? '-'} text=${el.text.slice(0, 300)}`);
    }
    console.log('\nUpload the JSON report or paste the keyword-context section if you want the results interpreted.');
} catch (error) {
    console.error('\nFlow diagnostic did not complete. No generation was intentionally started.');
    console.error(error?.stack ?? String(error));
    console.error('\nIf the error says the profile is already in use, close the Chrome window opened with production\\.chrome-profile and rerun this script.');
    process.exitCode = 1;
} finally {
    if (context) await context.close().catch(() => { });
}
