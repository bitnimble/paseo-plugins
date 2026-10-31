Review assist adds a **Review** panel to every git workspace that turns a large diff into a guided
review. An agent splits the changes into sections by intent and layer of the stack, gives each a
title and a short description, and orders them so each section builds on the ones before it. You
step through the sections one at a time, tick **Viewed** on each file as you finish it or mark the
whole section at once, and jump to any file from the side pane; a section is done once all its files
are viewed. A toggle switches back to the plain full diff at any point.

The agent never writes diff text. It only answers with line ranges into the real diff, so every line
you review comes straight from git, and the sections always add up to exactly the full diff. Lines
the agent leaves out are shown under **Other changes**. Files `.gitattributes` marks
`linguist-generated`, and otherwise lockfiles and minified files, are kept in a **Generated files**
section without being sent to the agent.

Each section shows the code as it stands after the sections before it: their changes read as
unchanged lines, and changes from later sections are not there yet. Line numbers are always those
of the real old and new files.

## Using it

Open a workspace and choose **Open guided review** from the Command Center, or open **Review** from
the Explorer. Pick which diff to review:

- **vs main** compares the working tree, including uncommitted and untracked files, with the
  merge-base of the default branch.
- **Uncommitted** compares the working tree with `HEAD`.
- Any other local or remote branch, picked from a filterable list, compares the working tree with
  that branch's merge-base.

Guides, viewed marks and comments are kept separately for each choice. Each Review tab reopens on
the diff it was showing, Guided or Full diff, and its section.

**View** switches between unified and split layouts, wraps long lines, hides lines that only
changed in whitespace, as `git diff -w` would, and lists the side pane's files flat or as a tree.
These change how lines are shown, never which section they belong to. Drag the side pane's edge to
resize it, or hide and show it with the button at the toolbar's left; these choices are saved on the
daemon.

**Filter files** at the top of the side pane keeps the files whose path holds every word typed, and
the guided review's sections holding any of them.

**Mark section viewed**, under a section's description, ticks every file in the section, and
**Mark section unviewed** clears them. The circle beside a section's title in the side pane does the
same without leaving your place.

When the panel is too narrow to hold the side pane beside a readable diff, as on a phone or in
Paseo's sidebar, the layout is always unified and the guided review shows every section in one
scroll, each under its title and description. The toolbar's button at the left opens the side pane
over the diff, with the section you are reading highlighted; it closes when you jump to a section or
file, or press beside it.

In the web and desktop apps on a computer each file is a Monaco diff editor with collapsible
unchanged lines. Once you trust the project, Ctrl/Cmd+click a symbol to peek at its definition,
and hover for its type, through a language server the daemon runs for the repository:
`typescript-language-server`, `pyright-langserver`, `gopls`, `rust-analyzer` or `clangd`, from the
repository's `node_modules/.bin` or the daemon's `PATH`. Removed lines have no language server
behind them. On phones and tablets, and while Monaco loads or when it cannot, the panel shows the diff with
Paseo's own syntax highlighting instead, marking the words that changed within an edited line; the
row between hunks shows the lines hidden there, 20 at a time with its arrows or all at a tap.
Changed images show before and after, as GitHub does; a text file whose diff `.gitattributes` turns
off (`-diff`) says so instead of passing for binary. Git LFS files show only their pointer's size
change until **Fetch and compare** downloads both sides.

Mermaid flowcharts and class diagrams (`.mmd`, `.mermaid`) open as a drawing of the change, with
**Visual** and **Text** in the file's header to switch to the text diff. Removed nodes, links and
class members are red, added ones green, and changed ones amber; removed text is crossed out, and a
changed label, title, shape or link shows its old value crossed out above its new one. Only the
nodes one link from a change are kept with it at first; the **Context** **−** and **+** buttons
above each diagram keep fewer or more links out, fading the nodes two or more links away. The rest
of the diagram is left out, a short stub drawn like the cut link and ending in a double slash, with
room kept for it in the layout, marking each side of a node whose links were cut, so a large
diagram shows only what changed and its surroundings. It starts fitted to the pane's width; the
buttons above it zoom, as does pinching on a phone, and once zoomed in, a drag pans it. The daemon
draws it in a worker thread, as an SVG for the web and a PNG for the phone apps; other diagram
kinds and files that don't parse say so above the text diff.

Markdown files (`.md`, `.markdown`) open as their text diff, with **Visual** in the file's header to
read the change as the document renders. Headings, paragraphs, list items, quotes, rules, code
blocks, raw HTML, front matter and tables are compared block by block: an edited block marks its
removed words struck out in red beside the added ones in green, and a code block its changed lines,
under an amber bar; whole added and removed blocks are tinted green and red, and a block that moved
to another heading level or was mostly rewritten shows as both. A table lines up its columns by
header, a renamed column with the one it replaces, and marks added and removed columns and rows,
and the changed words in each cell. Renumbering a list leaves its items unchanged. Unchanged blocks
fold away beyond two on each side of a change, unless a comment is among them, and the fold's row
shows them all. A change only to how the source is written, such as `*` for `_`, says so above the
text diff.

Comments work in the visual view too: hover a block and press **+** to comment on the lines it is
written on, shift-click another block's **+** to widen the comment to it, or on a touchscreen tap a
block and long-press another. A removed block's comment is on the old file's lines.

Files over 800 changed lines start collapsed. The review scrolls as one document with one
scrollbar; in Monaco a long file scrolls up until it fills the pane, holds there while its lines
scroll past, then moves on. Each file stops after 400 changed lines, or at its last comment, with a
button beneath that shows 2,000 more at a time.

Language servers can run a project's code, so as in VS Code they stay off until you trust the
project. A banner offers to, and **View → Hover and go to definition** switches it either way;
syntax highlighting works regardless. Trust is decided per Paseo project, covering all of its
workspaces and worktrees, and kept on the daemon, which refuses to start a language server for a
project that isn't trusted and stops a project's running servers once it is untrusted.

Press **Generate guided review**. The diff goes to an agent on the model picked in the plugin's
settings, and so to that model's provider. The agent runs in the reviewed workspace while it works,
so you can open it to follow along, and it is archived once it answers. A diff too large for one
agent is split by path into parts, one agent each, up to four at a time, and one more agent merges
and orders their sections; a part whose agent fails leaves its lines under **Other changes**. The result is
cached per diff on the daemon; when the diff changes, the panel says so and offers to regenerate.
Reading the diff uses a copy of the git index, so your staging area is never touched.

**Viewed** marks follow content, not sections: after a regeneration, a file stays viewed in a
section while the lines that section shows are unchanged, and goes back to unviewed once any of
them change.

## Review comments

Hover a line in Monaco and press **+** to comment on it; select several lines first to comment on
all of them. In the built-in view, tap a line number, and long-press another to widen the comment.
Comments are drafts kept on the daemon until you send them. **N comments** in the toolbar sends
them all to an agent in the workspace, with an optional message, as the same review attachment
Paseo's Changes panel sends; a running agent takes them into its current turn. In a workspace
with no agent yet, pick a model, mode and thinking level, and sending starts one with them, so the
comments go to that model's provider.

**Edit selected lines**, on a comment on the new side, fills in the lines' current text for you to
edit; left empty, it deletes them. Sending writes the suggestions into the working tree itself, before
and without the agent, which only hears which lines were edited. A suggestion whose lines have
changed since stops the send until you edit or delete it. With only suggestions, the toolbar's
**Make N suggested edits** applies them without an agent.

## Settings

**Settings → Plugins → Review assist → Model** picks the agent model. **Automatic** uses the first
of Claude Haiku 5.5, Claude Sonnet 5.5, GPT-6-Luna and GPT-6-Sol that a ready provider offers, and
otherwise the first ready provider's default model.

**Updates**, on the same page, asks Paseo whether the source the plugin was installed from has a
newer version, and links to the changes. Nothing is installed until you press **Update**, which runs
Paseo's own plugin updater on the daemon host. The build runs in the background, and the plugin
restarts on the new version once it's ready.

Guided reviews, viewed marks, draft comments and project trust are stored on the daemon host under
`~/.cache/paseo-review-assist` (or `$XDG_CACHE_HOME`).
