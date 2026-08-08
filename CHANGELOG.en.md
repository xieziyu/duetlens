# Changelog

Only **user-visible** changes are recorded here. Internal refactors, docs and CI adjustments are not
listed — read `git log` for those. Versions follow [Semantic Versioning](https://semver.org/);
while on `0.x`, the minor position doubles as the breaking-change position.

## [0.3.0] - 2026-08-08

### Added

- **The file list on the left gains a directory tree view.** It is one click away from the existing
  flat view and expands and collapses level by level. A chain of single-child directories compacts
  into one row (`src/backend/store`), and a collapsed directory row carries its subtree file count and
  finding badge. Filtering force-expands the matching paths without touching what you collapsed by
  hand, so clearing the filter returns to where you were. The view is a global preference, also
  available in Settings; the collapse state is kept per review and deliberately not persisted. (#37)
- **Light/dark gains a "follow system" option.** The button at the bottom of the rail now cycles
  light → dark → follow system, and following the system switches live with the OS, no restart. A
  long-standing defect went with it: the renderer had to wait for the stored settings to come back
  before it knew which theme to paint, so anyone not on dark saw one dark frame at every launch. (#36)
- **A rerun now shows its start-up progress.** The panel used to sit on a disabled "starting…" button
  while the backend tore down the previous session, pulled the latest diff and read PR comments — tens
  of seconds on a large PR, with nothing moving on screen. It now turns into a waiting view in place,
  with the same four stages as the entry screen, the elapsed time per stage, and a "slower than
  expected" hint after 6s. A failure still falls back to the form with the note and intensity
  intact. (#34)

### Fixed

- **Enter and Escape pressed while an IME is composing are no longer taken for real keys.** The Enter
  that confirms a candidate and the Escape that cancels one are indistinguishable from a deliberate
  press, and all 8 handlers acted on them: the dismiss-reason box saved half-typed text, and Escape in
  the composer or the editor threw away whole drafts. (#25)
- **A stale recheck note no longer reaches the author in place of the body it describes.** A
  "still present" note is written before the body it ends up next to, so once that body is rewritten
  the card shows two descriptions of the same problem — and the one sent to the author is the old one.
  The same held for a suggestion left unrefreshed that round: accepting it would overwrite code the
  author had just changed. Both are now cleared on a rewrite. A finding whose body was rewritten
  without a new note also no longer drops out of the submit queue. (#35)
- **Suggestion patches are re-indented to the line they are anchored to.** Patches from the agent
  routinely arrive with the leading indentation stripped, and that text is submitted to GitHub
  verbatim — clicking "Commit suggestion" moved the line to column 0, which is merely ugly in TS and
  semantic breakage in Python or YAML. Alignment now happens at read time and multi-line patches shift
  as a block; submission and export align against the current head diff and pin the commit id, instead
  of drifting from the review-time snapshot. (#31)
- **The section merged into the PR review body is renamed to "其他意见(未落在改动行上)".** It holds
  the findings that could not be posted as inline comments, some of which carry a concrete
  `file:line` — calling it an overall opinion contradicted those, and the reviewer's own prose sitting
  right above it is the real overall opinion. (#26)

### Upgrade notes

- The database schema moves to v18 (0.2.x was v16) and an existing database migrates on first launch —
  nothing to do. **Migration is one-way.** Going back to 0.2.x still opens the migrated database, but
  what is stored in the new columns (the round a body was written in, the file list view preference) is
  invisible to it and is never written back. Back up
  `~/Library/Application Support/Duetlens/duetlens.db` before downgrading.
- The update arrives through the in-app updater; there is no need to download the dmg again.

## [0.2.2] - 2026-07-31

### Fixed

- **A real GitButler repository is no longer mistaken for "not a GitButler project".** GitButler 0.22
  renamed the JSON output switch from `--format json` to `--json`, and all three call sites still
  passed the old spelling: the entry screen reported "not a GitButler project (not set up)" and fell
  back to a plain-git review, branch cards showed 0 changed files, and fetching the diff failed once a
  review actually started. The spelling the installed `but` accepts is now picked automatically, so
  both the old and the new CLI work. (#22)
- **The github theme now actually looks like GitHub.** It used to style only the code half, leaving the
  app chrome on duetlens blue; the syntax colors themselves were stale — several retired values — and
  grouped by duetlens' idea of grammar, while GitHub counts literals as constants, gives tags their own
  slot, does not treat attributes as types, and reserves orange for type and class names. Syntax colors
  are rebuilt on current Primer tokens, and the chrome moves with them: Primer surfaces, 6px radius,
  GitHub green primary button. The duetlens and parchment themes render exactly as before. (#23)

### Upgrade notes

- The database schema is unchanged at v16; 0.2.0, 0.2.1 and 0.2.2 can be installed in any direction.
- The update arrives through the in-app updater; there is no need to download the dmg again.

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

[0.3.0]: https://github.com/xieziyu/duetlens/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/xieziyu/duetlens/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/xieziyu/duetlens/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/xieziyu/duetlens/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/xieziyu/duetlens/releases/tag/v0.1.0
