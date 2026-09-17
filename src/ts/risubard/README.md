# RisuBard adapters

This directory contains adapters between the inherited application and `packages/risubard-core/`, beginning with side-effect-free shadow-context comparison.

The narrative-context path is enabled by default. Assistant responses remain
unconfirmed until the next user message completes a generation or the user
chooses the message-menu confirmation action. Confirmation analysis returns a
schema-bound semantic draft that the application serializes to Markdown. The
application owns safe file names and YAML frontmatter, then atomically writes
an Obsidian-compatible `wiki/events/*.md` evidence document.

Automatic confirmation searches the wiki using the configured recent raw
message window through the confirmed message. It proposes canonical rewrites
only for concrete durable changes that are not already represented; an event
that needs no canonical change skips the rewrite model. Necessary persistent
identity, relationship, knowledge, inventory, goal, constraint, and state
changes remain eligible, up to eight canonical targets.
Changed pages are immediately active but marked unreviewed; the first prior
version is kept under `.risubard-review/` and every replacement is archived
under `.risubard-history/`. The audit UI exposes before/after text, acceptance,
and one-step rollback. Review-first mode and the explicit Wiki Workbench remain
available for directed edits.

The in-app file tree also supports AI-free manual pages for characters,
locations, factions, creatures, items, concepts, the current scene, and other notes.
Manual saves keep program-owned IDs and frontmatter, archive prior revisions,
move renamed/type-changed files safely, and update editable wikilinks. Delete
moves canonical bytes under `.risubard-trash/`; confirmed `events/` evidence
is visible in its own folder but remains read-only.

The Markdown files are the only current narrative-wiki source. Memory Wiki and
bounded inquiry read those same files directly; graph state, edge operations,
operation logs and generated JSON indexes do not participate in confirmation,
display or prompt injection. Before the first document exists, main chat
continues with static character/lore context and recent messages.

Wiki analysis and main-response history have separate recent-message windows,
each configurable from 1 through 100 and defaulting to 12. Main-response
history can omit earlier user turns, but always retains the latest user request.
Inquiry always selects the current-scene page when it exists and uses positive
lexical matches as direct seeds for matching canonical pages. It follows
derived `[[wikilinks]]` for up to two hops, so connected event evidence does not
need its own direct lexical match. Past, causal, and detail-checking questions
reserve up to two fitting event excerpts inside the same target token budget;
chronology-list questions continue to prefer the compressed character history.
Ordinary forward-scene requests omit character pages reached only through a
link. Explicit character, relationship, historical, causal, and chronology
requests retain that traversal. Recent raw messages remain the primary current
scene evidence, so a current-scene page is optional rather than auto-required.
Each canonical document also has a program-owned `context` policy: `always`
is required input, `auto` needs a positive lexical match, and `never` is
excluded from automatic inquiry. Required context that exceeds the fixed
twelve-document limit fails explicitly instead of silently dropping a page.

The Markdown view derives bounded health diagnostics from the loaded files:
unresolved `[[wikilinks]]` and canonical pages with no current connection. The
diagnostics never rewrite source files and return document IDs rather than
absolute paths.

Manual and AI-assisted updates carry the current document `contentHash` as a
precondition. If a writer edits the target after a draft was generated, the
stale approval is rejected and the current bytes remain unchanged. Batch
drafting accepts at most eight canonical targets, makes one fresh model request
per target in sequence, and returns independent editable proposals. Each
proposal must be approved or rejected separately; batch generation never
writes the wiki.

The `RisuBard work model` setting chooses either the auxiliary memory model
(default) or the current main model for automatic analysis and Workbench calls.
Dock width remains draggable and persistent; fixed 35/50/65/75 presets are not
shown.

Each generated assistant message may persist body-free context provenance in
its existing generation metadata: recent message IDs/roles, selected wiki
relative paths, inquiry timing, selected tokens, model, request/response token
counts, stage timings, and whether a tool executed. Memory Wiki renders this
as a collapsible activity console and links paths back to the file tree. Live
manual saves, trash operations, and AI-draft phases use the same redacted UI
event channel. Prompt bodies, message bodies, API keys, and hidden reasoning
are never part of this trace.

Invalid or empty analysis output leaves the wiki unchanged. The application
does not save the full assistant response as a fallback note and does not log
the response body, API key or complete prompt.
The v1 baseline preparation deadlines remain only for an explicit legacy
rollback.
Legacy chats without a chat UUID receive one before generation. The captured
UUID is shared by inquiry and confirmation analysis so work is not split when
the chat list changes.
Set
`localStorage["risubard.experimentalNarrativeContext"] = "false"` and reload
only when an explicit legacy-path rollback is required.
