import type { Page, Locator } from 'playwright';
import type { Item } from './types.js';

export class FlowGenerationQueuedError extends Error {
  constructor(
    message = 'Flow has not produced this generation yet. Submission saved; resume this project without regenerating.'
  ) {
    super(message);
    this.name = 'FlowGenerationQueuedError';
  }
}

export type FlowActionKind =
  | 'missing_reference'
  | 'clarification'
  | 'approval_button_missing';

/** A safe pause when Flow asks a question or needs an action the runner cannot infer. */
export class FlowActionRequiredError extends Error {
  constructor(
    readonly action: FlowActionKind,
    message: string
  ) {
    super(message);
    this.name = 'FlowActionRequiredError';
  }
}

export interface GenerationState {
  url: string;
  baseline: string[];
  started_at: string;
  phase: 'prepared' | 'submitted' | 'complete';
  source?: string;
  /** Persisted so a resumed run does not click the same approval twice. */
  approval_accepted?: boolean;
  /** The approval text remains in chat history, but its live choice controls disappeared. */
  approval_prompt_resolved?: boolean;
  /** Time the exact media result was confirmed in the Flow project. */
  completed_at?: string;
  /** Sources observed when Flow returned multiple new media results during recovery. */
  recovery_candidate_sources?: string[];
  /** Thumbnail references shown in a Flow video-options gallery during recovery. */
  recovery_candidate_thumbnails?: string[];
  recovery_selection?: string;
  /** Sources already assigned to other pipeline scenes; never reuse them. */
  excluded_sources?: string[];
  /** Specific sources rejected after duplicate-content validation. */
  rejected_sources?: string[];
  /** Scene whose prompt-specific gallery was opened during recovery. */
  recovery_scene_number?: number;
}

export interface FlowChatSummary {
  text: string;
  queue: string | null;
  fail: string | null;
  approval: string | null;
  missingReference: string | null;
  clarification: string | null;
  /** Generic Flow toast that may be transient while an accepted generation is still running. */
  transientError: string | null;
}

function lastMatch(text: string, pattern: RegExp): { index: number; text: string } | null {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  let match: RegExpExecArray | null;
  let latest: { index: number; text: string } | null = null;

  while ((match = regex.exec(text)) !== null) {
    latest = { index: match.index, text: match[0] };
    if (match[0].length === 0) regex.lastIndex++;
  }

  return latest;
}

function lastRelevantLine(lines: string[], pattern: RegExp): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (pattern.test(lines[i])) return lines[i];
  }
  return null;
}

/** Normalize signed Flow URLs to a stable identity so query/signature changes do not bypass deduplication. */
function sourceIdentity(value: string): string {
  const source = String(value ?? '').trim();
  if (!source) return '';
  try {
    const parsed = new URL(source);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return source.split(/[?#]/, 1)[0];
  }
}

interface ScenePromptAnchor {
  prefix: string;
  backgroundTag: string;
  dialogue: string;
  actionSnippet: string;
}

/** Build a unique anchor from the current pipeline scene, not from whichever approval text happens to be last in the chat. */
function scenePromptAnchor(item: Item, kind: 'video' | 'image'): ScenePromptAnchor | undefined {
  if (kind !== 'video') return undefined;
  const scene = item as any;
  const assets = scene.assets ?? {};
  const backgroundTag = String(assets.background_tag ?? scene.background_tag ?? '').trim();
  const prompt = String(
    scene.speaker === 'NARRATOR' || scene.speaker === 'none'
      ? (scene.animation_prompt_NARRATOR_ONLY ?? '')
      : (scene.animation_prompt_WITH_lipsync ?? '')
  );
  let dialogue = String(scene.devanagari_dialogue ?? '').trim();
  if (!dialogue) {
    const dialogueMatch = prompt.match(/DIALOGUE\s*\(DEVANAGARI ONLY\)\s*:\s*[\"ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“']([\s\S]*?)[\"ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â']\s*(?:SOUND DESIGN:|### NEGATIVE|$)/i);
    dialogue = String(dialogueMatch?.[1] ?? '').trim();
  }
  const actionMatch = prompt.match(/SCENE ACTION:\s*([\s\S]*?)(?:\s+CAMERA:|$)/i);
  const actionSnippet = String(actionMatch?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
  if (!backgroundTag || (!dialogue && actionSnippet.length < 20)) return undefined;
  return {
    prefix: 'Generate exactly one 16:9 VIDEO scene using the saved reference assets',
    backgroundTag,
    dialogue,
    actionSnippet,
  };
}

/**
 * Flow's chat may virtualize older transcript bubbles. When resuming an already
 * approved/submitted scene, search backward through chat history for the exact
 * scene prompt and its associated permission/gallery block. This only scrolls
 * the existing transcript; it never submits a prompt or clicks an approval.
 */
async function ensureScenePromptHistoryLoaded(
  page: Page,
  item: Item,
  log: (event: string, data?: any) => void,
  maxSteps = 40,
): Promise<{ found: boolean; steps: number; bubbleCount: number; anchorFound: boolean }> {
  const anchor = scenePromptAnchor(item, 'video');
  const label = String((item as any).tag ?? (item as any).scene_number ?? 'unknown');
  if (!anchor) return { found: false, steps: 0, bubbleCount: 0, anchorFound: false };

  let lastBubbleCount = 0;
  let lastAnchorFound = false;
  let attemptedSteps = 0;
  for (let step = 0; step <= maxSteps; step++) {
    attemptedSteps = step;
    const scanner = String.raw`(input) => {
      const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const bubbles = Array.from(document.querySelectorAll('flow-chat-bubble'));
      const anchor = input.anchor;
      const targetMatches = (text) => {
        const normalized = normalize(text);
        if (!normalized.includes(normalize(anchor.prefix)) || !normalized.includes(normalize(anchor.backgroundTag))) return false;
        const dialogue = normalize(anchor.dialogue);
        const action = normalize(anchor.actionSnippet);
        if (dialogue && normalized.includes(dialogue)) return true;
        return Boolean(action && action.length >= 20 && normalized.includes(action));
      };
      const bubbleText = (bubble) => bubble.innerText || bubble.textContent || '';
      let targetIndex = -1;
      for (let i = 0; i < bubbles.length; i++) if (targetMatches(bubbleText(bubbles[i]))) targetIndex = i;

      const isScenePrompt = (text) => normalize(text).includes(normalize(anchor.prefix));
      let nextPromptIndex = bubbles.length;
      if (targetIndex >= 0) {
        for (let i = targetIndex + 1; i < bubbles.length; i++) {
          const text = bubbleText(bubbles[i]);
          if (isScenePrompt(text) && !targetMatches(text)) { nextPromptIndex = i; break; }
        }
      }
      const bubbleIndexForNode = (node) => {
        for (let i = bubbles.length - 1; i >= 0; i--) if (bubbles[i] === node || bubbles[i].contains(node)) return i;
        return -1;
      };
      let hasPermission = false;
      for (const node of Array.from(document.querySelectorAll('flow-permission-message'))) {
        const idx = bubbleIndexForNode(node);
        if (targetIndex >= 0 && idx >= targetIndex && idx < nextPromptIndex && /would you like me to kick off/i.test(node.textContent || '')) {
          hasPermission = true; break;
        }
      }
      let hasGallery = false;
      for (const node of Array.from(document.querySelectorAll('flow-a2ui-multiple-choice'))) {
        const idx = bubbleIndexForNode(node);
        const inBubbleSegment = idx >= targetIndex && idx < nextPromptIndex;
        const targetBubble = targetIndex >= 0 ? bubbles[targetIndex] : null;
        const nextBubble = nextPromptIndex < bubbles.length ? bubbles[nextPromptIndex] : null;
        const inDomSegment = idx < 0 && targetBubble &&
          (targetBubble.contains(node) || Boolean(targetBubble.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) &&
          (!nextBubble || nextBubble.contains(node) || Boolean(node.compareDocumentPosition(nextBubble) & Node.DOCUMENT_POSITION_FOLLOWING));
        if (targetIndex >= 0 && (inBubbleSegment || inDomSegment) && node.querySelector('flow-a2ui-video-option img.video-thumbnail')) {
          hasGallery = true; break;
        }
      }
      if (targetIndex >= 0 && hasGallery) {
        return { found: true, anchorFound: true, bubbleCount: bubbles.length, targetIndex, hasPermission, hasGallery, scrolled: false, steps: 0 };
      }

      const scrollCandidates = [];
      const all = Array.from(document.querySelectorAll('*'));
      const root = document.scrollingElement;
      if (root && root.scrollHeight > root.clientHeight + 8) all.push(root);
      const seen = new Set();
      for (const el of all) {
        if (!el || seen.has(el)) continue;
        seen.add(el);
        if (el !== root) {
          const style = window.getComputedStyle(el);
          if (!/(auto|scroll|overlay)/i.test(style.overflowY)) continue;
        }
        const range = el.scrollHeight - el.clientHeight;
        if (range <= 8 || el.clientHeight < 80) continue;
        const bubbleCount = el.querySelectorAll('flow-chat-bubble').length;
        if (bubbleCount === 0) continue;
        const style = window.getComputedStyle(el);
        let reverse = style.flexDirection === 'column-reverse';
        let parent = el.parentElement;
        for (let n = 0; !reverse && parent && n < 3; n++, parent = parent.parentElement) {
          reverse = window.getComputedStyle(parent).flexDirection === 'column-reverse';
        }
        scrollCandidates.push({ el, bubbleCount, range, top: el.scrollTop, reverse });
      }
      scrollCandidates.sort((a, b) => b.bubbleCount - a.bubbleCount || b.range - a.range);
      const deltaFor = (candidate) => Math.max(300, Math.floor(candidate.el.clientHeight * 0.75));
      for (const candidate of scrollCandidates) {
        const delta = deltaFor(candidate);
        const before = candidate.el.scrollTop;
        let next = before;
        if (candidate.reverse) {
          const lowerBound = -candidate.range;
          if (before > lowerBound + 2) next = Math.max(lowerBound, before - delta);
        } else if (before > 2) {
          next = Math.max(0, before - delta);
        }
        if (next !== before) {
          candidate.el.scrollTop = next;
          return {
            found: false, anchorFound: targetIndex >= 0, bubbleCount: bubbles.length,
            targetIndex, hasPermission, hasGallery, scrolled: true,
            before, after: candidate.el.scrollTop, scrollDelta: delta,
          };
        }
      }
      return { found: false, anchorFound: targetIndex >= 0, bubbleCount: bubbles.length, targetIndex, hasPermission, hasGallery, scrolled: false };
    }`; const scan = await page.evaluate(`(${scanner})(${JSON.stringify({ anchor })})`) as { found: boolean; anchorFound: boolean; bubbleCount: number; targetIndex?: number; hasPermission?: boolean; hasGallery?: boolean; scrolled: boolean; before?: number; after?: number; scrollDelta?: number };

    if (!scan || typeof scan !== 'object') throw new Error('Flow chat history scan returned no result from page.evaluate.');
    lastBubbleCount = scan.bubbleCount ?? lastBubbleCount;
    lastAnchorFound = scan.anchorFound ?? lastAnchorFound;
    if (scan.found) {
      log('scene_prompt_history_loaded', {
        label, steps: step, bubbleCount: scan.bubbleCount,
        hasPermission: scan.hasPermission, hasGallery: scan.hasGallery,
        policy: 'Located this exact scene prompt and its permission/gallery in the existing chat history. No prompt was submitted and no approval was clicked by the history scan.',
      });
      return { found: true, steps: step, bubbleCount: scan.bubbleCount, anchorFound: true };
    }
    if (!scan.scrolled) break;
    await page.waitForTimeout(450);
  }

  return { found: false, steps: attemptedSteps, bubbleCount: lastBubbleCount, anchorFound: lastAnchorFound };
}
/** Find the permission card that follows this exact scene prompt and precedes the next scene prompt. */
async function locateScenePermissionCard(
  page: Page,
  item: Item,
): Promise<{ index: number; text: string } | undefined> {
  const anchor = scenePromptAnchor(item, 'video');
  if (!anchor) return undefined;
  const hit = await page.evaluate((input) => {
    const normalize = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const bubbles = Array.from(document.querySelectorAll('flow-chat-bubble'));
    const isScenePrompt = (text: string) => normalize(text).includes(normalize(input.prefix));
    const targetMatches = (text: string) => {
      const normalized = normalize(text);
      if (!normalized.includes(normalize(input.prefix)) || !normalized.includes(normalize(input.backgroundTag))) return false;
      const dialogue = normalize(input.dialogue);
      const action = normalize(input.actionSnippet);
      if (dialogue && normalized.includes(dialogue)) return true;
      return Boolean(action && action.length >= 20 && normalized.includes(action));
    };
    let targetIndex = -1;
    for (let i = 0; i < bubbles.length; i++) {
      const text = (bubbles[i] as HTMLElement).innerText || bubbles[i].textContent || '';
      if (targetMatches(text)) targetIndex = i;
    }
    if (targetIndex < 0) return null;
    let nextPromptIndex = bubbles.length;
    for (let i = targetIndex + 1; i < bubbles.length; i++) {
      const text = (bubbles[i] as HTMLElement).innerText || bubbles[i].textContent || '';
      if (isScenePrompt(text) && !targetMatches(text)) {
        nextPromptIndex = i;
        break;
      }
    }
    const bubbleIndexForNode = (node: Element) => {
      for (let i = bubbles.length - 1; i >= 0; i--) {
        if (bubbles[i] === node || bubbles[i].contains(node)) return i;
      }
      return -1;
    };
    const permissions = Array.from(document.querySelectorAll('flow-permission-message'));
    let chosen: { index: number; text: string } | null = null;
    for (let i = 0; i < permissions.length; i++) {
      const node = permissions[i];
      const text = ((node as HTMLElement).innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      const bubbleIndex = bubbleIndexForNode(node);
      if (bubbleIndex < targetIndex || bubbleIndex >= nextPromptIndex) continue;
      if (!/would you like me to kick off/i.test(text) || !/costing\s+\d[\d,]*\s+credits?/i.test(text)) continue;
      chosen = { index: i, text };
    }
    return chosen;
  }, anchor).catch(() => null);
  if (!hit || !Number.isInteger(hit.index) || hit.index < 0) return undefined;
  return { index: hit.index, text: String(hit.text ?? '') };
}

/** Return only playable sources located inside the current scene's own chat segment. */
async function sceneScopedVideoSources(page: Page, item: Item): Promise<string[]> {
  const anchor = scenePromptAnchor(item, 'video');
  if (!anchor) return [];
  return page.locator('video').evaluateAll((elements, input) => {
    const normalize = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const bubbles = Array.from(document.querySelectorAll('flow-chat-bubble'));
    const isScenePrompt = (text: string) => normalize(text).includes(normalize(input.prefix));
    const targetMatches = (text: string) => {
      const normalized = normalize(text);
      if (!normalized.includes(normalize(input.prefix)) || !normalized.includes(normalize(input.backgroundTag))) return false;
      const dialogue = normalize(input.dialogue);
      const action = normalize(input.actionSnippet);
      if (dialogue && normalized.includes(dialogue)) return true;
      return Boolean(action && action.length >= 20 && normalized.includes(action));
    };
    let targetIndex = -1;
    for (let i = 0; i < bubbles.length; i++) {
      const text = (bubbles[i] as HTMLElement).innerText || bubbles[i].textContent || '';
      if (targetMatches(text)) targetIndex = i;
    }
    if (targetIndex < 0) return [];
    let nextPromptIndex = bubbles.length;
    for (let i = targetIndex + 1; i < bubbles.length; i++) {
      const text = (bubbles[i] as HTMLElement).innerText || bubbles[i].textContent || '';
      if (isScenePrompt(text) && !targetMatches(text)) {
        nextPromptIndex = i;
        break;
      }
    }
    const bubbleIndexForNode = (node: Element) => {
      for (let i = bubbles.length - 1; i >= 0; i--) {
        if (bubbles[i] === node || bubbles[i].contains(node)) return i;
      }
      return -1;
    };
    const results: string[] = [];
    for (const element of elements) {
      const video = element as HTMLVideoElement;
      const bubbleIndex = bubbleIndexForNode(video);
      const inBubbleSegment = bubbleIndex >= targetIndex && bubbleIndex < nextPromptIndex;
      const targetBubble = targetIndex >= 0 ? bubbles[targetIndex] : null;
      const nextBubble = nextPromptIndex < bubbles.length ? bubbles[nextPromptIndex] : null;
      const inDomSegment = bubbleIndex < 0 && targetBubble &&
        (targetBubble.contains(video) || Boolean(targetBubble.compareDocumentPosition(video) & Node.DOCUMENT_POSITION_FOLLOWING)) &&
        (!nextBubble || nextBubble.contains(video) || Boolean(video.compareDocumentPosition(nextBubble) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (!inBubbleSegment && !inDomSegment) continue;
      const childSource = video.querySelector('source[src]') as HTMLSourceElement | null;
      const source = video.currentSrc || video.src || video.getAttribute('src') || childSource?.src || childSource?.getAttribute('src') || '';
      if (source) results.push(source);
    }
    return results;
  }, anchor).catch(() => []);
}

export async function flowChatSummary(page: Page): Promise<FlowChatSummary> {
  const body = page.locator('body');
  const normalized = (await body.innerText()).replace(/\s+/g, ' ').trim();
  const chunks = normalized
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
  const relevant = chunks.filter(s =>
    /queue|queued|high demand|scheduled|verification|approve|failed|error|retry|waiting|generation|download|complete|ready|reference asset|couldn't find|could not find|something went wrong|would you like|do you want|should i/i.test(s)
  );
  const recent = relevant.slice(-24);
  const summaryText = recent.slice(-20).join(' | ') || normalized.slice(-700);

  // A standalone UI badge such as "movie Queued" is not an assistant reply.
  // Match only sentence-like queue statements, not any appearance of the word.
  const queue = lastRelevantLine(
    recent,
    /\b(?:movie|video|image)\s+queued\b|(?:the\s+)?(?:generation|video|image|request|job|task)\s+(?:is\s+)?(?:now\s+)?(?:queued|in\s+queue|waiting in line)|(?:added|placed|put)\s+(?:the\s+)?(?:generation|video|image|request|job|task)\s+(?:to|in)\s+(?:the\s+)?queue|(?:you are|you're)\s+(?:now\s+)?in\s+(?:the\s+)?queue|high demand[^.!?]{0,120}(?:queue|wait)/i
  );

  const approvalMatch = lastMatch(
    normalized,
    /would you like me to kick off[^?]{0,360}?\bcosting\s+\d[\d,]*\s+credits?\??/ig
  );

  // Flow sometimes displays a transient generic toast (ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“Something went wrongÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â)
  // even while the accepted request continues and produces media. Do not treat
  // that toast, a bare ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“errorÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â, or ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“retryÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â text in the transcript as terminal.
  // Only specific generation-failure statements occurring after the latest
  // credit request are terminal; otherwise keep watching for real media until
  // the configured queue timeout.
  const terminalFailure = lastMatch(
    normalized,
    /(?:generation|video|image|request|task|job)\s+(?:has\s+)?(?:failed|was\s+rejected|was\s+blocked|was\s+cancelled|has\s+been\s+cancelled)|(?:failed\s+to|unable\s+to|could not|couldn['ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢]t|cannot|can['ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢]t)\s+(?:generate|create|render|process)\b[^.!?]{0,140}|(?:your|this)\s+(?:prompt|request|generation|video|image)\s+(?:was|has been)\s+(?:blocked|rejected|cancelled|failed)[^.!?]{0,120}|(?:content|safety)\s+policy\s+(?:violation|rejection|block)[^.!?]{0,120}/ig
  );
  const fail = terminalFailure && (!approvalMatch || terminalFailure.index > approvalMatch.index)
    ? terminalFailure.text
    : null;

  const transientErrorMatch = lastMatch(normalized, /something went wrong/ig);
  const transientError = transientErrorMatch && (!approvalMatch || transientErrorMatch.index > approvalMatch.index)
    ? transientErrorMatch.text
    : null;

  const missingMatch = lastMatch(
    normalized,
    /(?:i couldn't find|i could not find|i can't find|i cannot find|missing)\s+(?:the\s+)?(?:character\s+)?(?:reference\s+)?(?:asset|image|reference)[^.!?]{0,220}|(?:i(?:'ll| will) need|we(?:'ll| will) need)\s+[^.!?]{0,140}reference(?:\s+asset|\s+image)?[^.!?]{0,100}/ig
  );

  // Resolve only a statement that explicitly names the same missing asset.
  // A generic older message saying another reference is ready must not hide a
  // newer "couldn't find @CHAR-..." error.
  const missingTag = missingMatch?.text.match(/@?(?:CHAR-\d{2}-[A-Z0-9-]+|BGD-\d{2}-[A-Z0-9-]+)/i)?.[0];
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const taggedMissingAsset = missingTag?.replace(/^@/, '');
  const referenceResolved = taggedMissingAsset
    ? lastMatch(
        normalized,
        new RegExp(
          `(?:i have generated|i've generated|i generated|i have saved|i've saved|i saved|generated and saved|created and saved|the reference (?:is|has been) saved|the reference is ready|ready to reuse|ready to use)[^.!?]{0,260}@?${escapeRegExp(taggedMissingAsset)}[^.!?]{0,100}`,
          'ig'
        )
      )
    : lastMatch(
        normalized,
        /(?:i have generated|i've generated|i generated|i have saved|i've saved|i saved|generated and saved|created and saved|the reference (?:is|has been) saved|the reference is ready|ready to reuse|ready to use)[^.!?]{0,220}/ig
      );

  const questionMatch = lastMatch(
    normalized,
    /(?:would you like me to|would you like to|do you want me to|should i|could you|can you)[^?]{0,260}\?/ig
  );

  // A missing-reference statement is actionable only if Flow has not later
  // said that the reference was generated/saved. Historical questions remain
  // in the transcript after they have been resolved.
  const missingReference = missingMatch &&
    (!referenceResolved || missingMatch.index > referenceResolved.index)
      ? missingMatch.text
      : null;

  // Credit confirmation is handled separately by the explicit Approve button.
  // Do not misclassify that confirmation as an ordinary clarification question.
  const clarification = questionMatch &&
    (!approvalMatch || questionMatch.index > approvalMatch.index) &&
    (!referenceResolved || questionMatch.index > referenceResolved.index)
      ? questionMatch.text
      : null;

  return {
    text: summaryText,
    queue,
    fail,
    approval: approvalMatch?.text ?? null,
    missingReference,
    clarification,
    transientError,
  };
}

/**
 * Find approval controls only inside the latest exact Flow permission card.
 * Flow leaves older permission cards in the chat transcript as read-only radio
 * groups. Text-only descendants such as <span>Approve</span> are never actions.
 */
async function explicitApprovalButton(
  page: Page,
  expectedApprovalText?: string,
  item?: Item,
  kind?: 'video' | 'image'
): Promise<{
  button?: Locator;
  diagnostics: string[];
  promptText?: string;
  liveChoices: boolean;
  promptResolved: boolean;
}> {
  const diagnostics: string[] = [];
  const normalize = (value: string) => value
    .replace(/\b(check_circle_outline|check_circle|task_alt|verified|check|done|close|thumb_up|thumb_down)\b/gi, ' ')
    .replace(/[ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã¢â‚¬Å“ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã¢â‚¬Å“ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÆ’Ã‚Â¢Ãƒâ€¹Ã…â€œÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const bodyText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const promptPattern = /would you like me to kick off[^?]{0,360}?\bcosting\s+\d[\d,]*\s+credits?\??/ig;
  const pagePrompts = [...bodyText.matchAll(promptPattern)].map(match => match[0]);
  const expected = String(expectedApprovalText ?? '').replace(/\s+/g, ' ').trim();
  let promptText: string | undefined;
  let card: Locator | undefined;
  const permissionCards = page.locator('flow-permission-message');

  if (kind === 'video' && item) {
    const scenePermission = await locateScenePermissionCard(page, item);
    if (!scenePermission) {
      return {
        diagnostics: ['Could not associate an approval card with the current scene prompt; refusing to click a different or historical Approve control.'],
        liveChoices: false,
        promptResolved: false,
      };
    }
    promptText = scenePermission.text;
    if (scenePermission.index < await permissionCards.count()) card = permissionCards.nth(scenePermission.index);
  } else {
    promptText = pagePrompts[pagePrompts.length - 1] ?? (
      expected && /would you like me to kick off/i.test(expected) && /costing\s+\d[\d,]*\s+credits?/i.test(expected)
        ? expected
        : undefined
    );
    if (promptText) {
      const expectedNormalized = normalize(promptText);
      for (let i = await permissionCards.count() - 1; i >= 0; i--) {
        const candidate = permissionCards.nth(i);
        const text = normalize(await candidate.innerText().catch(() => ''));
        if (text.includes(expectedNormalized) && /would you like me to kick off/i.test(text)) {
          card = candidate;
          break;
        }
      }
    }
  }

  if (!promptText) {
    return {
      diagnostics: ['No credit-confirmation text found for the current item in the page transcript.'],
      liveChoices: false,
      promptResolved: false,
    };
  }

  if (!card) {
    diagnostics.push('Credit text exists, but no matching flow-permission-message card was found; refusing to click transcript text.');
    return { diagnostics, promptText, liveChoices: false, promptResolved: false };
  }

  const radios = card.locator('[role="radio"]');
  const radioCount = await radios.count();
  if (radioCount > 0) {
    const labels: string[] = [];
    let approveLocator: Locator | undefined;
    let approveCheckedAndReadOnly = false;
    let everyChoiceReadOnly = true;
    let visibleLiveApprove = false;
    let visibleLiveAlways = false;
    let visibleLiveReject = false;

    for (let i = 0; i < radioCount; i++) {
      const radio = radios.nth(i);
      const label = normalize((await radio.getAttribute('aria-label')) || (await radio.innerText().catch(() => '')));
      const classes = (await radio.getAttribute('class')) || '';
      const ariaDisabled = (await radio.getAttribute('aria-disabled')) === 'true';
      const nativeDisabled = (await radio.getAttribute('disabled')) !== null;
      const tabindex = await radio.getAttribute('tabindex');
      const checked = (await radio.getAttribute('aria-checked')) === 'true';
      const readOnly = /\bread-only\b/i.test(classes) || ariaDisabled || nativeDisabled || tabindex === '-1';
      const visible = await radio.isVisible().catch(() => false);
      const enabled = await radio.isEnabled().catch(() => false);
      labels.push(label);

      if (label === 'approve' && checked && readOnly) approveCheckedAndReadOnly = true;
      if (label === 'approve' || label === 'always approve' || label === 'reject') {
        if (!readOnly || !visible) {
          if (visible && enabled && !readOnly) {
            everyChoiceReadOnly = false;
            if (label === 'approve') {
              visibleLiveApprove = true;
              approveLocator = radio;
            } else if (label === 'always approve') {
              visibleLiveAlways = true;
            } else if (label === 'reject') {
              visibleLiveReject = true;
            }
          }
        }
      }
      if (!readOnly) everyChoiceReadOnly = false;
    }

    const hasThreeExpectedOptions = ['approve', 'always approve', 'reject'].every(label => labels.includes(label));
    const promptResolved = hasThreeExpectedOptions && everyChoiceReadOnly && approveCheckedAndReadOnly;
    const liveChoices = visibleLiveApprove && visibleLiveAlways && visibleLiveReject;

    if (approveLocator && await approveLocator.count() === 1) {
      diagnostics.push(`Found actionable one-time Approve radio inside the latest matching permission card; prompt="${promptText}"`);
      return { button: approveLocator, diagnostics, promptText, liveChoices, promptResolved: false };
    }

    diagnostics.push(promptResolved
      ? 'Latest matching permission card is already resolved: Approve is selected and all permission radios are read-only. No approval click is needed.'
      : `No actionable Approve radio in the latest matching permission card; labels=${JSON.stringify(labels)}; liveChoices=${liveChoices}.`);
    return { diagnostics, promptText, liveChoices, promptResolved };
  }

  // Safety-first: this Flow UI renders permission actions as role=radio. If a
  // future UI uses a different structure, pause instead of clicking a generic
  // text span that may belong to historical chat content.
  diagnostics.push('Matching permission card has no role=radio controls; refusing to click a generic Approve text node.');
  return { diagnostics, promptText, liveChoices: false, promptResolved: false };
}

interface VideoGalleryOption {
  index: number;
  thumbnail: string;
  alt: string;
}

interface VideoGalleryInfo {
  galleryIndex: number;
  options: VideoGalleryOption[];
}

/**
 * Finds the video-choice gallery in the chat segment associated with the exact
 * current scene prompt. Thumbnail URLs are not downloadable MP4 files; the
 * caller opens one matching option and waits for a playable source.
 */
async function latestVideoGalleryOptions(
  page: Page,
  expectedApprovalText?: string,
  item?: Item
): Promise<VideoGalleryInfo | undefined> {
  const anchor = item ? scenePromptAnchor(item, 'video') : undefined;
  const prompt = String(expectedApprovalText ?? '').replace(/\s+/g, ' ').trim();
  const result = await page.evaluate((input) => {
    const normalize = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const permissionNodes = Array.from(document.querySelectorAll('flow-permission-message'));
    const galleries = Array.from(document.querySelectorAll('flow-a2ui-multiple-choice'));
    const bubbles = Array.from(document.querySelectorAll('flow-chat-bubble'));
    let latestPermission: Element | null = null;
    let nextPromptIndex = bubbles.length;
    let targetBubbleIndex = -1;
    const bubbleIndexForNode = (node: Element) => {
      for (let i = bubbles.length - 1; i >= 0; i--) {
        if (bubbles[i] === node || bubbles[i].contains(node)) return i;
      }
      return -1;
    };

    if (input.anchor) {
      const a = input.anchor;
      const isScenePrompt = (text: string) => normalize(text).includes(normalize(a.prefix));
      const targetMatches = (text: string) => {
        const normalized = normalize(text);
        if (!normalized.includes(normalize(a.prefix)) || !normalized.includes(normalize(a.backgroundTag))) return false;
        const dialogue = normalize(a.dialogue);
        const action = normalize(a.actionSnippet);
        if (dialogue && normalized.includes(dialogue)) return true;
        return Boolean(action && action.length >= 20 && normalized.includes(action));
      };
      for (let i = 0; i < bubbles.length; i++) {
        const text = (bubbles[i] as HTMLElement).innerText || bubbles[i].textContent || '';
        if (targetMatches(text)) targetBubbleIndex = i;
      }
      if (targetBubbleIndex < 0) return null;
      for (let i = targetBubbleIndex + 1; i < bubbles.length; i++) {
        const text = (bubbles[i] as HTMLElement).innerText || bubbles[i].textContent || '';
        if (isScenePrompt(text) && !targetMatches(text)) {
          nextPromptIndex = i;
          break;
        }
      }
      let chosenPermissionIndex = -1;
      for (let i = 0; i < permissionNodes.length; i++) {
        const node = permissionNodes[i];
        const style = window.getComputedStyle(node);
        if (!node.getClientRects().length || style.visibility === 'hidden' || style.display === 'none') continue;
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        const bubbleIndex = bubbleIndexForNode(node);
        const inBubbleSegment = bubbleIndex >= targetBubbleIndex && bubbleIndex < nextPromptIndex;
        const targetBubble = targetBubbleIndex >= 0 ? bubbles[targetBubbleIndex] : null;
        const nextBubble = nextPromptIndex < bubbles.length ? bubbles[nextPromptIndex] : null;
        const inDomSegment = bubbleIndex < 0 && targetBubble &&
          (targetBubble.contains(node) || Boolean(targetBubble.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) &&
          (!nextBubble || nextBubble.contains(node) || Boolean(node.compareDocumentPosition(nextBubble) & Node.DOCUMENT_POSITION_FOLLOWING));
        if (!inBubbleSegment && !inDomSegment) continue;
        if (!/would you like me to kick off/i.test(text) || !/costing\s+\d[\d,]*\s+credits?/i.test(text)) continue;
        chosenPermissionIndex = i;
        latestPermission = node;
      }
      if (!latestPermission || chosenPermissionIndex < 0) return null;
    } else {
      const expected = normalize(input.prompt);
      if (!expected) return null;
      for (let i = 0; i < permissionNodes.length; i++) {
        const node = permissionNodes[i];
        const style = window.getComputedStyle(node);
        if (!node.getClientRects().length || style.visibility === 'hidden' || style.display === 'none') continue;
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (text.includes(expected) && text.includes('would you like me to kick off')) latestPermission = node;
      }
      if (!latestPermission) return null;
    }

    let chosenGalleryIndex = -1;
    let chosenOptions: Array<{ index: number; thumbnail: string; alt: string }> = [];
    for (let g = 0; g < galleries.length; g++) {
      const gallery = galleries[g];
      const style = window.getComputedStyle(gallery);
      if (!gallery.getClientRects().length || style.visibility === 'hidden' || style.display === 'none') continue;
      const permissionRelation = latestPermission!.compareDocumentPosition(gallery);
      const permissionBeforeGallery = Boolean(permissionRelation & Node.DOCUMENT_POSITION_FOLLOWING) || latestPermission!.contains(gallery);
      if (!permissionBeforeGallery) continue;
      if (input.anchor) {
        const bubbleIndex = bubbleIndexForNode(gallery);
        const inBubbleSegment = bubbleIndex >= targetBubbleIndex && bubbleIndex < nextPromptIndex;
        const targetBubble = targetBubbleIndex >= 0 ? bubbles[targetBubbleIndex] : null;
        const nextBubble = nextPromptIndex < bubbles.length ? bubbles[nextPromptIndex] : null;
        const inDomSegment = bubbleIndex < 0 && targetBubble &&
          (targetBubble.contains(gallery) || Boolean(targetBubble.compareDocumentPosition(gallery) & Node.DOCUMENT_POSITION_FOLLOWING)) &&
          (!nextBubble || nextBubble.contains(gallery) || Boolean(gallery.compareDocumentPosition(nextBubble) & Node.DOCUMENT_POSITION_FOLLOWING));
        if (!inBubbleSegment && !inDomSegment) continue;
      }
      const cards = gallery.querySelectorAll('flow-a2ui-video-option');
      const options: Array<{ index: number; thumbnail: string; alt: string }> = [];
      for (let c = 0; c < cards.length; c++) {
        const card = cards[c];
        const cardStyle = window.getComputedStyle(card);
        if (!card.getClientRects().length || cardStyle.visibility === 'hidden' || cardStyle.display === 'none') continue;
        const image = card.querySelector('img.video-thumbnail') as HTMLImageElement | null;
        if (!image) continue;
        const imageStyle = window.getComputedStyle(image);
        if (!image.getClientRects().length || imageStyle.visibility === 'hidden' || imageStyle.display === 'none') continue;
        options.push({
          index: c,
          thumbnail: image.currentSrc || image.src || image.getAttribute('src') || '',
          alt: image.alt || '',
        });
      }
      if (options.length > 0) {
        chosenGalleryIndex = g;
        chosenOptions = options;
      }
    }
    if (chosenGalleryIndex < 0 || chosenOptions.length === 0) return null;
    return { galleryIndex: chosenGalleryIndex, options: chosenOptions };
  }, { prompt, anchor: anchor ?? null }).catch(() => null);

  if (!result || !result.options?.length) return undefined;
  return result as VideoGalleryInfo;
}

/**
 * Opens the first option in the latest result gallery for the approved prompt.
 * This is a UI selection only; it does not submit a prompt or start a new job.
 * Completion is still gated on observing a real video source afterwards.
 */
async function openLatestVideoGalleryOption(
  page: Page,
  state: GenerationState,
  promptText: string | undefined,
  save: () => Promise<void>,
  log: (event: string, data?: any) => void,
  item: Item
): Promise<boolean> {
  const gallery = await latestVideoGalleryOptions(page, promptText, item);
  if (!gallery || !gallery.options.length) return false;

  const selected = gallery.options[0];
  if (!selected.thumbnail) return false;
  const galleries = page.locator('flow-a2ui-multiple-choice');
  if (gallery.galleryIndex >= await galleries.count()) return false;
  const card = galleries.nth(gallery.galleryIndex).locator('flow-a2ui-video-option').nth(selected.index);
  const openButton = card.locator('[role="button"][aria-label="Open video in editor"]');
  const target = await openButton.count() === 1 ? openButton : card;
  if (!(await target.isVisible().catch(() => false)) || !(await target.isEnabled().catch(() => false))) return false;

  state.recovery_candidate_thumbnails = gallery.options.map(option => option.thumbnail).filter(Boolean);
  state.recovery_selection = 'first-option-in-current-scene-gallery';
  const recoverySceneNumber = Number((item as any).scene_number);
  if (Number.isFinite(recoverySceneNumber)) state.recovery_scene_number = recoverySceneNumber;
  await save();
  log('generation_video_option_open_attempt', {
    label: String((item as any).tag ?? (item as any).scene_number ?? 'unknown'),
    galleryIndex: gallery.galleryIndex,
    optionIndex: selected.index,
    optionCount: gallery.options.length,
    thumbnail: selected.thumbnail,
    alt: selected.alt.slice(0, 240),
    policy: 'Open the first option in the gallery associated with this exact scene prompt; no prompt is submitted and no credits are spent by this selection action.',
  });

  const urlBeforeOpen = page.url();
  await target.click({ timeout: 5000 });
  await page.waitForTimeout(300);
  const urlAfterOpen = page.url();
  log('generation_video_option_opened', {
    label: String((item as any).tag ?? (item as any).scene_number ?? 'unknown'),
    optionIndex: selected.index,
    urlBeforeOpen,
    urlAfterOpen,
    routeChanged: urlBeforeOpen !== urlAfterOpen,
    message: 'Flow may open a separate editor view for the selected clip. The source is captured for download, then FlowClient restores the canonical project chat URL before the next scene.',
  });
  return true;
}

export async function verifyGenerationState(
  page: Page,
  state: GenerationState,
  kind: 'video' | 'image',
  item: Item,
  log: (event: string, data?: any) => void,
  save: () => Promise<void>
) {
  const current = await mediaSources(page, kind);
  const baseline = new Set((state.baseline ?? []).map(sourceIdentity));
  const excluded = new Set([...(state.excluded_sources ?? []), ...(state.rejected_sources ?? [])].map(sourceIdentity));
  const newSources = [...new Set(current.filter(src => src && !baseline.has(sourceIdentity(src)) && !excluded.has(sourceIdentity(src))))];
  const chat = await flowChatSummary(page);

  if (chat.fail) {
    throw new Error(`Flow page reported an issue: ${chat.fail}`);
  }
  // Queue/status badges may remain visible while Flow is generating. Do not
  // terminate the wait loop here; waitGeneration keeps polling for new media
  // and reports a pending queue only if its configured timeout expires.
  if (state.source && state.source.startsWith('http')) {
    const sourceKey = sourceIdentity(state.source);
    const pageHasSavedSource = current.some(src => sourceIdentity(src) === sourceKey);
    if (excluded.has(sourceKey)) {
      log('generation_source_rejected_duplicate', {
        label: String((item as any).tag ?? (item as any).scene_number ?? 'unknown'),
        source: state.source,
        policy: 'This source is already assigned to another scene; it cannot be accepted for the current scene.',
      });
      state.source = undefined;
      state.phase = 'submitted';
      delete state.completed_at;
    } else if (!pageHasSavedSource && newSources.length > 0 && !newSources.some(src => sourceIdentity(src) === sourceKey)) {
      throw new Error(`Saved generation source no longer matches the current Flow page. Browser shows a different result for item ${String((item as any).tag ?? (item as any).scene_number ?? 'unknown')}.`);
    }
  }
  if (state.phase === 'complete' && (!state.source || !current.some(src => sourceIdentity(src) === sourceIdentity(state.source!)))) {
    throw new Error('Saved generation marked complete, but the browser did not confirm the same media source. Item needs recovery or retry.');
  }

  if (chat.text && /generate|ready|approve|reference/i.test(chat.text)) {
    log('flow_page_verified', { message: chat.text });
  }
  await save();
}

export async function mediaSources(page: Page, kind: 'video' | 'image'): Promise<string[]> {
  return page.locator(kind === 'video' ? 'video' : 'main img, [data-generation-state] img').evaluateAll(elements =>
    elements.map(el => {
      if (el instanceof HTMLVideoElement) {
        const childSource = el.querySelector('source[src]') as HTMLSourceElement | null;
        return el.currentSrc || el.src || el.getAttribute('src') || childSource?.src || childSource?.getAttribute('src') || '';
      }
      const image = el as HTMLImageElement;
      return image.currentSrc || image.src || image.getAttribute('src') || '';
    }).filter(Boolean)
  );
}

export async function generationResult(
  page: Page,
  state: GenerationState,
  kind: 'video' | 'image',
  log?: (event: string, data?: any) => void,
  item?: Item,
  allowFreshCandidates = false,
  galleryOptionOpenedThisWait = false
): Promise<Locator | undefined> {
  const sources = await mediaSources(page, kind);
  const baseline = new Set((state.baseline ?? []).map(sourceIdentity));
  const excluded = new Set([...(state.excluded_sources ?? []), ...(state.rejected_sources ?? [])].map(sourceIdentity));
  const label = String((item as any)?.tag ?? (item as any)?.scene_number ?? 'unknown');

  let source = state.source;
  if (source && excluded.has(sourceIdentity(source))) {
    log?.('generation_source_rejected_duplicate', {
      label,
      source,
      excludedSourceCount: excluded.size,
      policy: 'Reject a persisted source assigned to another scene and recover the current scene from its own prompt-specific gallery.',
    });
    state.source = undefined;
    state.phase = 'submitted';
    delete state.completed_at;
    source = undefined;
  }
  if (source && (!sources.some(candidate => sourceIdentity(candidate) === sourceIdentity(source!)) ||
      (baseline.has(sourceIdentity(source)) && state.phase !== 'complete'))) {
    if (state.source === source) {
      state.source = undefined;
      if (state.phase === 'complete') state.phase = 'submitted';
      delete state.completed_at;
    }
    source = undefined;
  }

  const isVideoEditorRoute = kind === 'video' &&
    /\/project\/[^/]+\/edit\/[^/]+\/?$/.test(new URL(page.url()).pathname);
  const scopedSources = kind === 'video' && item && !isVideoEditorRoute
    ? await sceneScopedVideoSources(page, item)
    : sources;
  const candidates = [...new Map(
    scopedSources
      .filter(candidate => candidate && !baseline.has(sourceIdentity(candidate)) && !excluded.has(sourceIdentity(candidate)))
      .map(candidate => [sourceIdentity(candidate), candidate] as const)
  ).values()];
  const selectedForThisScene = galleryOptionOpenedThisWait && kind === 'video' &&
    state.recovery_selection === 'first-option-in-current-scene-gallery' &&
    Number(state.recovery_scene_number) === Number((item as any)?.scene_number);

  if (!source && candidates.length === 1 && (allowFreshCandidates || selectedForThisScene)) {
    source = candidates[0];
  } else if (!source && candidates.length === 1) {
    log?.('generation_unanchored_source_ignored', {
      label,
      source: candidates[0],
      policy: 'A media source appeared while resuming an already-submitted scene, but no prompt-specific gallery was selected during this run. Ignore it until this sceneÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢s own output can be associated safely.',
    });
  } else if (!source && candidates.length > 1) {
    // Never infer the requested scene from general DOM order. Multiple playable
    // sources can include earlier unassigned variants. Once this scene's own
    // gallery is opened, prefer its one visible playable editor player only.
    const selectedInEditorForThisScene = selectedForThisScene && isVideoEditorRoute;
    if (selectedInEditorForThisScene) {
      const playable = await page.locator('video').evaluateAll(elements => elements.map(el => {
        const video = el as HTMLVideoElement;
        const style = window.getComputedStyle(video);
        const visible = Boolean(video.getClientRects().length) && style.display !== 'none' && style.visibility !== 'hidden';
        const childSource = video.querySelector('source[src]') as HTMLSourceElement | null;
        return {
          source: video.currentSrc || video.src || video.getAttribute('src') || childSource?.src || childSource?.getAttribute('src') || '',
          visible,
          readyState: video.readyState,
          duration: video.duration,
        };
      }).filter(entry => entry.visible && entry.source && entry.readyState >= 1 && Number.isFinite(entry.duration) && entry.duration > 0).map(entry => entry.source));
      const uniquePlayable = [...new Map(playable
        .filter(candidate => !baseline.has(sourceIdentity(candidate)) && !excluded.has(sourceIdentity(candidate)))
        .map(candidate => [sourceIdentity(candidate), candidate] as const)).values()];
      if (uniquePlayable.length === 1) source = uniquePlayable[0];
    }
    if (!source) {
      log?.('generation_ambiguous_sources_waiting', {
        label,
        count: candidates.length,
        candidateSources: candidates,
        policy: 'Do not choose the first/last arbitrary video source. Wait for a playable source from the current scene-specific selection or its own gallery.',
      });
      return undefined;
    }
  }

  if (!source || !sources.some(candidate => sourceIdentity(candidate) === sourceIdentity(source!)) ||
      (baseline.has(sourceIdentity(source)) && state.phase !== 'complete') || excluded.has(sourceIdentity(source))) return undefined;

  const elements = page.locator(kind === 'video' ? 'video' : 'img');
  for (let i = 0; i < await elements.count(); i++) {
    const element = elements.nth(i);
    const elementInfo = await element.evaluate(el => {
      if (el instanceof HTMLVideoElement) {
        const childSource = el.querySelector('source[src]') as HTMLSourceElement | null;
        const style = window.getComputedStyle(el);
        return {
          source: el.currentSrc || el.src || el.getAttribute('src') || childSource?.src || childSource?.getAttribute('src') || '',
          visible: Boolean(el.getClientRects().length) && style.display !== 'none' && style.visibility !== 'hidden',
          readyState: el.readyState,
          duration: el.duration,
        };
      }
      const image = el as HTMLImageElement;
      const style = window.getComputedStyle(image);
      return {
        source: image.currentSrc || image.src || image.getAttribute('src') || '',
        visible: Boolean(image.getClientRects().length) && style.display !== 'none' && style.visibility !== 'hidden',
        readyState: 0,
        duration: 0,
      };
    });
    if (sourceIdentity(elementInfo.source) === sourceIdentity(source)) {
      if (kind === 'video' && (!elementInfo.visible || elementInfo.readyState < 1 || !(elementInfo.duration > 0))) continue;
      state.source = source;
      return element;
    }
  }
  return undefined;
}

export async function waitGeneration(
  page: Page,
  item: Item,
  kind: 'video' | 'image',
  save: () => Promise<void>,
  log: (event: string, data?: any) => void,
  timeout: number
) {
  const state = item.flow_generation as GenerationState;
  const deadline = Date.now() + timeout;
  let approvalWaitStartedAt: number | undefined;
  let lastLog = 0;
  let lastVerifiedMessage = '';
  let lastQueueMessage = '';
  let lastTransientError = '';
  let lastApprovalDiagnostics: string[] = [];
  // Per waitGeneration invocation only: after a successful click, don't click
  // the same still-rendering button again while Flow updates the UI. On resume
  // this resets, so a currently visible approval action is checked again even
  // if an older saved boolean incorrectly says the prompt was already handled.
  let approvalClickedThisWait = false;
  let approvalPromptResolvedLogged = false;
  let videoGalleryOptionOpenedThisWait = false;
  let scenePromptHistoryChecked = false;
  let scenePromptHistoryGalleryFound = false;
  let editorRouteEnteredAt: number | undefined;
  let editorBackNavigationAttempted = false;
  // Flow's editor route can keep the chosen output selected without exposing
  // a usable <video> source. Let the editor settle (v8's successful clips took
  // about 40-50 seconds), then automatically return to the chat as a user
  // pressing the browser Back button would. Do not reopen the option or submit
  // another generation after returning.
  const editorReturnAfterMs = 75_000;

  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('Flow browser closed. Resume this project.');

    const currentPageUrl = new URL(page.url());
    const isVideoEditorRoute = /^\/project\/[^/]+\/edit\/[^/]+\/?$/.test(currentPageUrl.pathname);

    if (kind === 'video' && videoGalleryOptionOpenedThisWait && isVideoEditorRoute) {
      editorRouteEnteredAt ??= Date.now();
    } else if (!isVideoEditorRoute) {
      editorRouteEnteredAt = undefined;
    }

    const chat = await flowChatSummary(page);
    if (chat.transientError && chat.transientError !== lastTransientError) {
      lastTransientError = chat.transientError;
      log('flow_transient_error_ignored', {
        label: String((item as any).tag ?? (item as any).scene_number ?? 'unknown'),
        message: chat.transientError,
        policy: 'Generic Flow toast is not terminal by itself; continue checking for an actual media result or a specific generation-failure message. No prompt will be resubmitted automatically.',
      });
    }

    // ALWAYS inspect live approval choices before accepting any result already
    // visible in the project. This catches plural batch prompts too and avoids
    // letting older video elements bypass a currently actionable approval.
    const approvalLookup = await explicitApprovalButton(page, chat.approval ?? undefined, item, kind);
    lastApprovalDiagnostics = approvalLookup.diagnostics;
    const liveApprovalPrompt = approvalLookup.promptText;
    const approve = approvalLookup.button;

    if (approvalLookup.promptResolved && (!state.approval_prompt_resolved || state.approval_accepted !== true)) {
      state.approval_prompt_resolved = true;
      state.approval_accepted = true;
      await save();
      if (!approvalPromptResolvedLogged) {
        approvalPromptResolvedLogged = true;
        log('generation_approval_prompt_resolved', {
          label: String((item as any).tag ?? (item as any).scene_number ?? 'unknown'),
          mode: 'latest-permission-card-is-read-only-with-Approve-selected',
          diagnostics: lastApprovalDiagnostics,
          nextStep: 'Recover the generated video option associated with this resolved permission card; do not click historic transcript text.',
        });
      }
    }

    if (approve && !approvalClickedThisWait) {
      approvalWaitStartedAt ??= Date.now();
      const promptForCost = liveApprovalPrompt ?? chat.approval ?? '';
      const creditMatch = promptForCost.match(/costing\s+(\d[\d,]*)\s+credits?/i);
      log('generation_approval_click_attempt', {
        label: String((item as any).tag ?? (item as any).scene_number ?? 'unknown'),
        prompt: promptForCost,
        credits: creditMatch ? Number(creditMatch[1].replace(/,/g, '')) : null,
        diagnostics: lastApprovalDiagnostics,
      });
      try {
        await approve.click({ timeout: 5000 });
      } catch (error) {
        log('generation_approval_click_failed', {
          label: String((item as any).tag ?? (item as any).scene_number ?? 'unknown'),
          error: String(error),
          diagnostics: lastApprovalDiagnostics,
          action: 'Click failed; state remains unaccepted and the live control will be checked again on the next poll.',
        });
        await page.waitForTimeout(500);
        continue;
      }
      approvalClickedThisWait = true;
      state.approval_accepted = true;
      state.approval_prompt_resolved = false;
      await save();
      log('generation_approved', {
        label: String((item as any).tag ?? (item as any).scene_number ?? 'unknown'),
        credits: creditMatch ? Number(creditMatch[1].replace(/,/g, '')) : null,
        prompt: promptForCost,
        selectedControl: lastApprovalDiagnostics,
        policy: 'Clicked visible exact one-time Approve only. Never clicked Always approve.',
      });
      await page.waitForTimeout(750);
      continue;
    }

    // If the scan sees all three live choices but cannot safely select Approve,
    // do not mistake the prompt for historical text and do not move on to a
    // clip that may belong to another request.
    if (liveApprovalPrompt && !approvalClickedThisWait && approvalLookup.liveChoices) {
      approvalWaitStartedAt ??= Date.now();
      if (Date.now() - approvalWaitStartedAt > 10000) {
        throw new FlowActionRequiredError(
          'approval_button_missing',
          'A credit prompt and live Approve / Always approve / Reject choices are visible, but the exact one-time Approve target could not be clicked. Diagnostics: ' + (lastApprovalDiagnostics.join(' | ') || 'no additional diagnostics.')
        );
      }
      await page.waitForTimeout(500);
      continue;
    }

    // A saved approval flag alone is not enough to locate the right video. After
    // the live approval branch above has run, search chat history for this exact
    // scene's existing result gallery; never re-submit during recovery.
    const stateSourceKey = state.source ? sourceIdentity(state.source) : '';
    const stateBaselineKeys = new Set((state.baseline ?? []).map(sourceIdentity));
    const stateExcludedKeys = new Set([...(state.excluded_sources ?? []), ...(state.rejected_sources ?? [])].map(sourceIdentity));
    const savedSourceNeedsRecovery = !stateSourceKey || stateExcludedKeys.has(stateSourceKey) ||
      (stateBaselineKeys.has(stateSourceKey) && state.phase !== 'complete');
    if (
      !scenePromptHistoryChecked && kind === 'video' && state.approval_accepted === true &&
      savedSourceNeedsRecovery && !isVideoEditorRoute && !approve && !approvalLookup.liveChoices
    ) {
      scenePromptHistoryChecked = true;
      log('scene_prompt_history_search_started', {
        label: String((item as any).tag ?? (item as any).scene_number ?? 'unknown'),
        sourceSaved: Boolean(state.source), phase: state.phase,
        policy: 'Search the existing Flow chat for this exact scene’s result gallery after checking for any live approval. Do not resubmit the prompt or click approval during the history search.',
      });
      const history = await ensureScenePromptHistoryLoaded(page, item, log);
      if (!history.found) {
        log('scene_prompt_history_not_found', {
          label: String((item as any).tag ?? (item as any).scene_number ?? 'unknown'),
          steps: history.steps, bubbleCount: history.bubbleCount, anchorFound: history.anchorFound,
          policy: 'No prompt-specific video gallery was found. Keep the scene pending for inspection; do not choose another scene’s clip or spend credits automatically.',
        });
        throw new FlowGenerationQueuedError(
          `Scene ${String((item as any).scene_number ?? (item as any).tag ?? 'unknown')} is already marked approved/submitted, but Flow did not expose a video-option gallery associated with its exact prompt after scrolling the current chat. No new prompt was submitted. Inspect the existing scene in Flow before retrying.`
        );
      }
      scenePromptHistoryGalleryFound = true;
    }
    // Live actionable approval controls were checked first. Now inspect actual
    // video sources. Flow's agent UI may render a batch of videos as thumbnail
    // options rather than as <video> elements; in that case open one option
    // from the latest resolved approval card, then wait for its real MP4 source.
    const result = await generationResult(page, state, kind, log, item, approvalClickedThisWait, videoGalleryOptionOpenedThisWait);
    if (result) {
      state.phase = 'complete';
      // Keep state.url as the canonical project-chat URL captured before
      // submission. Opening a video option may navigate to an editor sub-page;
      // persisting that URL would make the next scene run without its chat.
      state.completed_at = new Date().toISOString();
      await save();
      log('generation_completed', {
        label: String((item as any).tag ?? (item as any).scene_number ?? 'unknown'),
        kind,
        source: state.source,
        confirmation: 'A matching media source was found and saved for this generation item.',
        recoveredMultipleSources: Boolean(state.recovery_candidate_sources?.length),
        approvalPromptPreviouslyResolved: Boolean(state.approval_prompt_resolved),
      });
      return result;
    }

    // If opening a recovered option moved Flow to /edit/<id> but the editor
    // never exposes a playable source, return to the original project chat.
    // This mirrors the manual browser-Back action that lets the automation
    // continue on the chat view, while preserving the current accepted request.
    // We wait 75 seconds because recent successful editor views took ~40-50s
    // to expose a source; returning earlier could interrupt normal loading.
    if (
      kind === 'video' &&
      videoGalleryOptionOpenedThisWait &&
      isVideoEditorRoute &&
      editorRouteEnteredAt !== undefined &&
      Date.now() - editorRouteEnteredAt >= editorReturnAfterMs &&
      !editorBackNavigationAttempted
    ) {
      editorBackNavigationAttempted = true;
      const canonicalUrl = state.url;
      const expectedUrl = new URL(canonicalUrl);
      const isCanonicalChat = (url: URL) =>
        url.origin === expectedUrl.origin &&
        url.pathname.replace(/\/+$/, '') === expectedUrl.pathname.replace(/\/+$/, '');
      const editorUrl = page.url();
      log('flow_editor_back_navigation_attempt', {
        label: String((item as any).tag ?? (item as any).scene_number ?? 'unknown'),
        editorUrl,
        projectChatUrl: canonicalUrl,
        waitedMs: Date.now() - editorRouteEnteredAt,
        policy: 'No usable video source appeared in the editor after 75 seconds. Return to the same project chat (browser Back first, canonical URL fallback second); do not resubmit the prompt or approve another request.',
      });
      try {
        try {
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 });
        } catch (backError) {
          log('flow_editor_back_navigation_browser_back_failed', {
            label: String((item as any).tag ?? (item as any).scene_number ?? 'unknown'),
            error: String(backError),
            fallback: 'Navigate to the configured project chat URL.',
          });
        }
        if (!isCanonicalChat(new URL(page.url()))) {
          await page.goto(canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        }
        if (!isCanonicalChat(new URL(page.url()))) {
          await page.waitForURL(isCanonicalChat, { waitUntil: 'domcontentloaded', timeout: 20000 });
        }
        log('flow_editor_back_navigation_succeeded', {
          label: String((item as any).tag ?? (item as any).scene_number ?? 'unknown'),
          url: page.url(),
          policy: 'Continue watching for the existing scene result in the original chat; no generation was resubmitted.',
        });
        editorRouteEnteredAt = undefined;
        await page.waitForTimeout(500);
        continue;
      } catch (error) {
        log('flow_editor_back_navigation_failed', {
          label: String((item as any).tag ?? (item as any).scene_number ?? 'unknown'),
          currentUrl: page.url(),
          projectChatUrl: canonicalUrl,
          error: String(error),
          policy: 'Do not submit the prompt again. Retry the chat restoration after a short delay.',
        });
        // Avoid a tight navigation loop while permitting one retry after delay.
        editorBackNavigationAttempted = false;
        editorRouteEnteredAt = Date.now() - editorReturnAfterMs + 10000;
        await page.waitForTimeout(500);
        continue;
      }
    }

    // Recovery for the current Flow agent UI: a successful batch may appear as
    // flow-a2ui-video-option thumbnails, while mediaSources() only sees <video>.
    // The gallery selector is anchored to this item's prompt/background/dialogue so it cannot select a later scene's gallery.
    // Never open a gallery while a live approval action is present. Require the
    // current saved item to have an accepted approval and the matching latest
    // permission card to be visibly resolved before selecting any option.
    if (
      kind === 'video' &&
      state.approval_accepted === true &&
      (approvalLookup.promptResolved || scenePromptHistoryGalleryFound) &&
      !approve &&
      !approvalLookup.liveChoices &&
      !videoGalleryOptionOpenedThisWait
    ) {
      try {
        const opened = await openLatestVideoGalleryOption(
          page, state, liveApprovalPrompt, save, log, item
        );
        if (opened) {
          videoGalleryOptionOpenedThisWait = true;
          await page.waitForTimeout(1000);
          continue;
        }
      } catch (error) {
        log('generation_video_option_open_failed', {
          label: String((item as any).tag ?? (item as any).scene_number ?? 'unknown'),
          error: String(error),
          message: 'No prompt was resubmitted. Continue waiting for a usable selected video source.',
        });
      }
    }

    // A credit prompt may remain in old transcript text after approval. Only
    // resolve it after confirming the latest permission card has no live action.
    if (liveApprovalPrompt && !approvalClickedThisWait) {
      approvalWaitStartedAt ??= Date.now();
      if (Date.now() - approvalWaitStartedAt > 10000) {
        state.approval_prompt_resolved = true;
        await save();
        if (!approvalPromptResolvedLogged) {
          approvalPromptResolvedLogged = true;
          log('generation_approval_prompt_resolved', {
            label: String((item as any).tag ?? (item as any).scene_number ?? 'unknown'),
            mode: 'no-live-approval-controls-confirmed',
            diagnostics: lastApprovalDiagnostics,
            nextStep: 'Continue monitoring the same submitted generation; require its media result before advancing.',
          });
        }
      } else {
        await page.waitForTimeout(500);
        continue;
      }
    }

    // Queue status is informational; keep watching the exact current submission.
    if (chat.queue && chat.queue !== lastQueueMessage) {
      lastQueueMessage = chat.queue;
      log('flow_generation_queue_status', {
        message: chat.queue,
        policy: 'Waiting for the existing submission; no prompt was resubmitted.',
      });
    }

    if (chat.missingReference && !(state.approval_accepted && chat.queue)) {
      const tag = chat.missingReference.match(/@?CHAR-\d{2}-[A-Z0-9-]+|#?BGD-\d{2}-[A-Z0-9-]+/i)?.[0];
      throw new FlowActionRequiredError(
        'missing_reference',
        `Flow is asking for a missing reference${tag ? ` (${tag})` : ''}. Add/import that exact reference in this Flow project, confirm it appears as a saved reusable asset, and resume the saved pipeline. Do not submit a duplicate generation while the current request may still be queued.`
      );
    }

    if (chat.clarification) {
      throw new FlowActionRequiredError(
        'clarification',
        `Flow asked a clarification question instead of producing media: ${chat.clarification}. The automation paused rather than guessing a response or resubmitting the generation.`
      );
    }

    await verifyGenerationState(page, state, kind, item, (event, data) => {
      if (event === 'flow_page_verified') {
        const message = String(data?.message ?? '');
        if (message && message === lastVerifiedMessage) return;
        lastVerifiedMessage = message;
      }
      log(event, data);
    }, save);

    if (Date.now() - lastLog > 60_000) {
      log('waiting_for_generation', {
        message: 'Watching current media without resubmitting or reading old queue messages.',
      });
      lastLog = Date.now();
    }

    await page.waitForTimeout(1000);
  }

  throw new FlowGenerationQueuedError();
}
