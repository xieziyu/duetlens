# Changelog

Only **user-visible** changes are recorded here. Internal refactors, docs and CI adjustments are not
listed — read `git log` for those. Versions follow [Semantic Versioning](https://semver.org/);
while on `0.x`, the minor position doubles as the breaking-change position.

## [0.7.2] - 2026-08-24

### Fixed

- **Reviews no longer silently report zero findings on codex 0.149 and later.** That release folds
  MCP tool calls into approvals, which flipped `approvalPolicy: "never"` from "don't ask, allow" to
  "don't ask, deny". Every `report_finding` and `write_summary` the agent made was rejected, so a
  review ran to completion with an empty result page and nothing unusual in the logs —
  indistinguishable, on screen, from a review that genuinely found nothing. The handshake now asks
  for the `granular` approval policy with all five gates closed (currently the only spelling that
  means "don't ask and allow") and falls back to `"never"` when codex rejects that policy; older
  builds ignore fields they do not understand, so no second handshake is needed. On top of that, a
  round now fails loudly when codex refuses to hand a tool call to the built-in MCP server, instead
  of degrading into an empty verdict. (#72)

### Upgrade notes

- The database schema is unchanged at v21; 0.7.0, 0.7.1 and 0.7.2 can be installed in any direction.
- The update arrives through the in-app updater; there is no need to download the dmg again.

## [0.7.1] - 2026-08-21

### Fixed

- **Launching from the Dock or Spotlight no longer drops half the environment codex needs.** launchd
  hands the app an almost empty environment, and only `PATH` was being recovered; everything else was
  thrown away. A custom codex `model_providers` entry with `env_key`, a plain `OPENAI_API_KEY`, proxy
  variables — none of them were visible in a GUI launch, so a review died immediately with "missing
  environment variable X" while the very same config worked fine with the codex CLI in a terminal,
  which made the failure almost impossible to self-diagnose. The same login-shell probe now brings back
  the full environment: `PATH` keeps its existing merge and fallback-directory logic, and every other
  variable is backfilled only when the process does not already have that key, so anything launchd or
  the command line passed in still wins. Switches that would change how this process runs
  (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and friends) and the app's own startup switches
  (`DUETLENS_USER_DATA`) are never adopted. The probe result stays in memory only: never logged, never
  stored, never sent over IPC. (#70)

### Upgrade notes

- The database schema is unchanged at v21; 0.7.0 and 0.7.1 can be installed in any direction.
- The update arrives through the in-app updater; there is no need to download the dmg again.

## [0.7.0] - 2026-08-20

### Added

- **A review can now be diffed against a base you choose.** Only "which branch to review" was
  selectable; what it got compared against came from auto-detecting the default branch, so a branch
  in a stack could only be reviewed one layer at a time — reviewing it together with the layers
  below was not possible. The entry screen now has a base picker next to the branch picker, each row
  stating the range it covers, with a stack ladder and a live change-surface count. A GitButler
  source offers the lower branches of the same stack plus the workspace base; a local repository
  widens the candidates to all local branches. The chosen base is persisted on the review, so a
  rerun or a resume keeps the same baseline instead of quietly re-detecting a different one on the
  second round. (#58)
- **A stacked PR can be reviewed together with the PRs below it.** `gh pr diff` only ever returns a
  PR's own diff, so a PR stacked on top of others was reviewed without the context underneath. The
  ancestor chain is now discovered by walking `baseRefName` and looking up the PR whose head is that
  branch — that chain is the stack itself — and the widened diff comes from the compare API, so no
  clone is needed. The pre-submit check still uses the PR's own diff, since that is what GitHub
  validates against, and a finding anchored in a lower PR now says it is out of scope rather than
  vaguely calling it stale. (#59)

### Fixed

- **Reviewing one branch in a GitButler workspace no longer exposes another branch's changes.** The
  diff only ever contained that branch's commits, while `get_file` and `search_code` read the
  worktree — and a GitButler worktree is every applied lane merged together, so the agent could cite
  code the review had never shown, with nothing on screen hinting at it; following a committed
  symlink could also read outside the repository. The branch head is now pinned at prepare and every
  evidence call is served from that tree, with calls made before prepare refused outright (they
  would otherwise read the index). The diff is taken once and required to come from the pinned head:
  a branch that moved before anything was read is re-pinned, one that moved after evidence was
  served is an error rather than a second tree read silently. Two silent baseline swaps are fixed
  along the way: a short ref now resolves as `refs/heads` then `refs/remotes`, peeled to a commit,
  because a same-name tag wins the short-ref lookup; and the default diff is refused when such a tag
  exists, since `but diff` only takes a name and returns an empty change set there. A change surface
  that cannot be counted now reads as unknown instead of 0 files, so a conflicting branch no longer
  looks like an empty one. (#61)
- **In-flight states on the entry screen are visible, and the base area stops jumping.** The screen
  had six in-flight states, each drawn its own way, all of them motionless faint grey text; they are
  now one Busy indicator (an agent-coloured ring plus a line of text). The ancestor-chain probe
  moved out of the PR card's metadata row and into the base picker slot itself — a multi-second wait
  tucked into a caption inside a dense metadata line goes unnoticed. The placeholder matches the
  real row height, so the swap to the picker does not push the page, and a PR that turns out not to
  be stacked collapses with a transition instead of dropping the row and jumping the page 50px.
  Several ways to review the wrong thing are gone too: the probe is keyed on the PR identity alone
  (it carries owner/repo, so the repoPath fallback never applied), where editing the path used to
  re-probe and blank the candidate list for seconds — picker and scope warning both vanished while
  the chosen base stayed in effect; a first-layer chain failure is now raised instead of returning
  an empty chain, since a valid PR always has a base and swallowing the error disguised rate limits
  as "not stacked"; and a chosen base that is not among the candidates once the chain settles is
  cleared, so a failed probe cannot start a review on a wider base than the screen is showing. (#66)
- **Start always reviews the PR the card is showing.** A bare `#123` reference was resolved for
  display using the local repository path, but the raw text was submitted and the backend derived
  owner/repo from that path a second time. Changing the path does not change the query string, so
  the old preview stayed on screen and the start gate stayed open: clicking start inside the
  debounce window reviewed the other repository's #123 while the card still showed the first one.
  The GitHub panel now reports the resolved `owner/repo#n` and the review starts from that, so what
  the card shows and what gets reviewed cannot diverge. (#67)

### Upgrade notes

- The database schema moves to v21 (0.6.0 was v20); an existing database migrates on first launch
  with no action needed. **The migration is one-way** — 0.6.0 can still open a migrated database, it
  simply cannot see the content of the new column (the diff base chosen for a review) and never
  writes it back. If you really need to downgrade, back up
  `~/Library/Application Support/Duetlens/duetlens.db` first.
- Updates are delivered by the in-app updater; there is no need to download the dmg again.

## [0.6.0] - 2026-08-20

### Added

- **The adversarial self-check is now grounded in tool evidence.** It used to run in the same thread,
  asking the model to reconsider its own findings — but the first turn's reasoning chain is still in
  context, so the search space has already been pruned, and the payoff is small. The real failure
  mode of agent review is not a missed finding but a fabricated one, a citation of a call path that
  does not exist; noise hurts more than omission because it teaches people to ignore the whole
  channel. The self-check now has `judge_finding`: a verdict is one of confirmed / refuted /
  cannot_verify, a rationale is required, and it is rejected unless that turn actually read the
  finding's file through `get_file` or `search_code` — a model can fabricate a citation in prose, it
  cannot fabricate a tool call the backend recorded. `cannot_verify` is deliberately distinct from
  confirmed: no evidence is not the same as established. The turn judges reported findings before
  hunting for missed ones, and is skipped entirely when there is nothing to judge. `search_code`
  (literal `git grep`) lets the model check whether a symbol or call site really exists; it is
  declared only when the source has a real code tree, so github-pr sessions never see a tool they
  cannot use. Verdicts are annotations: they never touch severity or triage — demoting a finding is a
  soft dismissal, and dismissal belongs to the reviewer. (#52)
- **An update downloaded in the background is now flagged on the left rail.** It was previously
  visible only on the settings screen, so nothing told you that a restart would upgrade you. The
  settings button now carries an unread dot while an update is ready, with a tooltip naming the
  version waiting for a restart, and going to settings from that button scrolls straight to the
  About section so the restart button is in view. Only the ready phase lights up — there is nothing
  actionable while downloading or on error. (#56)

### Fixed

- **Symlinks pointing outside the repository are no longer read.** The path check was purely lexical
  while reading a file follows symlinks, so a link holding `leak -> ~/.ssh/id_rsa` passed the check
  as `<repo>/leak` and then handed the private key straight to the agent's evidence tools. The target
  is now resolved to its real path and re-checked against the repository root; links that stay inside
  the repo keep working. (#54)
- **The adversarial evidence gate no longer refuses verdicts the agent had earned, and the cost hint
  was rewritten.** Evidence keys did not fold `.` / `..`, yet `a/x/../b.ts` really does read
  `a/b.ts`, so a file the agent had read was treated as unread. The keys also rewrote backslashes and
  trimmed spaces, both legal POSIX filename characters — merging them let the agent read one file and
  rule on another. The two directions are not symmetric: a stray space only causes a refusal you can
  recover from, a merged key is a silent pass. The intensity hint's "about a third more" came from a
  single run that happened to be the cheapest of four, and now states the observed range. Separately,
  the severity chip could overflow when `category` is long; it now truncates with the full text on
  hover. (#53)
- **The status dot in the settings rows is no longer a blank gap.** The dot only got a background
  from its tone class (ok / warn / error / checking), and the update row's "up to date" and idle
  phases match none of them, so the dot stayed transparent while still taking 7px plus a 6px gap —
  reading as a missing icon and an empty space left of the text. (#51)
- **The scan coverage counter now says "read" rather than "evidenced".** The forensic wording made
  the number look like the agent was building a case against the code, when it only means the agent
  actually read those files. The empty-findings header and the tooltip changed with it. (#55)

### Upgrade notes

- The database schema moves to v20 (0.5.0 was v18); an existing database migrates on first launch
  with no action needed. **The migration is one-way** — 0.5.0 can still open a migrated database, it
  just cannot see or write the new columns (which turn reported a finding, and the self-check's
  verdict and round). Back up `~/Library/Application Support/Duetlens/duetlens.db` before
  downgrading.
- The update arrives through the in-app updater; there is no need to download the dmg again.

## [0.5.0] - 2026-08-18

### Added

- **The home screen now lists only the 20 most recent reviews.** Once records pile up that column
  just keeps growing, and the home screen is where you pick one thing to start on; anything older
  belongs in the review history screen on the left rail, which has search, filters and grouping. The
  count beside the heading now reads the number of rows actually listed, so it can no longer say 35
  above a list of 20. (#49)

### Fixed

- **Clicking a row in the branch picker selects that branch again.** The rows are non-focusable divs,
  so mousedown dropped focus out of the filter input, the blur handler saw a null `relatedTarget`,
  decided focus had left the component and closed the menu, and the row unmounted before mouseup — no
  click event ever fired. In practice nothing but the auto-selected default branch could be picked,
  unless you reached for the arrow keys and Enter. A regression since #43 in 0.4.0. (#48)

### Upgrade notes

- The database schema is unchanged at v18, so 0.4.0 and this release can be installed either way
  round.
- The in-app updater handles this update; there is no need to download the dmg again.

## [0.4.0] - 2026-08-13

### Added

- **A scan now shows what the agent is doing.** The stage stepper used to sit on "reading the diff"
  for minutes with a spinner as the only moving thing on screen — and across 203 real scans a round
  runs 181s at the median and 460s at p90, with the first finding arriving at 169s median, so the
  findings counter reads 0 for the first few minutes. The scan bar now carries a live row (which file
  it is reading, what it is searching for, how long this step has been running), the expanded panel
  and the empty findings pane both carry an action feed, and there is an "N of M changed files
  evidenced" coverage count. Deliberately no percentage bar: how long the agent will explore cannot be
  declared in advance, so the denominator would be invented; coverage is coverage, not completion.
  (#46)
- **Rerun is now reachable from the submit and export screens, with a `⌘E` shortcut** (`Ctrl+E` off
  macOS). After submitting a review to GitHub or exporting the report, the next step is usually
  another round once the author has pushed fixes, and until now that step meant walking back to the
  diff screen to find the topbar button. For `github-pr` reviews the entry — button *and* shortcut —
  appears only after a successful submit: leaving the submit screen unmounts it along with any
  half-written Review comment, and that is not a path worth advertising. (#40)
- **The local-repo switch lists recently reviewed repos.** The head-row switch button now opens a menu
  with the current repo on top and ticked, and the directory dialog kept as the last item, so picking
  another repo no longer means walking the system file dialog every time. With no other candidate it
  stays the plain button it was. (#42)
- **There is a website now**: <https://xieziyu.github.io/duetlens/>, linked from the top of both
  READMEs.

### Fixed

- **Dragging a sidebar divider no longer lags behind the cursor.** The drag was never throttled: every
  `pointermove` rewrote the three-column grid, and the middle column is the fully rendered,
  unvirtualised diff — so each event paid a full subtree relayout and the divider separated from the
  pointer. The drag now moves a 1px dashed ghost line instead (a compositor-only path whose cost does
  not depend on the size of the diff), writes the real column width once on release, and shows the
  target width in pixels next to the pointer. Two related defects went with it: the responsive width
  caps at narrow window widths were invisible to the drag, so the preview and the committed value both
  ran past what the layout would honour; and releasing the button outside the window left the ghost
  line on screen forever. (#39)
- **macOS Ctrl inline-edit keys are no longer eaten by review hotkeys.** The review-screen navigation
  listener and the diff find listeners all gated on `metaKey || ctrlKey`, while on macOS Ctrl+F/B/A/E/K
  are text-control inline-edit keys — pressing Ctrl+F inside the composer or a finding editor stole
  focus into the find bar. Those hotkeys now accept `⌘` only on macOS. (#41)
- **The branch picker closes properly and announces the highlighted branch.** The menu stayed open
  after Tab moved focus away, covering the controls below it; Escape and picking now hand focus back
  to the trigger instead of dropping it on body; and in a long branch list the highlighted row scrolls
  into view. (#43)

### Upgrade notes

- The database schema is unchanged at v18, so 0.3.0 and this release can be installed either way
  round.
- The in-app updater handles this update; there is no need to download the dmg again.

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

[0.7.2]: https://github.com/xieziyu/duetlens/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/xieziyu/duetlens/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/xieziyu/duetlens/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/xieziyu/duetlens/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/xieziyu/duetlens/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/xieziyu/duetlens/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/xieziyu/duetlens/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/xieziyu/duetlens/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/xieziyu/duetlens/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/xieziyu/duetlens/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/xieziyu/duetlens/releases/tag/v0.1.0
