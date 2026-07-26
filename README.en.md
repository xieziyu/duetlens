<p align="center">
  <img src="build/icon.png" width="96" alt="Duetlens" />
</p>

<h1 align="center">Duetlens</h1>

<p align="center">See what every change really does, with an agent</p>

<p align="center">
  <a href="https://github.com/xieziyu/duetlens/releases/latest"><img src="https://img.shields.io/github/v/release/xieziyu/duetlens?color=brightgreen&label=release" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-black.svg" alt="Platform" />
  <img src="https://img.shields.io/badge/agent-codex%20app--server-38bdf8.svg" alt="codex app-server" />
</p>

<p align="center">
  <a href="README.md">简体中文</a> · English
</p>

Duetlens is a macOS desktop app that turns a code review into a **conversation** between you and a codex agent, instead of a report you read after the fact.

Every finding the agent reports is a discussion thread you can keep asking into. You can also start one anywhere in the diff — on a line, on a selected block, or on nothing at all when the question is about the change as a whole. When you're done, triage the findings and submit them as a GitHub PR review, or export a Markdown report.

![Talking to the agent on the diff](docs/assets/screen-review.jpg)

## What it does

**Talk on the diff, don't read a report.** Findings are anchors, not endings: each one carries a discussion in a live session you can keep following up in. The inline ✎ or a code selection opens a new discussion right where you are. Questions that don't belong to any single line — architecture, trade-offs, "what is this PR actually solving" — don't need an anchor at all.

**Recording a finding is additive.** On the same card, flipping `⚑ record as finding` grows severity / category / title / suggestion in place. You don't have to decide up front whether you're asking a question or filing an issue.

**Re-reviews don't overwrite your calls.** Each round is a fresh session with a full re-scan, and the agent must take an explicit position on every finding from the previous round — `fixed` / `wont_fix` / `still_present`. What you dismissed stays dismissed, suppressed both through the prompt and through deduplication.

**Review only, never edit.** The agent runs in a read-only sandbox; there is no "just fix it for me". A `suggestion` is only ever a GitHub suggestion block offered to the author.

**Three sources.** GitHub PR (paste a link, it resolves as you paste), local git branch, and GitButler virtual branch. For a local repository, which of the two paths applies is detected from the repository's current state.

**Two intensities.** Standard scans once and reports. Adversarial appends a self-check turn in the same session — it fills gaps and downgrades conclusions it can't stand behind. More expensive, less guessing.

![Starting a review](docs/assets/screen-entry.jpg)

**Review rules in three layers.** `builtin` ▸ `~/.duetlens/review.md` (yours) ▸ `.duetlens/review.md` (committed with the repo, shared by the team), overridden section by section, with the merged result always visible on the right.

![Three-layer review rules](docs/assets/screen-prompt.jpg)

**Submit or export.** Filter the findings and submit them as a GitHub PR review (inline comments plus suggestion blocks). A local branch has no PR to submit to, so it exports a Markdown report instead.

![Submit and export](docs/assets/screen-submit.jpg)

Also: review history in a local SQLite database (kept for 30 days) · light/dark and color theme as two independent axes (a GitHub palette included) · `⌘F` to search content, `⌘⇧F` to search files · unified and split views · per-file viewed marks · a system notification when a scan finishes.

## Install

### Prerequisites

- macOS on Apple Silicon
- [codex CLI](https://github.com/openai/codex), logged in via `codex login` — the review agent is built on `codex app-server` (verified against 0.144.x / 0.145)
- Optional: [`gh`](https://cli.github.com) with `gh auth login` — only needed for the GitHub PR source and for submitting reviews
- Optional: [GitButler](https://gitbutler.com)'s `but` — only needed for the virtual branch source

On first launch Duetlens probes each of these and hands you a copyable fix command for whatever is missing, rather than failing with one line.

### Download

Grab the `.dmg` from the [latest release](https://github.com/xieziyu/duetlens/releases/latest) and drag it into Applications. Later versions arrive through the in-app updater.

The `.zip` on that page is what the updater consumes; you don't need it for a manual install.

### Run from source

```bash
npm ci
npm run rebuild:electron   # rebuild better-sqlite3 against the Electron ABI
npm start
```

For a local build of your own: `npm run package` (ad-hoc signed, runs on this machine only). Release builds are signed and notarized by CI when a `v<version>` tag is pushed.

## Using it

1. Pick a source — paste a PR link, or choose a local repository and branch.
2. Start the review: Duetlens fetches the diff and opens a live codex session for the first scan. Findings come back over MCP tools and land on the diff as they arrive; you don't wait for the scan to finish.
3. Follow up, triage, add findings of your own. Want another pass at a different intensity or model? Re-run a round.
4. Submit a review on a GitHub PR, or export Markdown for a local branch.

Every scan spends your codex account's quota. The status bar keeps the model, effort and context usage in view.

## Design and docs

The goals, the decisions that have been settled, and the reasoning behind them live in [docs/README.md](docs/README.md); engineering conventions are in [CLAUDE.md](CLAUDE.md) (both in Simplified Chinese).

Stack: Electron + React + TypeScript with the backend in the main process; the review agent is a long-lived JSON-RPC session to codex app-server; findings come back through an in-process HTTP MCP server; local storage is better-sqlite3.

Duetlens is a 2.0 full rewrite of [better-review](https://github.com/xieziyu/better-review). 1.0 was one-way and one-shot: a single `codex exec` ran, wrote `findings.json`, and that was that — you could only consume the result. Making it answerable meant the agent session had to stay alive, and that is where the rewrite started.

## Feedback

Bugs and requests go to [Issues](https://github.com/xieziyu/duetlens/issues). The feedback link under Settings → About prefills one with your environment.

## License

[GPL-3.0-or-later](LICENSE)
