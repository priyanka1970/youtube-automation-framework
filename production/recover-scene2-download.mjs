import { chromium } from 'playwright';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const projectUrl = 'https://flow.google.com/project/ca1b2a2a-1840-4580-9198-92b97a5aedb7';
const profilePath = path.resolve('production/.chrome-profile');
const outputDir = path.resolve('production/outputs/youtube-automation-20261015093729601');
const diagnosticsDir = path.resolve('production/outputs/flow-diagnostics');
const desiredFile = path.join(outputDir, 'scene-0002.mp4');
await mkdir(outputDir, { recursive: true });
await mkdir(diagnosticsDir, { recursive: true });

const report = {
  readOnlyExceptDownload: true,
  projectUrl,
  targetCardLabel: 'Driver talking to passenger',
  actions: [],
  outcome: 'not_started',
};
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(diagnosticsDir, `scene2-recovery-${stamp}.json`);

const captureVisible = async (page, scope = page) => {
  const elementScope = scope === page ? page.locator('body') : scope;
  return elementScope.evaluate((root) => {
  const elements = [...root.querySelectorAll('button,[role="button"],[role="menuitem"],[aria-label],[title]')];
  return elements.map((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return {
      tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), text,
      ariaLabel: el.getAttribute('aria-label'), title: el.getAttribute('title'),
      visible, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true'
    };
  }).filter(x => x.visible);
}).catch(() => []);
};

const safeWriteReport = async () => writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
let context;
try {
  try {
    await access(desiredFile);
    report.outcome = 'skipped_existing_scene-0002.mp4';
    report.note = `Target output already exists, so nothing was downloaded: ${desiredFile}`;
    console.log(report.note);
    await safeWriteReport();
    process.exitCode = 0;
  } catch {}

  if (report.outcome !== 'skipped_existing_scene-0002.mp4') {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chrome', headless: false, acceptDownloads: true,
    });
    const pages = context.pages();
    const page = pages.find(p => p.url().startsWith(projectUrl)) ?? pages[0] ?? await context.newPage();
    page.setDefaultTimeout(10000);

    await page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    report.actions.push({ action: 'open_project', url: page.url() });

    const videosControl = page.locator('button').filter({ hasText: /^\s*(?:videocam\s*)?Videos\s*$/i }).first();
    if (await videosControl.count() && await videosControl.isVisible().catch(() => false)) {
      await videosControl.click();
      await page.waitForTimeout(1800);
      report.actions.push({ action: 'open_videos_view', success: true, url: page.url() });
    } else {
      report.actions.push({ action: 'open_videos_view', success: false, note: 'Videos control was not found; using current page.' });
    }

    const tile = page.locator('flow-grid-tile-container[aria-label="Driver talking to passenger"]').first();
    const count = await tile.count();
    report.targetTileCount = count;
    if (count === 0) {
      report.outcome = 'target_tile_not_found';
      report.visiblePageActions = await captureVisible(page);
      report.note = 'No exact tile label "Driver talking to passenger" was found. No menu was clicked and no generation was submitted.';
    } else {
      await tile.hover();
      await page.waitForTimeout(700);
      report.actions.push({ action: 'hover_target_tile', success: true });

      let controls = await captureVisible(page, tile);
      report.targetTileControlsAfterHover = controls;

      let downloadLocator = null;
      let downloadChoice = null;
      const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Flow may include the Material icon name as text, e.g. "download Download".
      // Normalize only the duplicated leading icon token; do not accept unrelated menu actions.
      const normalizeDownloadLabel = (raw = '') => String(raw)
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^download\s+(?=download(?:\s|$))/i, '')
        .toLowerCase();
      const isExactDownloadLabel = (raw = '') =>
        /^(download|download video|download media)$/.test(normalizeDownloadLabel(raw));
      const downloadLocatorPattern = /^\s*(?:download\s+)?download(?:\s+(?:video|media))?\s*$/i;

      const directDownload = controls.find(c => !c.disabled && isExactDownloadLabel(c.ariaLabel || c.title || c.text || ''));
      if (directDownload) {
        const exactLabel = (directDownload.ariaLabel || directDownload.title || directDownload.text).trim();
        if (directDownload.ariaLabel) downloadLocator = tile.locator(`[aria-label=${JSON.stringify(directDownload.ariaLabel)}]`).first();
        else if (directDownload.title) downloadLocator = tile.locator(`[title=${JSON.stringify(directDownload.title)}]`).first();
        else downloadLocator = tile.locator('button,[role="button"],[role="menuitem"]').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(exactLabel)}\\s*$`, 'i') }).first();
        report.actions.push({ action: 'identified_direct_download_control', label: exactLabel });
      } else {
        const moreControl = controls.find(c => !c.disabled && /more options|options|more_vert|context menu/i.test(`${c.ariaLabel || ''} ${c.title || ''} ${c.text || ''}`));
        if (moreControl) {
          const selector = moreControl.ariaLabel
            ? `[aria-label=${JSON.stringify(moreControl.ariaLabel)}]`
            : moreControl.title
              ? `[title=${JSON.stringify(moreControl.title)}]`
              : null;
          if (selector && await tile.locator(selector).count()) {
            await tile.locator(selector).first().click();
            report.actions.push({ action: 'open_target_tile_options', label: moreControl.ariaLabel || moreControl.title || moreControl.text });
            await page.waitForTimeout(500);
          }
        }

        // Only consider an explicitly visible Download action. Never click regenerate/delete/approve.
        const menuChoices = await page.evaluate(() => {
          const els = [...document.querySelectorAll('[role="menuitem"],button,[role="button"],mat-option')];
          return els.map(el => {
            const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
            const visible = r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
            const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), text,
              ariaLabel: el.getAttribute('aria-label'), title: el.getAttribute('title'), visible,
              disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' };
          }).filter(x => x.visible && /download/i.test(`${x.text} ${x.ariaLabel || ''} ${x.title || ''}`));
        });
        report.visibleDownloadChoices = menuChoices;
        downloadChoice = menuChoices.find(c => !c.disabled && isExactDownloadLabel(c.ariaLabel || c.title || c.text || ''));
        if (downloadChoice) {
          const exactText = (downloadChoice.text || downloadChoice.ariaLabel || downloadChoice.title || '').trim();
          if (downloadChoice.role === 'menuitem') {
            // Match both plain "Download" and Material-icon + label "download Download".
            downloadLocator = page.getByRole('menuitem', { name: downloadLocatorPattern }).first();
          } else if (downloadChoice.ariaLabel) {
            downloadLocator = page.locator(`[aria-label=${JSON.stringify(downloadChoice.ariaLabel)}]`).first();
          } else if (downloadChoice.title) {
            downloadLocator = page.locator(`[title=${JSON.stringify(downloadChoice.title)}]`).first();
          } else {
            downloadLocator = page.locator('button,[role="button"],[role="menuitem"]').filter({ hasText: downloadLocatorPattern }).first();
          }
          report.actions.push({ action: 'identified_exact_download_menu_item', rawLabel: exactText, normalizedLabel: normalizeDownloadLabel(exactText) });
        }
      }

      if (downloadLocator) {
        const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
        await downloadLocator.click({ timeout: 8000 });
        report.actions.push({ action: 'click_exact_download_control', choice: downloadChoice || directDownload });
        try {
          const download = await downloadPromise;
          const suggested = download.suggestedFilename();
          const targetName = /\.mp4$/i.test(suggested) ? 'scene-0002.mp4' : suggested;
          const targetPath = path.join(outputDir, targetName);
          await download.saveAs(targetPath);
          report.outcome = 'download_saved';
          report.download = { suggestedFilename: suggested, savedAs: targetPath, failure: await download.failure() };
          console.log(`Downloaded existing Flow video to: ${targetPath}`);
        } catch (downloadError) {
          report.outcome = 'download_click_no_browser_download_event';
          report.error = String(downloadError?.message || downloadError);
          report.note = 'The Download option was clicked, but Playwright did not receive a browser download event. No generation was submitted.';
        }
      } else {
        report.outcome = 'download_option_not_found';
        report.note = 'The target tile was found, but no visible exact Download control was exposed. No generation was submitted and no other menu action was clicked.';
      }
      report.visiblePageActions = await captureVisible(page);
    }
    await safeWriteReport();
    console.log('\n=== SCENE 2 FLOW RECOVERY CHECK ===');
    console.log(`Report: ${reportPath}`);
    console.log(`Target tile count: ${report.targetTileCount ?? 0}`);
    console.log(`Outcome: ${report.outcome}`);
    if (report.note) console.log(`Note: ${report.note}`);
    if (report.download) console.log(`Saved: ${report.download.savedAs}`);
    if (report.visibleDownloadChoices) console.log(`Download choices: ${JSON.stringify(report.visibleDownloadChoices)}`);
  }
} catch (error) {
  report.outcome = 'script_error';
  report.error = error?.stack || String(error);
  await safeWriteReport().catch(() => {});
  console.error('Scene 2 recovery check failed:', error?.stack || error);
  process.exitCode = 1;
} finally {
  if (context) await context.close().catch(() => {});
}
