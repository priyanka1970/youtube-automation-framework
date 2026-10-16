import type { Page, Locator } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { S } from './selectors.js';
import type { Item } from './types.js';
import { launchProfile } from './browserSession.js';
import { mediaSources, waitGeneration, type GenerationState } from './generation.js';
export { FlowGenerationQueuedError } from './generation.js';

export class FlowClient {
  private item?: Item;
  private save: () => Promise<void> = async () => {};
  private result?: Locator;
  private kind: 'video' | 'image' = 'image';
  private readonly projectUrl: string;

  constructor(
    private page: Page,
    private log: (e: string, d?: any) => void,
    projectUrl: string,
  ) {
    this.projectUrl = projectUrl;
  }

  private urlKey(value: string): string {
    try {
      const url = new URL(value);
      url.pathname = url.pathname.replace(/\/+$/, '') || '/';
      return `${url.origin}${url.pathname}${url.search}`;
    } catch {
      return value;
    }
  }

  private async restoreProjectChatContext(reason: string): Promise<void> {
    if (this.page.isClosed()) throw new Error('Cannot restore Google Flow chat because the browser page is closed.');
    const currentUrl = this.page.url();
    if (this.urlKey(currentUrl) === this.urlKey(this.projectUrl)) return;

    this.log('flow_project_chat_restore_attempt', {
      currentUrl,
      projectUrl: this.projectUrl,
      reason,
      policy: 'Restore the original project chat after opening a generated clip in the editor; do not create a new project or resubmit a prompt.',
    });
    await this.page.goto(this.projectUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.page.locator(S.addMedia.join(',')).first().waitFor({ state: 'visible', timeout: 60000 });
    this.log('flow_project_chat_restored', {
      url: this.page.url(),
      reason,
      policy: 'Continue the remaining scenes in the saved project chat URL.',
    });
  }

  async first(candidates: readonly string[], timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const selector of candidates) {
        const matches = this.page.locator(selector);
        for (let i = 0; i < await matches.count(); i++) {
          const locator = matches.nth(i);
          if (await locator.isVisible()) return locator;
        }
      }
      if (this.page.isClosed()) throw new Error('Automation browser closed.');
      await this.page.waitForTimeout(200);
    }
    throw new Error(`Flow control missing at ${this.page.url()}: ${candidates.join(' | ')}`);
  }

  async click(candidates: readonly string[]) {
    await (await this.first(candidates)).click();
  }

  async fill(candidates: readonly string[], text: string) {
    await (await this.first(candidates)).fill(text);
  }

  async prompt(text: string) {
    if (!text || text === 'undefined') throw new Error('Missing generation prompt.');
    await this.fill(S.promptInput, text);
  }

  async agentComposer() {
    return await this.page.getByRole('button', { name: 'Agent instructions', exact: true }).isVisible()
      && await this.page.locator(S.promptInput.join(',')).first().isVisible();
  }

  async agentPrompt(text: string) {
    // Current Flow's agent prompt chooses the requested media kind itself;
    // opening its Settings button opens agent settings, not a model selector.
    await this.prompt(text);
  }

  async bind(item: Item, save: () => Promise<void>, kind: 'video' | 'image') {
    this.item = item;
    this.save = save;
    this.kind = kind;
    this.result = undefined;

    const state = item.flow_generation as GenerationState | undefined;
    if (state?.phase === 'prepared') {
      throw new Error('Previous run stopped at submission. Check this item in Flow before clearing its flow_generation marker; automatic retry could duplicate credits.');
    }

    // Always bind to the configured project chat, not the last URL visited by
    // a video-card click. Older saved states may contain the editor URL from a
    // previous run, so migrate them safely instead of letting the editor become
    // the next scene's prompt destination.
    await this.restoreProjectChatContext(`bind:${String((item as any).tag ?? (item as any).scene_number ?? 'item')}`);
    if (state && state.url !== this.projectUrl) {
      const previousUrl = state.url;
      state.url = this.projectUrl;
      await save();
      this.log('flow_generation_project_url_migrated', {
        item: String((item as any).tag ?? (item as any).scene_number ?? 'item'),
        previousUrl,
        projectUrl: this.projectUrl,
        reason: 'The saved URL was not the canonical project chat URL.',
      });
    }
    return Boolean(state);
  }

  async generate() {
    if (!this.item) throw new Error('Generation item has not been bound.');

    const minutes = Number(process.env.FLOW_QUEUE_WAIT_MINUTES ?? '30');
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) {
      throw new Error('FLOW_QUEUE_WAIT_MINUTES must be between 1 and 120.');
    }

    let state = this.item.flow_generation as GenerationState | undefined;
    const runtimeExclusions = Array.isArray((this.item as any).__flow_source_exclusions)
      ? (this.item as any).__flow_source_exclusions.map((value: unknown) => String(value ?? '')).filter(Boolean)
      : undefined;
    if (state && runtimeExclusions) {
      state.excluded_sources = [...new Set(runtimeExclusions)];
      await this.save();
    }
    if (!state) {
      const submit = await this.first(S.submit);
      const enabledDeadline = Date.now() + 15000;
      while (!await submit.isEnabled() && Date.now() < enabledDeadline) {
        await this.page.waitForTimeout(200);
      }
      if (!await submit.isEnabled()) {
        throw new Error('Flow generation control is disabled. The form has not accepted its prompt.');
      }

      state = {
        url: this.projectUrl,
        baseline: await mediaSources(this.page, this.kind),
        phase: 'prepared',
        started_at: new Date().toISOString(),
        excluded_sources: runtimeExclusions ?? [],
      };
      this.item.flow_generation = state;
      await this.save();

      await submit.click();
      state.phase = 'submitted';
      // Preserve the canonical chat URL even if Flow subsequently opens an
      // editor view for a generated option during recovery.
      state.url = this.projectUrl;
      await this.save();
    }

    this.result = await waitGeneration(
      this.page,
      this.item,
      this.kind,
      this.save,
      this.log,
      minutes * 60_000,
    );
  }

  async rename(name: string) {
    let input;
    try {
      input = await this.first(S.nameInput, 1500);
    } catch {
      await this.click(S.options);
      await this.click(S.rename);
      input = await this.first(S.nameInput);
    }
    await input.fill(name);
    try {
      await this.click(S.save);
    } catch {
      await input.press('Enter');
    }
  }

  async configureVoice(voice: { gender?: string; age?: string; descriptor?: string; name?: string }) {
    await this.click(S.voice);
    await this.click((voice.gender ?? '').toLowerCase().startsWith('f') ? S.femaleVoice : S.maleVoice);
    await this.click(S.customizePerformance);
    if (voice.age) await this.fill(S.ageInput, voice.age);
    if (voice.descriptor) await this.fill(S.descriptorInput, voice.descriptor);
    if (voice.name) await this.fill(S.voiceNameInput, voice.name);
    await this.click(S.saveNewVoice);
    await this.click(S.addToCharacter);
  }

  async selectAsset(tag: string, hint?: string) {
    if (!tag || tag === 'undefined') throw new Error('Scene references an undefined asset.');
    await this.click(S.promptInput);
    await this.page.keyboard.type(tag);
    const exact = this.page.getByRole('option').filter({ hasText: tag }).or(this.page.getByText(tag, { exact: true })).last();
    if (await exact.isVisible()) {
      await exact.click();
      return;
    }
    // Current Flow uses an ingredient picker with generated prompt summaries.
    // Match a unique visible card semantically; never retain a positional index.
    const picker = this.page.getByRole('button', { name: /Add ingredients/i });
    if (await picker.isVisible()) await picker.click();
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const text = new RegExp(escaped + (hint ? `|${hint.slice(0, 28).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` : ''), 'i');
    const option = this.page.getByRole('option').filter({ hasText: text });
    await option.first().waitFor({ state: 'visible', timeout: 15000 });
    if (await option.count() !== 1) {
      throw new Error(`Asset ${tag} has multiple matching cards. Refusing to select an unrelated asset.`);
    }
    await option.click();
  }

  async download(output: string, filename: string) {
    if (!this.result || !this.item) throw new Error('No completed media belonging to this item.');
    await fs.mkdir(output, { recursive: true });
    const destination = path.join(output, filename);

    try {
      await this.result.hover();
      const card = this.result.locator('xpath=ancestor::*[.//button[contains(@aria-label,"Download") or contains(@aria-label,"download")] or .//a[@download]][1]');
      const control = card.locator('button[aria-label*="Download" i], a[download]').first();
      if (!await control.isVisible() || await card.locator('video').count() !== 1) {
        await this.downloadMediaSource(destination);
        return;
      }
      const [download] = await Promise.all([
        this.page.waitForEvent('download', { timeout: 120000 }),
        control.click(),
      ]);
      if (await download.failure()) throw new Error('Flow download failed. Resume to retry this result.');
      await download.saveAs(destination);
      const handle = await fs.open(destination, 'r');
      let valid = false;
      try {
        const bytes = Buffer.alloc(12);
        await handle.read(bytes, 0, 12, 0);
        valid = bytes.toString('ascii', 4, 8) === 'ftyp';
      } finally {
        await handle.close();
      }
      // Flow sometimes exposes only Download batch (ZIP). The exact playable
      // media source is still downloadable without selecting an unrelated item.
      if (!valid) {
        await this.downloadMediaSource(destination);
        return;
      }
      this.log('downloaded', { file: destination });
    } finally {
      // In Flow, a generated option's â€œOpen video in editorâ€ action can take
      // the UI away from the project chat. Download first, then restore the
      // configured project URL before the runner begins the next scene.
      try {
        await this.restoreProjectChatContext(`after-download:${filename}`);
      } catch (error) {
        this.log('flow_project_chat_restore_failed', {
          file: destination,
          currentUrl: this.page.url(),
          projectUrl: this.projectUrl,
          error: String(error),
          policy: 'The downloaded result is preserved. The next bind will retry restoring the configured project chat before entering any next prompt.',
        });
      }
    }
  }

  private async downloadMediaSource(destination: string) {
    const state = this.item?.flow_generation as GenerationState;
    if (!state?.source) throw new Error('No exact media source saved for this scene.');
    let bytes: Buffer;
    if (state.source.startsWith('blob:') || state.source.startsWith('data:')) {
      const base64 = await this.page.evaluate(async source => {
        const response = await fetch(source);
        if (!response.ok) throw new Error('Media source download failed.');
        const blob = await response.blob();
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }, state.source);
      bytes = Buffer.from(base64, 'base64');
    } else {
      const response = await this.page.request.get(state.source, { timeout: 120000 });
      if (!response.ok()) throw new Error(`Scene media source download failed (${response.status()}).`);
      bytes = await response.body();
    }
    if (bytes.toString('ascii', 4, 8) !== 'ftyp') {
      throw new Error('Scene media source did not return an MP4. Refusing an invalid result.');
    }
    const temporary = destination + '.tmp';
    await fs.writeFile(temporary, bytes);
    await fs.rename(temporary, destination);
    this.log('downloaded', { file: destination });
  }
}

export async function start(url: string, userDataDir: string, log: (e: string, d?: any) => void) {
  const context = await launchProfile(userDataDir);
  try {
    // Open the target page first, then close older tabs in this automation context.
    const page = await context.newPage();
    const oldPages = context.pages().filter(existingPage => existingPage !== page);
    log('closing_existing_tabs', {
      count: oldPages.length,
      urls: oldPages.map(existingPage => existingPage.url()),
    });
    for (const oldPage of oldPages) {
      try {
        await oldPage.close();
      } catch (error) {
        log('tab_close_warning', { error: String(error) });
      }
    }

    log('opening_flow_url', { url });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log('waiting_for_flow_ready', {
      url: page.url(),
      message: 'Complete Google sign-in or verification here if prompted. Automation will wait.',
    });

    const ready = page.locator(S.addMedia.join(',')).or(
      page.getByRole('button', { name: /New project/i }),
    ).first();
    await ready.waitFor({ state: 'visible', timeout: 600000 });

    const current = new URL(page.url());
    const alreadyInProject =
      current.hostname === 'flow.google.com' &&
      /^\/project\/[^/]+\/?$/.test(current.pathname);
    const newProjectButton = page.getByRole('button', { name: /New project/i });

    log('flow_project_context', {
      url: page.url(),
      alreadyInProject,
    });

    // Do not create a new project while resuming a saved project URL.
    if (!alreadyInProject && await newProjectButton.isVisible().catch(() => false)) {
      await newProjectButton.click();
      await page.locator(S.addMedia.join(',')).first().waitFor({ state: 'visible', timeout: 60000 });
    }

    log('flow_ready', { url: page.url() });
    return { context, page, flow: new FlowClient(page, log, url) };
  } catch (error) {
    await context.close();
    throw error;
  }
}
