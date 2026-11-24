Markdown review renders a markdown document and lets you comment on it the way review assist does
on a diff: comment on any block, suggest replacement text for its lines, and send the comments to an
agent in the workspace.

## Using it

Open a `.md` or `.markdown` file, then pick **Open with → Markdown review**. The document renders
with headings, lists, quotes, code blocks and tables. Code blocks are colored by their fence's
language where Paseo's highlighter knows it, and a `mermaid` block is drawn as its diagram: any kind
mermaid draws, from flowcharts and sequence diagrams to mindmaps, Gantt charts and pies. Hover a block and press **+** to comment on the
lines it is written on, and shift-click another block's **+** to widen the comment to it; on a
touchscreen, tap a block and long-press another. Ctrl+Enter, or Cmd+Enter on a Mac, saves the
comment you are writing. The view follows the file as it changes on disk.

Comments are drafts kept on the daemon until you send them. **N comments** in the toolbar sends this
document's comments to an agent in the workspace, with an optional message, as the same review
attachment Paseo's Changes panel sends; a running agent takes them into its current turn. In a
workspace with no agent yet, pick a model, mode and thinking level, and sending starts one with
them.

**Edit selected lines**, on a comment, fills in the lines' current text for you to edit; left empty,
it deletes them. Sending writes the suggestions into the file itself, before and without the agent,
which only hears which lines were edited. With only suggestions, the toolbar's **Make N suggested
edits** applies them without an agent.

## Settings

**Settings → Plugins → Markdown review → Updates** asks Paseo whether the source the plugin was
installed from has a newer version, and links to the changes. Nothing is installed until you press
**Update**, which runs Paseo's own plugin updater on the daemon host.

Draft comments are stored on the daemon host under `~/.cache/paseo-markdown-review` (or
`$XDG_CACHE_HOME`), kept per repository for documents in one and per directory otherwise.
