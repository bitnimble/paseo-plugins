import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import { type CommentTarget, commentLine, commentTarget, rangeLabel } from "../shared/comments";
import type { DiffFile } from "../shared/diff";
import { type FileBlock, isWholeFile } from "../shared/guide";
import type { DraftComment } from "../shared/protocol";
import type { SideLine } from "../shared/sides";
import { Button } from "./controls";

export type CommentDraft =
  | {
      readonly kind: "new";
      readonly filePath: string;
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
  submit(target: CommentTarget, body: string): void;
  remove(id: string): void;
}

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
    return card.lines === lines ? card.end : -1;
  }
  return commentLine(card, lines);
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
  const target = card.kind === "edit" ? card.comment : commentTarget(file, card.lines, card.start, card.end);
  if (target == null) return null;
  return (
    <CommentComposer
      theme={theme}
      target={target}
      initialBody={card.kind === "edit" ? card.comment.body : ""}
      onCancel={comments.cancel}
      onSubmit={(body) => comments.submit(target, body)}
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
      <Text style={{ fontSize: 14, lineHeight: 20, color: theme.colors.foreground }} selectable>
        {comment.body}
      </Text>
    </View>
  );
}

function CommentComposer({
  theme,
  target,
  initialBody,
  onCancel,
  onSubmit,
}: {
  theme: PluginTheme;
  target: CommentTarget;
  initialBody: string;
  onCancel(): void;
  onSubmit(body: string): void;
}) {
  const [body, setBody] = useState(initialBody);
  return (
    <View style={cardStyle(theme)}>
      <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>
        {rangeLabel(target)}
        {target.side === "old" ? " of the old file" : ""}
      </Text>
      <TextInput
        accessibilityLabel={`Comment on ${rangeLabel(target).toLowerCase()}`}
        autoFocus
        multiline
        value={body}
        onChangeText={setBody}
        placeholder="Leave a comment for the agent"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={{
          minHeight: 64,
          padding: 8,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface0,
          color: theme.colors.foreground,
          fontSize: 14,
          lineHeight: 20,
          textAlignVertical: "top",
        }}
      />
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
        <Button theme={theme} size="xs" variant="ghost" label="Cancel" onPress={onCancel} />
        <Button
          theme={theme}
          size="xs"
          variant="default"
          label={initialBody === "" ? "Add comment" : "Save"}
          disabled={body.trim() === ""}
          onPress={() => onSubmit(body.trim())}
        />
      </View>
    </View>
  );
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
