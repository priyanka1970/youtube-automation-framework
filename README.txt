Main automation source patch

This patch replaces production/src/generation.ts, an existing source module used by:
  node start-video.mjs --project "scripting/projects/youtube-automation-20261015093729601/pipeline.json"

It is not a separate runtime/diagnostic script. Future runs through start-video.mjs use this logic.

Change in this revision:
- Approval detection now accepts the exact single-request Approve text when Flow renders it inside the same DOM container as the current credit prompt, as well as when it appears after the prompt.
- It continues to require the local approval group to contain Approve, Always approve, and Reject, and explicitly excludes Always approve.

Install by extracting the ZIP at the repository root and replacing production/src/generation.ts.
Then run: npm --prefix production run typecheck
Only resume the saved pipeline if the typecheck succeeds.
