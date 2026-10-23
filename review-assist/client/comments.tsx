import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useContext, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { type CommentTarget, commentLine, commentTarget, rangeLabel, suggestible } from "../shared/comments";
import type { DiffFile } from "../shared/diff";
import { type FileBlock, isWholeFile } from "../shared/guide";
import type { DraftComment } from "../shared/protocol";
import type { SideLine } from "../shared/sides";
import { Button } from "./controls";
import { CentreAboveKeyboard } from "./keyboard";
import { MONOSPACE, tint } from "./palette";
import { hasMouse } from "./web";

export type CommentDraft =
  | {
      readonly kind: "new";
      readonly filePath: string;
      /** The block it was opened in: sections showing the same file share its lines. */
      readonly blockKey: string;
      readonly lines: readonly SideLine[];
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: "edit"; readonly comment: DraftComment };

export interface FileComments {
  readonly comments: readonly DraftComment[];
  readonly draft: CommentDraft | null;
  /** `extend` widens the open new comment, when it is on the same `lines`, instead of replacing it. */
  compose(lines: readonly SideLine[], start: number, end: number, extend?: boolean): void;
  edit(comment: DraftComment): void;
  cancel(): void;
  submit(target: CommentTarget, body: string, suggestion: Suggestion | null): void;
  remove(id: string): void;
}

export type Suggestion = NonNullable<DraftComment["suggestion"]>;

export function countByPath(comments: readonly DraftComment[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { filePath } of comments) counts.set(filePath, (counts.get(filePath) ?? 0) + 1);
  return counts;
}

export type Card = DraftComment | CommentDraft;

export function cardKey(card: Card): string {
  if (!("kind" in card)) return card.id;
  return card.kind === "edit" ? `edit:${card.comment.id}` : "composer";
}

/** Where a card goes among `lines`; -1 when `lines` lack its line. */
export function cardLine(card: Card, lines: readonly SideLine[]): number {
  if ("kind" in card) {
    if (card.kind === "edit") return commentLine(card.comment, lines);
    // By line, not list: revealing context cuts a new list from the same lines.
    return lines.indexOf(card.lines[card.end]);
  }
  return commentLine(card, lines);
}

export function draftTarget(file: DiffFile, draft: CommentDraft): CommentTarget | null {
  return draft.kind === "edit" ? draft.comment : commentTarget(file, draft.lines, draft.start, draft.end);
}

/** What `draft` covers, if shown in `views`: a new comment belongs to the lines it was opened on. */
export function draftScope(
  file: DiffFile,
  draft: CommentDraft | null,
  views: readonly (readonly SideLine[])[],
): CommentTarget | null {
  if (draft == null || (draft.kind === "new" && !views.some((lines) => lines.includes(draft.lines[draft.end])))) {
    return null;
  }
  return draftTarget(file, draft);
}

export function inScope(target: CommentTarget, line: Pick<SideLine, "oldNumber" | "newNumber">): boolean {
  const number = target.side === "new" ? line.newNumber : line.oldNumber;
  return number != null && number >= target.startLine && number <= target.lineNumber;
}

/** Where an item sits in the run from the first to the last item an open comment covers; null outside it. */
export type ScopeEdge = { readonly first: boolean; readonly last: boolean } | null;

export function scopeEdges<T>(items: readonly T[], covered: (item: T) => boolean): ScopeEdge[] {
  let first = -1;
  let last = -1;
  items.forEach((item, i) => {
    if (!covered(item)) return;
    if (first < 0) first = i;
    last = i;
  });
  return items.map((_, i) => (first < 0 || i < first || i > last ? null : { first: i === first, last: i === last }));
}

export function fileCards(comments: FileComments): Card[] {
  const { draft } = comments;
  const editing = draft?.kind === "edit" ? draft.comment.id : null;
  const cards: Card[] = comments.comments.filter((comment) => comment.id !== editing);
  return draft == null ? cards : [...cards, draft];
}

/** Cards whose line the view lacks: in full, unless another section shows the rest of the file. */
export function UnplacedCards({
  theme,
  block,
  cards,
  comments,
}: {
  theme: PluginTheme;
  block: FileBlock;
  cards: readonly Card[];
  comments: FileComments;
}) {
  const whole = isWholeFile(block);
  const shown = cards.filter((card) => whole || "kind" in card);
  const elsewhere = cards.length - shown.length;
  return (
    <>
      {shown.map((card) => (
        <CommentSlot key={cardKey(card)} theme={theme} file={block.file} card={card} comments={comments} />
      ))}
      {elsewhere === 0 ? null : (
        <Text style={{ fontSize: 12, lineHeight: 18, paddingHorizontal: 12, paddingVertical: 6, color: theme.colors.foregroundMuted }}>
          {elsewhere === 1
            ? "1 comment on this file is on a line another section shows."
            : `${elsewhere} comments on this file are on lines other sections show.`}
        </Text>
      )}
    </>
  );
}

export function CommentSlot({
  theme,
  file,
  card,
  comments,
}: {
  theme: PluginTheme;
  file: DiffFile;
  card: Card;
  comments: FileComments;
}) {
  if (!("kind" in card)) {
    return (
      <CommentCard
        theme={theme}
        comment={card}
        onEdit={() => comments.edit(card)}
        onDelete={() => comments.remove(card.id)}
      />
    );
  }
  const target = draftTarget(file, card);
  if (target == null) return null;
  return (
    <CommentComposer
      theme={theme}
      target={target}
      initialBody={card.kind === "edit" ? card.comment.body : ""}
      initialSuggestion={card.kind === "edit" ? card.comment.suggestion : null}
      extendable={card.kind === "new"}
      onCancel={comments.cancel}
      onSubmit={(body, suggestion) => comments.submit(target, body, suggestion)}
    />
  );
}

function CommentCard({
  theme,
  comment,
  onEdit,
  onDelete,
}: {
  theme: PluginTheme;
  comment: DraftComment;
  onEdit(): void;
  onDelete(): void;
}) {
  return (
    <View style={cardStyle(theme)}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="MessageSquare" size={12} color={theme.colors.foregroundMuted} />
        <Text style={{ flex: 1, fontSize: 12, color: theme.colors.foregroundMuted }}>
          {rangeLabel(comment)}
          {comment.side === "old" ? " of the old file" : ""} · Not sent yet
        </Text>
        <Button theme={theme} size="xs" variant="ghost" label="Edit" onPress={onEdit} />
        <Button theme={theme} size="xs" variant="ghost" label="Delete" onPress={onDelete} />
      </View>
      {comment.body === "" ? null : (
        <Text style={{ fontSize: 14, lineHeight: 20, color: theme.colors.foreground }} selectable>
          {comment.body}
        </Text>
      )}
      {comment.suggestion == null ? null : <SuggestionPreview theme={theme} suggestion={comment.suggestion} />}
    </View>
  );
}

function SuggestionPreview({ theme, suggestion }: { theme: PluginTheme; suggestion: Suggestion }) {
  const { colors } = theme;
  const rows = (text: string, sign: string, color: string) =>
    (text === "" ? [] : text.split("\n")).map((line, i) => (
      <Text key={`${sign}${i}`} style={{ ...suggestionCode, color: colors.foreground, backgroundColor: tint(color, 0.15) }}>
        {sign} {line}
      </Text>
    ));
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ fontSize: 12, color: colors.foregroundMuted }}>Suggested change, made when sent</Text>
      <View style={{ borderRadius: 6, borderWidth: 1, borderColor: colors.border, overflow: "hidden" }}>
        {rows(suggestion.original, "-", colors.statusDanger)}
        {rows(suggestion.replacement, "+", colors.statusSuccess)}
      </View>
    </View>
  );
}

function CommentComposer({
  theme,
  target,
  initialBody,
  initialSuggestion,
  extendable,
  onCancel,
  onSubmit,
}: {
  theme: PluginTheme;
  target: CommentTarget;
  initialBody: string;
  initialSuggestion: Suggestion | null;
  extendable: boolean;
  onCancel(): void;
  onSubmit(body: string, suggestion: Suggestion | null): void;
}) {
  const [body, setBody] = useState(initialBody);
  const original = suggestible(target);
  const [edit, setEdit] = useState(
    initialSuggestion == null ? null : { of: initialSuggestion.original, replacement: initialSuggestion.replacement },
  );
  // Widening the lines starts the replacement over from them, rather than replacing more with less.
  const suggestion =
    original == null || edit == null ? null : { original, replacement: edit.of === original ? edit.replacement : original };
  const setReplacement = (replacement: string | null) =>
    setEdit(replacement == null || original == null ? null : { of: original, replacement });
  const changed = body.trim() !== "" || suggestion != null;
  const card = useRef<View>(null);
  const centre = useContext(CentreAboveKeyboard);
  useEffect(
    () => (card.current == null ? undefined : centre(card.current)),
    [centre, target.side, target.lineNumber],
  );
  return (
    <View ref={card} style={cardStyle(theme)}>
      <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>
        {rangeLabel(target)}
        {target.side === "old" ? " of the old file" : ""}
        {extendable && !hasMouse() ? " · Long-press another line number to extend" : ""}
      </Text>
      <TextInput
        accessibilityLabel={`Comment on ${rangeLabel(target).toLowerCase()}`}
        autoFocus={initialSuggestion == null}
        multiline
        value={body}
        onChangeText={setBody}
        placeholder={suggestion == null ? "Leave a comment for the agent" : "Note for yourself (optional)"}
        placeholderTextColor={theme.colors.foregroundMuted}
        style={inputStyle(theme, 64)}
      />
      {suggestion == null ? null : (
        <View style={{ gap: 4 }}>
          <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>
            Replacement, made on send without the agent; empty deletes the lines
          </Text>
          <TextInput
            accessibilityLabel="Suggested replacement"
            autoFocus
            multiline
            value={suggestion.replacement}
            onChangeText={setReplacement}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={{ ...inputStyle(theme, 0), ...suggestionCode }}
          />
        </View>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {original == null ? null : suggestion == null ? (
          <Button theme={theme} size="xs" variant="ghost" icon="FilePen" label="Edit selected lines" onPress={() => setReplacement(original)} />
        ) : (
          <Button theme={theme} size="xs" variant="ghost" label="Remove suggestion" onPress={() => setReplacement(null)} />
        )}
        <View style={{ flex: 1 }} />
        <Button theme={theme} size="xs" variant="ghost" label="Cancel" onPress={onCancel} />
        <Button
          theme={theme}
          size="xs"
          variant="default"
          label={initialBody === "" && initialSuggestion == null ? "Add comment" : "Save"}
          disabled={!changed}
          onPress={() => onSubmit(body.trim(), suggestion)}
        />
      </View>
    </View>
  );
}

const suggestionCode = { fontFamily: MONOSPACE, fontSize: 12, lineHeight: 18 } as const;

function inputStyle(theme: PluginTheme, minHeight: number) {
  return {
    minHeight,
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    fontSize: 14,
    lineHeight: 20,
    textAlignVertical: "top",
  } as const;
}

function cardStyle(theme: PluginTheme) {
  return {
    gap: 8,
    marginVertical: 4,
    marginHorizontal: 8,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  } as const;
}
