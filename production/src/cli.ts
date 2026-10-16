import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { start } from './flowClient.js';
import { run } from './runner.js';
import type { Pipeline } from './types.js';
import { loadEnvironment } from './setupConfig.js';

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback;
}

await loadEnvironment();

// Resolve the production directory from this module's location, not the
// current working directory. This keeps the profile path stable on Windows.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const productionDir = path.resolve(moduleDir, '..');

const file = path.resolve(
  arg('--project') ?? '../scripting/projects/example/pipeline.json'
);
const out = path.resolve(arg('--output-dir') ?? 'outputs');

const profileArg = arg('--user-data-dir');
const profile = path.resolve(
  profileArg ?? path.join(productionDir, '.chrome-profile')
);

console.log('Using Chrome profile:', profile);

const p = JSON.parse(await fs.readFile(file, 'utf8')) as Pipeline;
const logFile = path.join(out, 'run.log.jsonl');
await fs.mkdir(out, { recursive: true });

const log = async (e: string, d: any = {}) => {
  const row = JSON.stringify({
    at: new Date().toISOString(),
    event: e,
    ...d,
  });
  console.log(row);
  await fs.appendFile(logFile, row + '\n');
};

const projectUrl =
  typeof p.flow_project_url === 'string'
    ? p.flow_project_url.trim()
    : undefined;

function parsedHttpsUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isFlowProjectUrl(value: string | undefined): value is string {
  const parsed = parsedHttpsUrl(value);
  return Boolean(
    parsed &&
      parsed.hostname === 'flow.google.com' &&
      /^\/project\/[^/]+\/?$/.test(parsed.pathname)
  );
}

function isFlowEntryUrl(value: string | undefined): value is string {
  const parsed = parsedHttpsUrl(value);
  if (!parsed) return false;

  if (parsed.hostname === 'labs.google') {
    return (
      parsed.pathname === '/fx/flow' ||
      parsed.pathname.startsWith('/fx/flow/') ||
      parsed.pathname === '/fx/tools/flow' ||
      parsed.pathname.startsWith('/fx/tools/flow/')
    );
  }

  // The root is a valid Flow entry page; /about is deliberately rejected.
  return parsed.hostname === 'flow.google.com' && parsed.pathname === '/';
}

function isFlowUrl(value: string | undefined): value is string {
  return isFlowProjectUrl(value) || isFlowEntryUrl(value);
}

const configuredUrl = process.env.FLOW_URL?.trim();
const projectId = process.env.FLOW_PROJECT_ID?.trim();

// Resuming an existing pipeline must preserve its saved Flow project.
// A generic FLOW_URL such as /fx/flow is an entry page, not a project URL,
// and must not replace the saved project URL. An explicit FLOW_URL pointing
// to a particular /project/<id> is allowed to override it intentionally.
let url: string;
let urlSource: string;

if (isFlowProjectUrl(configuredUrl)) {
  url = configuredUrl;
  urlSource = 'FLOW_URL project override';
} else if (isFlowProjectUrl(projectUrl)) {
  url = projectUrl;
  urlSource = 'saved pipeline project';
} else if (isFlowEntryUrl(configuredUrl)) {
  url = configuredUrl;
  urlSource = 'FLOW_URL entry page';
} else if (isFlowUrl(projectUrl)) {
  url = projectUrl;
  urlSource = 'saved pipeline URL';
} else if (projectId) {
  url = `https://flow.google.com/project/${encodeURIComponent(projectId)}`;
  urlSource = 'FLOW_PROJECT_ID';
} else {
  url = 'https://labs.google/fx/flow';
  urlSource = 'default Flow entry page';
}

console.log(`Opening Google Flow URL (${urlSource}):`, url);

const { context, page, flow } = await start(url, profile, log);

try {
  const finalUrl = page.url();
  log('flow_start_url_verified', { requestedUrl: url, finalUrl });

  // Never overwrite a saved project URL with a blank page, /about, or the
  // generic Flow home page when resuming a known project.
  if (isFlowProjectUrl(url) && !isFlowProjectUrl(finalUrl)) {
    throw new Error(
      `Expected to resume the saved Google Flow project, but the browser ended at ${finalUrl}. ` +
        'The existing pipeline URL was preserved; check flowClient.ts navigation before retrying.'
    );
  }

  if (isFlowProjectUrl(finalUrl)) {
    p.flow_project_url = finalUrl;
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(p, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }

  await run(flow, page, p, file, out, log);
} catch (error) {
  await page
    .screenshot({
      path: path.join(out, 'flow-error.png'),
      fullPage: true,
    })
    .catch(() => {});
  throw error;
} finally {
  await context.close();
}
