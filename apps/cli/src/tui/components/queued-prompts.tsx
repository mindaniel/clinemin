import "opentui-spinner/react";
import { useEffect, useState } from "react";
import { useSession } from "../contexts/session-context";
import { palette } from "../palette";
import type { QueuedPromptItem } from "../types";

function truncatePrompt(prompt: string): string {
	return prompt.length > 64 ? `${prompt.slice(0, 64)}...` : prompt;
}

function attachmentLabel(count: number): string {
	if (count <= 0) return "";
	return count === 1 ? " 1 attachment" : ` ${count} attachments`;
}

export function QueuedPrompts(props: {
	items: QueuedPromptItem[];
	selectedId: string | null;
	editingId: string | null;
	onEditConfirm: (id: string, prompt: string) => void;
}) {
	const session = useSession();
	if (props.items.length === 0) return null;

	const selected = props.selectedId
		? props.items.find((item) => item.id === props.selectedId)
		: undefined;
	const selectedIsEditing = selected?.id === props.editingId;
	// With a message selected, Ctrl+X removes that message only; halting the
	// run needs nothing selected (Esc clears the selection first).
	const removeHint = "Ctrl+X/Del removes it, Esc back";
	const hint = selected
		? selectedIsEditing
			? "Enter confirm, Esc discards this edit, Ctrl+X removes the message (run keeps going)"
			: selected.steer
				? session.isRunning
					? `Waiting. Up/Down navigate, Tab edit, ${removeHint}`
					: `Steered next. Up/Down navigate, Tab edit, ${removeHint}`
				: `Up/Down navigate, Enter steer, Tab edit, ${removeHint}`
		: session.isRunning
			? "Select a message to steer or edit, Ctrl+X halts run"
			: "Select a message to steer or edit";

	return (
		<box
			flexDirection="column"
			border
			borderStyle="rounded"
			borderColor={selected ? palette.selection : "gray"}
			paddingX={1}
		>
			<text fg="gray">
				<em>Queued messages:</em>
			</text>
			{props.items.map((item) => {
				const isSelected = item.id === props.selectedId;
				const isEditing = item.id === props.editingId;
				return (
					<QueuedPromptRow
						key={item.id}
						item={item}
						selected={isSelected}
						editing={isEditing}
						onEditConfirm={(prompt) => props.onEditConfirm(item.id, prompt)}
					/>
				);
			})}
			<text fg="gray">
				<em>{hint}</em>
			</text>
		</box>
	);
}

function QueuedPromptRow(props: {
	item: QueuedPromptItem;
	selected: boolean;
	editing: boolean;
	onEditConfirm: (prompt: string) => void;
}) {
	const { item, selected, editing } = props;
	const [editValue, setEditValue] = useState(item.prompt);

	useEffect(() => {
		if (editing) {
			setEditValue(item.prompt);
		}
	}, [editing, item.prompt]);

	return (
		<box
			paddingX={1}
			flexDirection="row"
			gap={1}
			backgroundColor={selected ? palette.selection : undefined}
		>
			{item.steer && !editing ? (
				<spinner
					name="dots"
					color={selected ? palette.textOnSelection : "gray"}
				/>
			) : (
				<text fg={selected ? palette.textOnSelection : "gray"} flexShrink={0}>
					{selected ? ">" : " "}
				</text>
			)}
			{editing ? (
				<input
					value={editValue}
					onInput={setEditValue}
					onSubmit={() => props.onEditConfirm(editValue)}
					placeholder="Edit message..."
					backgroundColor={palette.selection}
					focusedBackgroundColor={palette.selection}
					textColor={palette.textOnSelection}
					cursorColor={palette.textOnSelection}
					placeholderColor={palette.textOnSelection}
					focused
					flexGrow={1}
				/>
			) : (
				<text fg={selected ? palette.textOnSelection : undefined} flexGrow={1}>
					{truncatePrompt(item.prompt)}
				</text>
			)}
			{!editing && item.attachmentCount > 0 && (
				<text fg={selected ? palette.textOnSelection : "gray"} flexShrink={0}>
					{attachmentLabel(item.attachmentCount)}
				</text>
			)}
		</box>
	);
}
