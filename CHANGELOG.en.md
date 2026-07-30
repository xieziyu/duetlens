# Changelog

Only **user-visible** changes are recorded here. Internal refactors, docs and CI adjustments are not
listed — read `git log` for those. Versions follow [Semantic Versioning](https://semver.org/);
while on `0.x`, the minor position doubles as the breaking-change position.

## [0.2.1] - 2026-07-30

### Fixed

- **"Stop the scan" now actually stops it.** The request used to die on `missing field turnId`, so the
  round kept burning tokens until it finished on its own, while the error card claimed the opposite —
  that the round had never started. One more defect on the same path went with it: stopping no longer
  interrupts a follow-up turn queued behind the scan. (#19)
- **A codex whose protocol no longer matches this build is refused, instead of running on under an
  unknown policy.** Starting a session injects a read-only sandbox and "never ask for approval", but
  codex silently ignores fields it does not recognise — rename one and the request still "sends
  successfully" while the review agent is no longer read-only, with nothing anywhere reporting it. The
  effective policy is now read back at start-up and a mismatch refuses to launch; any policy approval
  request during a session is treated as proof of failure, ending the round and tearing the session
  down. Each of the two failures explains itself rather than surfacing a bare `-32600` behind a
  "retry" button — retrying either one reproduces it. (#20)

### Upgrade notes

- The database schema is unchanged at v16; 0.2.0 and 0.2.1 can be installed in either direction.
- This build targets codex 0.145.0. If starting a review reports a protocol mismatch, upgrade the codex
  on your machine — the change is only that a silent downgrade became an explicit refusal.
- The update arrives through the in-app updater; there is no need to download the dmg again.

## [0.2.0] - 2026-07-29

### Added

- **Conclusions reached in discussion can be written back to a finding in one click.** During a
  follow-up turn the agent no longer edits the finding directly; it renders a confirm card that only
  takes effect once you accept it. Scan and self-check turns still apply directly. Dismissal is now
  its own verb — before this the agent had no way to say "this one does not hold" and had to put the
  reason into the body, destroying the original text. (#12)
- **The agent writes a read-only review summary at the end of a scan**, together with the files worth
  a manual pass, which are clickable. The summary is material for the reviewer, not the reviewer's
  output: it is never sent to the PR author and never enters the exported report — a sentence written
  by a machine reaches the author only if a person writes it down again. If a rerun skips the summary,
  the stale one is labelled with the round it came from. (#14)
- **`github-pr` reviews can export a Markdown report too.** Submit and export now sit side by side in
  one screen, sharing one set of findings and one triage pipeline. Each entry in the report is tagged
  as submitted or pending, the scope can be narrowed to pending only, and the file name carries the
  PR number. (#17)
- **A finding degraded to the summary keeps its file anchor**: summary entries carry `file:line`, and
  the degrade can be reversed back to an inline comment. (#13)
- **Dismissed findings fold into their own group**, collapsed by default, instead of sitting struck
  through in their original severity bucket. (#15)
- **A parchment color theme**, tuned separately for light and dark. (#10)
- **Prompt rules screen**: the merged-preview column is gone and the editor spans the main area; with
  no repo selected every section is still listed read-only, and the project layer shows the current
  repo with a switch action. (#11)

### Fixed

- **A new problem on a line that already had a fixed finding is no longer taken for that finding.**
  The old path restored the closed finding to pending and swallowed the new report, leaving a card
  badged "fixed" while the list still showed it as open. (#16)
- **Submitted suggestions keep the indentation of their first line** — applying one used to silently
  re-indent the anchored line. (#8)
- **A double click during an in-flight submit no longer posts the comments twice.** Leaving the submit
  screen mid-flight and coming back resets the local state, which made that second click perfectly
  legal on screen. (#17)
- **A long recent-repo name on the entry screen no longer wraps**; the path truncates instead. (#9)

### Upgrade notes

- The database schema moves to v16 and an existing database migrates on first launch — nothing to do.
  **Migration is one-way.** Going back to 0.1.0 still opens the database, but everything stored in the
  new columns (summaries, anchor-drop markers, and so on) is invisible to it and is never written
  back. Back up `~/Library/Application Support/Duetlens/duetlens.db` before downgrading.
- The update arrives through the in-app updater; there is no need to download the dmg again.

## [0.1.0] - 2026-07-26

First public release.

[0.2.1]: https://github.com/xieziyu/duetlens/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/xieziyu/duetlens/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/xieziyu/duetlens/releases/tag/v0.1.0
