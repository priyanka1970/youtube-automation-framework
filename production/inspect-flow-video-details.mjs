import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const projectUrl = 'https://flow.google.com/project/ca1b2a2a-1840-4580-9198-92b97a5aedb7';
const profilePath = path.resolve('production/.chrome-profile');
const outputDir = path.resolve('production/outputs/flow-diagnostics');
await mkdir(outputDir, { recursive: true });

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const context = await chromium.launchPersistentContext(profilePath, {
  channel: 'chrome',
  headless: false,
  acceptDownloads: true,
});

try {
  const pages = context.pages();
  const page = pages.find(p => p.url().startsWith(projectUrl)) ?? pages[0] ?? await context.newPage();
  page.setDefaultTimeout(10000);

  await page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3500);

  // Switching to the Videos view is safe; this script never generates or approves anything.
  let videosNavigation = { found: false, clicked: false, note: '' };
  const videosButton = page.locator('button').filter({ hasText: /\bVideos\b/i }).first();
  if (await videosButton.count()) {
    videosNavigation.found = true;
    if (await videosButton.isVisible().catch(() => false)) {
      await videosButton.click({ timeout: 8000 });
      videosNavigation.clicked = true;
      await page.waitForTimeout(2500);
    } else {
      videosNavigation.note = 'Videos button exists but is not visible.';
    }
  } else {
    videosNavigation.note = 'No button with visible Videos text found; page was not changed further.';
  }

  const capture = await page.evaluate(() => {
    function collect(root, output = []) {
      if (!root?.querySelectorAll) return output;
      for (const el of root.querySelectorAll('*')) {
        output.push(el);
        if (el.shadowRoot) collect(el.shadowRoot, output);
      }
      return output;
    }
    const allElements = collect(document);
    const customTags = new Set(['FLOW-VIDEO-TILE', 'FLOW-A2UI-VIDEO-OPTION', 'FLOW-GRID-TILE-CONTAINER']);
    const hosts = allElements.filter(el => customTags.has(el.tagName));
    const relevantAttribute = name => /^(id|role|title|aria-label|aria-labelledby|href|src|srcset|poster|type|name|data-.+)$/i.test(name);
    const attrsOf = el => Object.fromEntries([...el.attributes]
      .filter(a => relevantAttribute(a.name))
      .map(a => [a.name, a.value]));
    const shortText = (el, max = 900) => {
      let t = '';
      try { t = el.innerText || el.textContent || ''; } catch {}
      t = t.replace(/\s+/g, ' ').trim();
      return t.length > max ? t.slice(0, max) + '…' : t;
    };
    const detailsFor = host => {
      const inner = collect(host);
      const mediaAndLinks = inner.filter(el => ['IMG', 'VIDEO', 'SOURCE', 'A'].includes(el.tagName) ||
        [...el.attributes].some(a => /^(data-|id$|aria-label$|title$|href$|src$|poster$)/i.test(a.name)));
      return {
        tag: host.tagName.toLowerCase(),
        attributes: attrsOf(host),
        text: shortText(host),
        htmlStart: (host.outerHTML || '').slice(0, 2500),
        descendants: mediaAndLinks.slice(0, 60).map(el => ({
          tag: el.tagName.toLowerCase(),
          attributes: attrsOf(el),
          text: shortText(el, 350),
          currentSrc: el.currentSrc || undefined,
          src: el.src || undefined,
          href: el.href || undefined,
        })),
      };
    };
    const allMedia = allElements.filter(el => ['VIDEO', 'SOURCE'].includes(el.tagName)).map(el => ({
      tag: el.tagName.toLowerCase(), attributes: attrsOf(el), currentSrc: el.currentSrc || undefined,
      src: el.src || undefined, text: shortText(el, 350),
    }));
    return {
      url: location.href,
      title: document.title,
      capturedAt: new Date().toISOString(),
      bodyTextLength: (document.body?.innerText || '').length,
      bodyTextTail: (document.body?.innerText || '').slice(-5000),
      customElementCounts: Object.fromEntries([...customTags].map(tag => [tag.toLowerCase(), hosts.filter(e => e.tagName === tag).length])),
      videoCards: hosts.filter(el => el.tagName === 'FLOW-VIDEO-TILE').map(detailsFor),
      a2uiVideoOptions: hosts.filter(el => el.tagName === 'FLOW-A2UI-VIDEO-OPTION').map(detailsFor),
      otherGridTiles: hosts.filter(el => el.tagName === 'FLOW-GRID-TILE-CONTAINER').map(detailsFor),
      mediaElements: allMedia,
    };
  });

  const report = {
    readOnly: true,
    note: 'The script only opened the saved Flow project and selected the Videos view. It did not submit prompts or click Generate/Approve.',
    videosNavigation,
    capture,
  };
  const jsonPath = path.join(outputDir, `flow-video-details-${stamp()}.json`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n=== LIVE FLOW VIDEO DOM INSPECTION (READ ONLY) ===');
  console.log(`Report: ${jsonPath}`);
  console.log(`URL: ${capture.url}`);
  console.log(`Videos navigation: ${JSON.stringify(videosNavigation)}`);
  console.log(`Element counts: ${JSON.stringify(capture.customElementCounts)}`);
  console.log(`Actual video/source elements: ${capture.mediaElements.length}`);

  for (const [i, card] of capture.videoCards.entries()) {
    console.log(`\n--- FLOW VIDEO TILE ${i + 1} ---`);
    console.log(`Attributes: ${JSON.stringify(card.attributes)}`);
    console.log(`Text: ${card.text || '(none)'}`);
    for (const child of card.descendants.filter(x => ['video', 'source', 'img', 'a'].includes(x.tag))) {
      console.log(`${child.tag}: ${JSON.stringify({ attributes: child.attributes, currentSrc: child.currentSrc, src: child.src, href: child.href, text: child.text })}`);
    }
    if (!card.descendants.some(x => ['video', 'source', 'img', 'a'].includes(x.tag))) {
      console.log(`HTML: ${card.htmlStart.slice(0, 900)}`);
    }
  }

  for (const [i, option] of capture.a2uiVideoOptions.entries()) {
    console.log(`\n--- CHAT VIDEO OPTION ${i + 1} (not assumed to be a completed video) ---`);
    console.log(`Attributes: ${JSON.stringify(option.attributes)}`);
    console.log(`Text: ${option.text.slice(0, 500) || '(none)'}`);
  }

  if (capture.videoCards.length === 0) {
    console.log('\nNo flow-video-tile elements found. Relevant body text tail:');
    console.log(capture.bodyTextTail.slice(-1800));
  }
} catch (error) {
  console.error('Flow DOM inspection failed:', error?.stack || error);
  process.exitCode = 1;
} finally {
  await context.close();
}
