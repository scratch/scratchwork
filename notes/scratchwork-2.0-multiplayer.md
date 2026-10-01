# Scratchwork 2.0: multiplayer and the agent editor

Status: agreed direction (Oct 1, 2026), not started. The page editor prototype
lives in `wip/editor/` (see its README); this note is the plan for taking it
from one person on their own machine to people and agents editing together.

## The model

A document is a folder of files rendered as one live page. Two kinds of
editor change it:

- **The human editor**: a person in a browser tab, editing the rendered page
  (or the source views).
- **The agent editor**: a person's agent, editing the files with tools
  (read, edit, write, list, find, grep, view_page).

Both are participants in the same shared document and their edits merge the
same way.

## What's shared and what's private

- **The document is shared.** Everyone's edits, human and agent, merge into
  one state.
- **Agent conversations are private per person.** A transcript belongs to
  (user, document). Your tabs and devices see the same conversation live;
  a collaborator gets their own and never sees yours. Others see only your
  agent's edits, attributed ("Pete's agent"), and its presence while it works.
- **An agent acts with its user's permissions.** If you can only view, your
  agent can't edit.

## Architecture

```
 Pete's tabs ─┐                                    ┌─ Pete's agent session (private: transcript, runs)
 Friend's tab ┼── WebSocket ──  Document room  ────┤
 Friend's tab ┘   (Yjs sync +    (shared Yjs doc,  └─ Friend's agent session
                   awareness)     in memory)
                                      │ snapshots + plain source files (debounced)
                                      ▼
                                   storage
```

### Document room (one per document; a Durable Object on Cloudflare)

- Holds a Yjs doc: a map of path -> `Y.Text`, one per text file (pages,
  stylesheets, scripts). Binary files (images) are stored by content hash
  with a versioned reference, last write wins.
- Clients sync with the Yjs protocol over a WebSocket; awareness carries
  presence: cursors as Yjs relative positions, names, colours, and agent
  activity ("Pete's agent is editing §3", "agent busy").
- While live, the room is the source of truth. It persists Yjs
  updates/snapshots and writes the plain source files on a debounce, so
  publishing, the CLI and git still see ordinary files.
- Edits that arrive as files (`scratchwork publish`, git, a local edit on
  disk) are diffed against the room's text and applied as ordinary edits:
  the word diff and rebase in `wip/editor/src/page/merge.ts`, pointed at the
  shared doc.

### Human editor (browser)

- The page editor keeps its CodeMirror `EditorState`, bound to the file's
  `Y.Text`: local transactions become Yjs updates; remote updates come in
  through the same path agent edits use today (`PageEditor.applyExternal`),
  so in-place patching, change marks and track changes keep working, now
  attributed per author.
- Undo is a `Y.UndoManager` scoped to the local origin: ⌘Z never undoes a
  collaborator's (or an agent's) edits. "Undo the agent's last change" can be
  its own action.
- Track changes' baseline becomes a Yjs snapshot, so "changes since tracking
  started" covers every author.
- Remote cursors are drawn with the overlay/highlight technique the change
  marks use (source position -> page position is already solved).

### Agent editor (server side, one session per person per document)

- Each session is its own Durable Object: holds that person's transcript and
  runs, and joins the room as an ordinary Yjs peer. The room never holds a
  conversation; a long run doesn't load the room; closing the tab doesn't stop
  the agent.
- Runs on pi's agent core (`@mariozechner/pi-agent-core` + `pi-ai`), not the
  Node-only coding-agent package, with our own tools over the session's
  replica of the shared doc. Write the agent against a small workspace
  interface (read/write/edit/list/search files, view the page) so the same
  agent could run in a browser later if we ever need it to.
- Tools:
  - `read`: the current text.
  - `edit(path, oldText, newText)`: find the unique match in the *current*
    text, apply a minimal delete+insert in one transaction tagged with the
    agent's identity. If the target text changed, fail cleanly ("not found,
    re-read"); this exact-match aim is what makes stale agent knowledge safe.
  - `write`: diff against the current text and apply minimal ops (never a
    wholesale replace), so concurrent edits elsewhere in the file survive.
  - `view_page`: ask one of the owner's open tabs to render the latest
    version and capture it (the current browser-side capture in
    `wip/editor/src/page/main.ts`, `captureView`); fall back to a server-side
    renderer (Cloudflare Browser Rendering) when no tab is open.
- The model API key lives only on the server.
- The "agent busy" signal rides on awareness, so clients keep deferring
  structural re-renders until the agent's turn ends (as they do now).

### How agent edits merge

At the Yjs level, exactly like a person's: inserts and deletes from a client
ID, same convergence. What differs is above Yjs:

1. **How the edit is made**: re-aimed against current text by exact match at
   apply time, rather than positions on an always-current replica.
2. **Granularity**: one transaction per tool call, whole chunks at once.
   A concurrent insert inside text the agent deleted survives (Yjs only
   deletes what existed); exact-match edits make this rare, and if it bites,
   agents can refuse edits that overlap a region a person is actively editing
   (awareness shows their cursor) and retry.
3. **Attribution and undo**: transactions carry who made them.
4. **Permissions**: checked when the agent acts, before Yjs.

## Why the agent runs server side

Considered: the agent in the browser, sharing an in-memory file system with
the editor. Edits would be instant locally and view_page local. Decided
against it because the agent would die with the tab (handoff to a server
runner needs leases and two identical runtimes), the API key needs a server
anyway, and with the agent editing the in-memory shared doc (not disk) its
edits reach the page in one network hop, 20-80 ms, which disappears next to
model latency. If that hop turns out to feel laggy, the agent ports to the
client because it's written against the workspace interface.

## Open questions

- AWS: no Durable Object equivalent. A pinned fleet of long-lived processes,
  or API Gateway WebSockets plus a database-backed update log. The room needs
  a platform-neutral contract with adapters (invariant 6); build Cloudflare
  first.
- Presence for agents: show a labelled cursor while it works (leaning yes).
- Same-sentence conflicts between a person and an agent: is the overlap guard
  needed in practice?
- Remote "edit with Claude Code from your machine" (a document URL plus a
  copied prompt with a temporary token, an HTTP file API): becomes another
  participant through the same edit path. Later.

## Plan

1. **Local room.** Turn `wip/editor/open.ts` into a one-room server for the
   open folder: a Yjs doc of the folder's text files, sync + awareness over a
   WebSocket, files written back on a debounce, disk edits merged in (replaces
   the current watcher + versioned PUT saves).
2. **Editor on Yjs.** Bind the page editor and source views to `Y.Text`;
   scoped undo; remote edits through `applyExternal`; attribution in change
   marks and track changes; remote cursors and selections drawn on the page.
   Two browser windows show each other's cursors and live edits.
3. **Agent as a participant.** Move the agent off the disk onto the shared
   doc: pi agent core + our tools against a replica, agent identity and
   presence, per-person transcripts (two "users" locally, e.g. a name per
   tab), view_page through the owner's tab.
4. **Hosted.** Room and agent session as Durable Objects in the Cloudflare
   deploy, behind the server's auth and route policies; persistence to R2/D1;
   source files materialised for publishing.
