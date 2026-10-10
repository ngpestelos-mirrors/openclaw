---
doc-schema-version: 1
summary: "Sidebar zones, session menus, and the New session page"
read_when:
  - Finding, grouping, or renaming sessions
  - Sharing a session with teammates or through a public read-only link
  - Starting a session on a device, worktree, or cloud profile
  - Starting a native Codex or Claude Code terminal
title: "Sessions and sidebar"
sidebarTitle: "Sessions and sidebar"
---

The sidebar separates navigation into **Pages**, **Sessions**, and **Online**.
The New session page starts new conversations.

## Navigation rail

The icon rail stays separate from the selected navigation list. **Pages** opens
available built-in pages, dashboards, and plugin destinations, **Sessions** opens conversations,
and **Online** shows connected people. Hover or focus an icon for its name.
Home, Inbox, and your account controls stay together at the bottom of the rail.
Home toggles the Home panel and shows the active agent’s Home activity and attention state.

Drag a page, dashboard, session, or person into the rail to create a personal
shortcut. Drag shortcuts to reorder them, or use their menu to reorder or unpin
without dragging. Unpinning removes the shortcut, not the session, dashboard,
or person. Pinning a session does not change its owner, sharing, archive state,
or another person's sidebar.

A person shortcut opens that person's accessible work. Going offline does not
remove a saved shortcut. A pin does not grant access: destinations still apply
their normal permissions, and temporarily unavailable resources keep their saved
position rather than being deleted from your preferences.

### Mine and All

Sessions has one navigation entry with two scopes: **Mine**, owned by your
profile, and **All**, the sessions you can access. This is separate from
**Involving me**, which also includes participation and mentions.

When complete ownership information shows that both scopes are equivalent, the
extra scope control is hidden. Other people going offline, an incomplete roster,
or a partially loaded page does not establish that equivalence. Your preferred
scope is retained if the control temporarily disappears.

### Personal navigation storage

For authenticated profiles with write access, pin references, their order, and
the preferred session scope use the existing Gateway user-preference store and
follow the profile across devices. Navigation is not a shared server setting. Initial
migration preserves legacy shared navigation order and accessible pinned sessions
without overwriting preferences already saved for the profile, including an empty
pin list. Concurrent saves use conflict checks and preserve unrelated pin edits.

The browser keeps device-specific geometry and transient presentation, such as
sidebar width and scroll position. Navigation changes on read-only connections
or connections without a durable profile stay browser-local rather than writing
another person’s layout or shared Gateway configuration.

New session previews the first prompt immediately while the Gateway accepts it.
The submitted browser draft is retired before the confirmed conversation URL is
committed, so closing the tab does not restore a sent prompt. Saved worktree-name
preferences can finish clearing alongside navigation.

## New session names

In **New session**, pausing typing for one second prepares a session name in the
background using only the selected agent's utility model. Preparation sends unsent
draft text to that provider before submission. It starts after at least 12 characters
and sends at most the first 1,000 characters; it does not send attachments.

Preparation is disabled in incognito and for slash commands. Edits replace stale
prepared names, and only one request runs at a time. A missing or failed utility model
does not fall back to the primary model or prevent you from starting the session.

An explicit personal account selection waits for account confirmation before
preparing a title. A utility model on the same provider uses that account unless
the utility model specifies its own auth profile. Changing the model or account
discards the old suggestion; neither action changes your saved account default.
With **Automatic**, title preparation uses the agent's utility-model auth, which
can differ from the personal default selected when the actual chat starts.

**Start session** uses a matching prepared name if it is ready. Otherwise, normal
initial naming runs after submission; Start never waits for the speculative call.
This is creation-only: later messages do not regenerate an existing session's
name. Explicit worktree names are preserved, and typing never creates a worktree
or runs setup.

If automatic naming fails after submission, the session receives a two-word,
crustacean-themed name. New worktree branches use the saved session title when
available, with the same two-word fallback if naming has not finished. They never
use the first-message text as a branch-name fallback. A title that arrives later
updates the sidebar without renaming an existing branch.

## New-session preferences and recents

In **Project → Browse**, keyboard focus moves to the folder path. Escape returns
focus to **Browse**. Loading and folder errors are announced without moving focus
away from the path field.
Enter opens the typed path; use Up or Down first to open a highlighted folder.
Tab completes a folder name. If the starting workspace does not exist yet, Browse
opens the home folder. Errors for paths you enter remain visible.

For connections with a durable user profile, the Gateway stores each agent's latest folder, worktree, model, thinking, and fast-mode choices. New sessions restore the last fast-mode choice, including an explicit off choice, for supported providers. The new-session picker also shows recent projects and folders derived only from sessions created by that profile. These conveniences follow the person across browsers; they do not grant access to a project or path.

A custom worktree **Name** applies to the submitted session. Once its start is
accepted, New session clears that name while remembering the repository, checkout
mode, and base branch. Background starts do the same. Failed admission leaves the
name available to retry; an accepted placement keeps its original session and
worktree request for recovery, even if workspace preparation later fails. If
clearing the saved name cannot be confirmed, the UI warns you to check Name
before starting another worktree; the accepted session continues. Cleanup preserves
newer checkout choices saved by another draft or browser, and keeps concurrent
model changes. A restored start whose original base choice cannot be distinguished
from a later edit also leaves the saved name unchanged and shows that warning.
If saving a new draft choice cannot be confirmed, a separate warning asks you to
check the choices before starting; session creation is never retried by preference cleanup.

On the first identified connection, the Control UI uploads existing browser-local new-session preferences only when the Gateway has no such preferences yet. Concurrent first connections preserve choices already saved by another browser, including a cleared worktree name. Later changes write to the Gateway first and then update the browser mirror. Connections without a durable identity continue using browser-local preferences and the loaded session roster for recents.

When a remote project session starts before its repository finishes cloning, chat shows workspace preparation progress. If preparation fails, opening or reloading chat restores the session's failure summary. Correct the reported problem, then send a new message in the same session to retry preparation.

Accepted browser messages, including initial prompts waiting for workspace
preparation and follow-ups during a run, remain visible as normal message bubbles
until their own turn starts, without an additional receipt notice. Inputs accepted through `sessions_send` or the
Gateway `agent` method use the same display. They are stored separately from the active model transcript. If
cancellation or a Gateway restart interrupts that wait,
the message stays readable with its recorded disposition and is never resent
automatically. Stopped messages stay at their original time in the conversation,
before messages sent later; only inputs still waiting to run stay at the live edge.
Copy a stopped message into the composer to start a new attempt. **Show earlier
messages** pages through messages that are still waiting or were stopped before
processing; **Show latest messages** returns to the newest page. Incoming activity
refreshes the page you are reading without changing your selection. A long message
uses the normal full-message reader without becoming a transcript reply, fork,
or rewind target.

The composer stays available while a new chat starts. You can keep typing and
queue follow-up messages; they wait behind the initial prompt and keep their order.
Before the Gateway confirms the new session, these follow-ups stay in the current
tab, so keep it open. If creation fails, the original prompt, queued follow-ups,
and unfinished follow-up draft remain available for retry. Once creation succeeds,
follow-ups use the confirmed conversation’s normal outbox. A failed initial prompt
keeps its follow-ups paused for review rather than sending them ahead of it.

Browser drafts and unsent messages remain in the local queue. Once the Gateway
accepts an ordinary browser message, it owns the approved input in durable
custody. Collect mode consumes the accepted sources with their combined
transcript entry. Acceptance does not imply that a transcript row already
exists; the accepted input replaces its local pending copy and later becomes
one canonical message, including its attachments.
Messages keep their queue position through submission, acceptance, reconnects, and
storage recovery. Changing delivery status does not reorder them; explicit queue
reordering and steering retain their normal behavior.

## Systems workspace

Open **Pages → Systems**, or visit `/systems`, to inspect the Gateway, worker
environments, and paired devices available to your connection. Use the pin button
beside Systems in Pages, or drag it into the rail, to keep a personal shortcut.

While Systems is open, select **Sessions** in the rail to show its contextual
machine list in place of conversations. Pages and Online remain separate views.
The middle list scrolls independently of the rail; the sidebar header and the
rail’s bottom controls stay fixed. Returning to conversations restores their
sidebar scroll position. Navigation changes this context; background machine or
session activity does not switch your workspace.

Use **Filter & sort machines** beside the search field to sort each group
alphabetically, online first (the default), or offline first. Choose **All**,
**Online**, or **Offline** to filter by reported status; search narrows that
selection further. Starting, stopping, and error states remain visible under
**All**. Filtering does not change the machine open in the workspace. These
choices stay in place when you leave Systems and return on the same connection.

The machine list excludes cloud workers whose teardown is complete, including
retained records from archived sessions and failed starts with no allocated
machine. Workers awaiting cleanup remain visible. Archiving stops running cloud
workers through the normal workspace-reconciliation flow; failed placements keep
their existing cleanup retries and recovery history.

Select a desktop-capable system to open the existing Desktop viewer in the main
workspace. It uses the same connection, control, sizing, and fullscreen behavior
as the Desktop panel. Headless and offline entries remain inspectable instead
of opening an empty desktop. Pairing, desktop enablement, and operator permissions
still apply; opening Systems does not grant additional access.

System details use reported facts. A connected device is not necessarily the
machine running a session, and unavailable measurements are not shown as zero.
See [Cloud Worker Desktop](/gateway/cloud-workers/desktop) for worker desktop
enablement and sizing.

## Sidebar navigation

The **Filter & sort** popover keeps **Filters** and **Display** in one panel.
**Filters** controls owner, status, automation, and system sessions. **Display**
controls grouping, sorting, message previews, and empty groups. Choices take
effect immediately. The filter button shows a dot while **Owners** or **Status**
differs from the default. **Reset** appears at the right of the Filters header
whenever any visible Filters or Display setting differs from its default. It restores
all visible settings: All owners, Active status, automation and system sessions off,
Custom groups, Created sort, When filtering for empty groups, and message previews off.
Display choices never add a filter dot. Tab moves between rows; Left and Right choose within a segmented
status control. **Owners** opens a picker with owner avatars and a search field;
type to filter owners by name, and Escape clears the search before closing.
**Group by**, **Sort by**, and **Hide empty groups** show their current choices
and open submenus on hover or click. Right opens a submenu and Left closes it (reversed in RTL);
Up and Down move between choices, and Enter selects. Automation, system sessions,
and message previews use consistent on/off toggles. Escape closes an open picker first, then the popover and returns
focus to the filter button. **Session sources** opens its Settings destination. In **Show all agents**
mode, Display omits grouping and empty-group controls because the sidebar always
groups by agent. Reset leaves those hidden preferences unchanged. It also preserves
a saved Person grouping while owner data temporarily makes that choice unavailable.

On phone-width layouts the panel opens as a bottom sheet, like the issues sheet:
tap the backdrop or press Escape to close it. The sheet has no hover or flyouts:
tapping **Owners**, **Group by**, **Sort by**, or **Hide empty groups** opens its
choices as a page inside the sheet, with **Back** and the current choice checked.
Choosing applies it and returns to the main page. The Owners page keeps its search
field above the scrolling owner list. Status and the toggles stay on the main page.

The chat header links to an accessible parent session even when it is outside the current session list, including Incognito parents.

The agent switcher and workspace header preview their menu when you move the
pointer over them and pause. Click the header to keep the menu open. Returning
from Settings leaves menus closed under a stationary pointer.

Drag rail shortcuts, including plugin-provided destinations, to reorder them
together. The personal order survives reloads. A temporarily unavailable plugin
keeps its saved position for when it returns. Home, Inbox, and the account controls
stay fixed at the bottom; unpinning a destination does not remove it from Pages.

To reorder without dragging, focus or hover a rail shortcut or a stored
session-section header and open its **Reorder** grip menu. Choose **Move up** or
**Move down**; the same menu is available on touch screens. Keyboard focus stays
with the moved item, and the order uses the same saved preferences or Gateway
group order as dragging. Home and sections derived from people, projects, or
agents keep their existing fixed order.

Use each destination’s pin button in **Pages** to add or remove its rail shortcut.
The rail’s **Reorder** menu also offers **Unpin**. Pages is a resource catalog,
not a second ordered list of favorites.

To inspect Home’s subagents, open **Home** and select **Subagents**. The side panel lists ordinary child runs and opens their view-only transcripts without replacing Home. Swarm members remain in the parallel-tasks view. You can also use `/subagents list`, `/subagents info <id|#>`, or `/subagents log <id|#>`. See [Sub-agent slash command](/tools/subagents/slash-command).

Follow-up turns in an existing subagent session keep the parent’s activity ring running, even after the original task has finished. Opening the parent refreshes its hidden subagent activity without adding subagent rows to the sidebar. The ring clears when no work remains active.

When a child run fails or publishes an attention request, the parent chat shows the child’s name and full diagnostic above the composer, even if the parent has no new reply. **Open session** opens that child’s details. Opening the parent does not acknowledge a child’s active attention request; its notice follows the child’s read state, explicit clearing, and expiry.

Hover a session to see its project and branch. Repository details and the working directory stay in the hovercard and tooltip, leaving sidebar rows clear for session titles and activity indicators.

Hover a session with an enabled automation and choose **Automation attached** to open its **Automations** page. A single matching automation opens directly in the editor; multiple matches appear in a session-filtered list. You can inspect settings and history or edit with the usual permissions. **Show all automations** clears the session filter. Cmd/Ctrl-click opens the link in a new browser tab.

Inside the **Sessions** view, the default chip mode organizes conversations around the active agent. The identity row at the top is that agent. Pages and Online have their own navigation views instead of appearing above the conversation list. The session list splits into zones: **Other** for the agent's ungrouped chat sessions (the main session is represented by Home rather than an ordinary session row, including when it is pinned or has subagents; independent conversations it spawned appear here as top-level threads, and named threads show without a type prefix), **Groups** for group and room conversations, and **Coding** for sessions bound to a managed worktree or exec node (rows show a `repo ⎇ branch` line plus the node host), ACP-backed harness sessions, and external CLI catalogs. The **Other** heading is omitted when it is the only section. Coding starts collapsed on first run and remembers your choice; its collapsed header keeps the true count and shows a running indicator while contained sessions work. Custom groups (the session `category`) sit above Other, while personal pins live in the rail, and assigning an independent session to a custom group wins over the automatic zone classification. The global **Sessions** toolbar holds **Filter & sort** and the **+** that opens the New session page. Inside **Filter & sort**, **Display** contains sorting (Created, Updated, or Owners when the loaded session roster contains multiple owners) and **Group by** — **Custom groups** (the default zone layout above), **Project** to bucket sessions by their repo or workspace checkout (sessions without one keep their zones), **Person** to bucket by owner when the loaded roster has several, or **None** for a single flat list with no zone headers. **Filters** contains the persisted **Status** filter for Active, Snoozed, Archived, or All. The Owners sort mode orders owner groups by name and keeps Created order within each group. On multi-user gateways **Filters** starts with an **Owners** filter, above Status: **All owners**, one specific person or agent, or **Involving me** — sessions you own, have prompted, or have been explicitly mentioned in, excluding sessions you personally hid with **Hide from Involving me**. A new explicit mention brings a hidden session back. **Show in Involving me** restores it from **All owners**. The personal Hide/Show menu entry appears only when the Gateway has more than one identity. These personal choices do not archive sessions or alter access, and the Gateway evaluates the filter before pagination (see [Multi-user mode](/concepts/multi-user#finding-sessions-by-owner)). Archived rows stay inline, dimmed with an archive glyph; they do not contribute unread or attention state and stay outside lineage promotion. Opening a session moves the selection highlight without reordering rows. Parents with nested persistent sessions or forks show a disclosure and child count; expand it to inspect those sessions, their status, and runtime without leaving the sidebar. Selecting a nested session opens its chat and reveals its ancestor path. If a persistent session has subagent runs between it and its nearest loaded non-subagent ancestor, it nests under that ancestor. If no such ancestor is loaded, it keeps its normal top-level placement. Nested rows stay outside root pinning, multi-select, and pagination until promoted. Drag a child onto **Move to top level**, the session list or a custom group, or choose **Move to top level** from its menu. Promotion preserves the conversation URL, transcript, workspace, origin link, and active execution relationships; the conversation then supports ordinary root organization. Moving it to a group also keeps it independent if that group is later removed; collapsed zones do not consume the visible page budget. Personal pinning remains separate: promote a child first, then add its shortcut to your rail. Subagent runs never appear as sidebar rows, even when selected or assigned a custom group, and do not add a disclosure to a parent with no nested persistent sessions. Inspect them through their session transcripts. Sessions with new activity since they were last read show an unread dot, and opening one marks it read. Accepted work immediately shows an activity ring around the row’s own icon for Home, sessions, child sessions, and catalog rows; a row without an icon shows a compact ring in the icon slot. Subagent runs still contribute to their ancestors’ running, queued, and failed counts, unread attention, and failure warnings. Opening that ancestor, or choosing **Mark as read** on it, also acknowledges the unread subagent runs it summarizes, even when the ancestor itself was already read. Failed runs, manual unread marks on a run, and run activity after the read stay unread; nested persistent sessions keep their own unread state. A session’s ring stays active while its subagents work. When only delegated work is executing, the ring is labeled **Subagents working**. Select an ancestor’s child-failure warning to inspect the failed run in chat without adding a sidebar row. Collapsed groups and collapsed child toggles summarize hidden running rows on the right. It spins during startup and execution, pauses with **Queued** only during a scheduler-confirmed concurrency-slot wait, and resumes when a slot is granted. With reduced motion enabled, the ring stays still. A session holding composer text you typed but never sent shows a pencil badge until the draft is sent or cleared; the active session hides it because its composer is already in view. An agent can also publish a short expiring status line and optionally request attention with a curated amber icon; that declaration clears when you open the session, send the next message, clear it explicitly, or its TTL expires. Cloud-worker lifecycle states use a globe badge; local and reclaimed sessions omit a placement badge because local execution is the default. Each session row offers a direct **Archive** button alongside **Pin**; archived rows offer **Restore**. Archive affects that conversation only. Unarchived persistent children remain available at the top level while their parent is archived. **Archive session and children…** in the session menu collects the accessible nested conversations, including collapsed descendants, and confirms the affected count. Promoted or separately grouped conversations and already archived branches are excluded. Running work is called out before confirmation. Concurrent promotion, grouping, or archival rejects that target instead of archiving a newly independent conversation; partial failures are reported, and **Undo** restores only successful targets from the action. Right-click a row, or focus its link and press **Shift+F10** or the **Menu** key, to open the full [session menu](#session-menu). Touch layouts keep Pin, Archive, and a separate menu button visible so every action remains available without right-click. The chat header also provides the session menu. The chat header composes the same single-session management actions with its pane-specific **Panels**, **Layout**, and **View** actions. Cmd/Ctrl-click opens a session in a new browser tab. Alt/Option-click toggles root rows into a multi-select and Shift-click extends it across the visible order; opening the menu on a selected row then offers batch actions (Mark N as unread/read, Move N to group, Archive N, Delete N) that apply to every selected session, with a single confirmation for batch delete. Drag a root session into the rail to pin it personally, or onto a custom group to move it. Custom group headers can be collapsed, expanded, or dragged to reorder them; group names, order, and New Session defaults live in the gateway (`sessions.groups.*`), so they follow you across browsers, while collapsed state stays in the browser profile. Each custom group header has a **+** that opens the normal New Session page and assigns the created session to that group. When the **Other** header is visible, its **+** opens an ungrouped draft without inheriting the current named group. **New session defaults** in the group menu sets its working directory and Local or Worktree preference; the page prefills those values but leaves them editable. Leaving the directory empty uses the selected agent's workspace. A Git repository without an initial commit can use Current checkout; creating a Worktree requires an initial commit. The menu also has Rename group, New group, and Delete group; renaming or deleting a group updates every member session server-side, including archived ones, and deleting a group keeps its sessions and moves them back to Other.

Persistent child conversations and forks stay nested after their turns finish,
including after a reload or Gateway restart. Archiving hides them from the
**Active** list; restoring them brings them back under their parent.

Choose the **Show all** tile in the agent switcher to enter **team mode**, which shows every selectable agent as a collapsible session group. It is off by default, and the browser remembers your choice and each agent's collapsed state. Groups start expanded. Headers emphasize the agent's avatar and name. Activity, attention, unread, and workspace indicators sit on the right of session rows; collapsed parents summarize hidden work and outcomes there. Agent headers show their indicators in a wrapping row below the name and controls. A row shows each status once, even when both the parent and a hidden child share that status. Session icons stay to the left of their titles in both sidebar modes; status indicators and actions stay on the right. Nested children indent 16px per level without moving the right edge of the trailing indicators. Groups keep the configured agent order as activity changes. Agent headers have a minimum height of 48px with 36px avatars and grow to fit their metadata; session rows stay on one line at 32px on desktop. Each agent header is its Home entry: selecting the name or avatar opens the main conversation and highlights the header. Home does not appear again as a session row, even when pinned. The header shows Home activity, unread state, and attention while expanded, and summarizes the group's hidden sessions while collapsed. Independent conversations created from Home remain visible beneath the agent.

Session-row owner avatars appear automatically when the signed-in user and session roster identify more than one human. With only one human, owner avatars stay hidden even when agents own or participate in sessions. Agent participants and undisplayed participant counts do not enable attribution. Session icons, channel avatars, and activity indicators keep their usual behavior.

Observer assessments such as **stuck** or **waiting on user** stay with their session instead of opening a global toast over another conversation. This does not change explicit questions, approval requests, action feedback such as **Archive → Undo**, or completion notices for sessions you explicitly start in the background.

Pending questions and approvals show their specific request when you tap, hover, or keyboard-focus the attention icon. Tapping the icon keeps the sidebar open; tap again or press Escape to dismiss the preview. The tooltip includes the oldest question, compact command, or approval title, plus a count of additional questions or approvals. This works in the regular list, Home, and team mode, including collapsed parents and agent groups. Questions and approvals take priority over agent attention notes and failed runs; requests at the same priority show the oldest first. Answering, approving, cancelling, or expiry clears that request and reveals the next one. Previews wrap and truncate without adding another line to session rows. Secret questions show only the question text, never entered answers.

The top row becomes a neutral workspace header with the configured Gateway display name, or **OpenClaw**, and a small static OpenClaw mark aligned like the agent avatar. Both modes use the same menu. The **Show all** tile groups the configured agents’ own avatars and appears only with multiple agents. Below the switcher, **New agent** and **See all agents** come before a divider and the active agent’s named capabilities and settings actions. **See all agents** opens `/agents`; Help stays in the account menu. Choose an agent tile to leave team mode with that agent selected. The sidebar header toolbar contains collapse, search, session filters, and **+** controls.

Agent avatars use the same precedence throughout the dashboard: an identity image (a data or same-origin URL), then the identity emoji, then a generated face. The face is stable for the agent ID, including after a rename, and uses crisp vector artwork in the sidebar, switcher, New conversation menu, Agents home, identity chips, and chat. Configured workspace images also appear beside assistant replies after authenticated loading. A missing or failed image reveals the emoji or generated face. System agents always use the OpenClaw product mark, including in onboarding and custodian conversations; they never use a generated face. People keep their own profile images and initials.

In both sidebar modes, **Home** stays at the bottom of the rail, not in Pages. Click a group header's avatar or name to open that agent's canonical main chat; its separate expand/collapse control folds the group without navigating. The top **+**, labeled **New conversation**, opens a small agent menu with each agent's avatar and name, in the same order as the groups. Choosing an agent opens `/new?agent=<id>`. Each group's **+** opens that link directly. It appears when the header is hovered or contains keyboard focus, and stays available on touch devices. Turning team mode off restores chip mode and its direct **New conversation** button; Home remains in the rail.

Choosing **Show all** defaults the shared page scope to **All agents**. Choosing a named agent tile leaves team mode and scopes pages to that agent. This sets a default once when the mode changes: you can select an individual agent afterward, and page navigation preserves your choice. Automations, Dashboards, Sessions, and Usage support all-agent views. Mixed-agent lists identify the agent on each row with an avatar and name where needed. Each identity chip includes the agent ID in its tooltip and screen-reader label, such as `Molty (agent:main)`, so agents with the same display name remain distinguishable. If no name is available, the label uses `agent:<id>`. In Settings, the agent selector below the sidebar title keeps the same target across Agents, Models, Memory, and Skills; global settings remain global. Skill Workshop uses the agent selected through chat. Open an agent's main chat from its group header to select it for Skill Workshop. Chat actions still target the conversation's agent.

Personal session shortcuts stay in the icon rail in both sidebar modes, mixed with page, dashboard, and person shortcuts in your saved order. They remain available when an agent’s group is collapsed. Rail shortcuts are flat icons: pinning a parent does not move or duplicate its child tree into the rail or Pages. Each agent group still contains its ordinary sessions, including those with personal rail shortcuts, with the usual session menus, unread badges, nested child sessions, section limits, and **Show more** controls. Selecting any session switches the active agent for chat while the workspace header keeps its neutral identity. The **Sessions** filters apply across all agent groups. Select the separate **Online** view in the rail to see who is online. Category, person, and project grouping controls remain in chip mode; team mode always groups by agent and keeps empty agent groups visible. The open conversation keeps its selected row, including an archived conversation opened directly under the default **Active** filter. The filter button in the sidebar header keeps the same session filters. Each agent header has a **New conversation** action and an options menu with **Open main chat**, **All sessions**, and **Collapse others**. **All sessions** opens the Sessions page and sets the shared agent filter to that agent. Agent-header metadata uses a wrapping second row, keeping the name and actions readable and the indicators visible on hover, keyboard focus, and touch. The expand control appears when the agent has other sessions or descendants to display. Session rows reserve space only for present indicators, so quiet titles can use the full row width.

Groups share a window of at most 300 sessions across agents with [Agents home](/web/control-ui#agents-home). This bounds the session rows loaded for the groups, not the number of saved rail shortcuts; a personal pin does not reserve a place in that window. The open conversation can remain visible outside this window. **Involving me** loads the same bounded window filtered by the Gateway; the other filters apply to the loaded sessions across groups.

The active session list applies Gateway lifecycle row snapshots to existing members without reloading the whole list. Membership changes, missing or incomplete row snapshots, and Gateway-owned filters still require an authoritative list read. Automatic roster refreshes collect events in a randomized four-to-five-second window that later events cannot postpone, spreading reads across browsers. After an automatic refresh completes, the next waits three times its duration, bounded between five and 15 seconds. Explicit refreshes, filter or agent changes, reconnects, and foreground replacements bypass that delay.

Activity refreshes pause while the browser tab is hidden and catch up once when you return, respecting the automatic refresh delay. Changes that arrive during a roster read share one follow-up refresh; switching filters never combines pages from different filters.

The **Online** list opens a person's activity card with their reported device,
platform, and connection type: **Web**, **App**, **Terminal** for the TUI, or
**Command line**. Renaming a device does not change its connection type. Duplicate
device and platform labels are combined. Architecture labels such as **ARM** appear only
when explicitly reported; a browser's `MacIntel` value does not identify an Intel
CPU because Apple silicon Macs and desktop-mode iPads also report it.

Toggle the sidebar with **⌘B** on Mac or **Ctrl+B** on Windows/Linux. Open the command palette with **⌘K** on Mac or **Ctrl+K** on Windows/Linux. Mac **Ctrl+B** and **Ctrl+K** remain available for native text editing.

The search field updates immediately, while command filtering and session searches wait until you pause typing for 200 ms. Previous results stay in place during that pause but cannot be selected until the new query applies. Press Enter to apply a pending query immediately and select an available matching result. Clearing the field restores the default commands immediately.

During text composition, the command palette pauses searches and leaves Enter, Escape, and arrow keys to the input method.

After token or device-token authentication, the sidebar can show its cached session roster on reload only when the browser will present the Gateway token that authenticated the previous connection, or the paired device token retained from that connection. The cached roster has no live run state and is replaced by the live list after connecting. Other authentication methods wait for the connection; see [Warm reload](/web/control-ui/offline-and-reconnect#warm-reload).

Switching agents refreshes the session list even while other conversations are active. A session action finishing for another agent keeps the selected agent’s filtered sidebar and pagination active. Confirmed permission changes remain visible if their follow-up list refresh fails. Read acknowledgments for known sessions update unread and attention state from their committed receipt without reloading the roster. Older responses cannot undo confirmed read state; newer activity or a later manual unread mark still takes effect.

**Load more sessions** stays disabled while the sidebar list is refreshing or loading another page. It becomes available again when the read finishes and more sessions remain.

An older list response preserves newer session names and run status already loaded in another open session list.

Loaded persistent child-session rows stay visible while an expanded or selected parent fetches updated child data after a session-list refresh. Child loads preserve newer names and run status already observed in other session lists. A selected child also adopts its refreshed name and run status as soon as its details arrive, including while its ancestors are still loading. Its ancestor path refreshes when the session is replaced or its parent changes, including in filtered lists. Collapsed, unselected parents drop stale child snapshots on refresh and reload when reopened; the selected session's ancestry stays available. A loading placeholder appears only when the parent has no loaded child rows yet. Child-load errors remain visible until you choose **Retry** or collapse and reopen the parent. In **Active**, archived children stop contributing to the parent’s child count. A completed child load also removes links to absent children after a reload; unloaded or failed child reads keep their discovery controls.

**Archived** hides active sessions even when their conversation remains open. In **Active**, a directly opened archived session can retain its selected row. Archiving a visible session hides its row immediately while keeping its conversation open. Repeated archive actions stay disabled while the Gateway confirms the request. Confirmation offers **Undo**, including when you leave the Sessions page before the archive finishes or navigate away from the archived chat while the notification remains visible. Undo targets the original conversation and expires on a Gateway reconnect. If the request fails, the row returns with an error explaining what prevented archiving. Confirmed archive and restore changes remain applied to loaded rows if the follow-up refresh fails. If archiving already removed a row from every loaded list, Undo needs a successful refresh to show it again. The refresh error is shown separately; it does not undo a successful archive or restore. Refresh the session list to recover missing rows.

**Snooze** hides an eligible session from the **Active** sidebar until its wake time,
until you send it a message, or until an agent run completes on it. The session
stays active: snoozing does not stop a run, block messages or agent tools, disable
automations, or change its worktree. System events and runs that preserve the
session's visible state do not wake it. Snooze is saved by the Gateway, so
connected clients share the same wake time.

Choose **Snoozed** in the Status filter to find snoozed sessions, or **All** to see
them alongside awake and archived sessions. Snoozed root rows show **Wakes** and
the local wake time. The row menu's **Wake session**
item also shows the scheduled time; choose it to bring the session back early.
The snooze confirmation offers **Undo**. Snoozing a session keeps its personal
rail shortcut. Adding or removing that shortcut does not wake the session or
change its snooze time. Archiving clears its snooze.

Session previews are hidden by default for compact, single-line rows. Enable **Show message preview** in the **Sessions** filter menu to restore routine status text and message previews. The browser remembers your choice. Errors and requests for attention remain visible with previews off. Team mode keeps all session rows on one line. Three fixed slots on the right show the collapsed child count, unread state (a dot for one, a count for more), and activity or attention. Requests for input and errors take priority over activity in the state slot; expand a parent or group to inspect each conversation. Collapsed agent groups use the same slots. Nested expand controls are plain carets in the left gutter.

**Hide empty groups** in the same menu shows your current choice and opens three options:

- **When filtering** (default): hide native session sections with no matching sessions while a specific owner or **Involving me** is selected.
- **Always**: also hide empty native sections in the unfiltered view.
- **Never**: keep empty groups available while filtering. Sessions still obey the active filters.

This is a personal display preference, stored in this browser separately for each signed-in user and Gateway. It does not change another person’s view, group membership, order, or session access, and it is not synced across devices. Connections without an identified user keep a separate browser-only choice. An existing on/off browser choice is adopted once by the first resolved viewer: on becomes **Always**, while off becomes **When filtering**. Later viewers do not inherit that migrated choice.

Changing or clearing an owner or status filter never changes the saved preference.
**Reset** in the popover restores **When filtering** when the empty-group control is visible. Populated groups stay visible even when collapsed, and hidden custom groups remain available in **Move to group**. Choose **Never** to recover their headers as drag targets. Catalog sections and empty agent groups in team mode retain their existing behavior. On phone-width layouts, the choices open as a page inside the filter sheet, with **Back**. Escape returns focus to the setting without closing the filter panel.
