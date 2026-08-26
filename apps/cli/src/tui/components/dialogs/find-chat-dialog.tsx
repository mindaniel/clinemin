import type { DeepSeekWebV2ChatEntry, QwenWebChatEntry } from "@cline/llms";
import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialogKeyboard } from "@opentui-ui/dialog/react";
import { useState } from "react";
import { palette } from "../../palette";
import {
	getSearchableListRowsWindow,
	type SearchableItem,
	useSearchableList,
} from "../searchable-list";

export type WebChatEntry = DeepSeekWebV2ChatEntry | QwenWebChatEntry;

/**
 * Dialog content for `/findchat`: a searchable list of the persisted
 * Web chats. Press Enter (or click) to pick one -> resolves with its
 * `sessionId`; Escape dismisses.
 *
 * Delete: press 'd' to mark a chat for deletion, then 'y' to confirm or 'n' to cancel.
 */
export function FindChatDialogContent(
	props: ChoiceContext<string> & {
		chats: WebChatEntry[];
		onDelete: (chatKey: string) => Promise<void> | void;
		providerName: string;
	},
) {
	const {
		resolve,
		dismiss,
		dialogId,
		chats: initialChats,
		onDelete,
		providerName,
	} = props;
	const [chats, setChats] = useState(initialChats);
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

	const items: SearchableItem[] = chats.map((chat) => ({
		key: chat.sessionId,
		label: `${new Date(chat.lastActive).toLocaleString()} � ${chat.sessionId}`,
		section: providerName,
		searchText: `${chat.sessionId} ${chat.chatKey} ${chat.lastActive}`,
	}));

	const list = useSearchableList(items);

	useDialogKeyboard(async (key) => {
		if (key.name === "escape") {
			dismiss();
			return;
		}
		if (key.name === "return") {
			if (list.selectedItem) resolve(list.selectedItem.key);
			return;
		}
		// Delete flow
		if (confirmDelete) {
			if (key.name === "y") {
				// Actually delete
				try {
					await onDelete(confirmDelete);
					// Remove from local state
					setChats((prev) => prev.filter((c) => c.chatKey !== confirmDelete));
				} catch (_) {
					// Error handled by parent
				}
				setConfirmDelete(null);
				return;
			}
			if (key.name === "n") {
				setConfirmDelete(null);
				return;
			}
			// Any other key cancels confirmation
			setConfirmDelete(null);
			return;
		}

		if (key.name === "d" || (key.ctrl && key.name === "d")) {
			const selected = list.selectedItem;
			if (selected) {
				const chatEntry = chats.find((c) => c.sessionId === selected.key);
				if (chatEntry) {
					setConfirmDelete(chatEntry.chatKey);
					// The same keypress that arms delete would otherwise also land in
					// the (about to be hidden) search input, leaving a stray character
					// that re-filters the list once the confirm prompt closes.
					list.setSearch("");
				}
			}
			return;
		}
		if (key.name === "up" || (key.ctrl && key.name === "p")) {
			list.moveUp();
			return;
		}
		if (key.name === "down" || (key.ctrl && key.name === "n")) {
			list.moveDown();
		}
	}, dialogId);

	const { visibleRows, aboveCount, belowCount, showAbove, showBelow } =
		getSearchableListRowsWindow(list.filtered, list.safeSelected, 10);

	const footerText = confirmDelete
		? `Delete chat ${confirmDelete}? (y/n)`
		: `d to delete, Enter to open, Esc to cancel`;

	return (
		<box flexDirection="column" gap={1}>
			<text>
				Find a {providerName} chat ({chats.length} found)
			</text>

			{confirmDelete ? (
				<box border borderStyle="rounded" borderColor="red" paddingX={1}>
					<text fg="red">Delete chat {confirmDelete}? (y/n)</text>
				</box>
			) : (
				<box border borderStyle="rounded" borderColor="gray" paddingX={1}>
					<input
						onInput={list.setSearch}
						placeholder="Search chats... (Enter to open, Esc to cancel)"
						flexGrow={1}
						focused
					/>
				</box>
			)}

			{list.filtered.length === 0 ? (
				<text fg="gray">No chats match</text>
			) : (
				<box flexDirection="column">
					{showAbove && (
						<box paddingX={1} justifyContent="center">
							<text fg="gray">
								{"\u25b2"} {aboveCount} more
							</text>
						</box>
					)}
					{visibleRows.map((row) => {
						if (row.kind === "header") {
							return (
								<box key={row.key} paddingX={1} height={1}>
									<text fg="gray">{row.label}</text>
								</box>
							);
						}
						const isSel = row.itemIndex === list.safeSelected;
						const isConfirm = confirmDelete === row.item.key;
						return (
							<box
								key={row.item.key}
								paddingX={1}
								flexDirection="row"
								gap={1}
								backgroundColor={isSel ? palette.selection : undefined}
								onMouseDown={() => resolve(row.item.key)}
								overflow="hidden"
								height={1}
							>
								<text
									fg={isSel ? palette.textOnSelection : "gray"}
									flexShrink={0}
								>
									{isSel ? "\u276f" : " "}
								</text>
								<text fg={isSel ? palette.textOnSelection : undefined}>
									{row.item.label}
								</text>
								{isConfirm && (
									<text fg="red" flexShrink={0}>
										{"  [delete? y/n]"}
									</text>
								)}
							</box>
						);
					})}
					{showBelow && (
						<box paddingX={1} justifyContent="center">
							<text fg="gray">
								{"\u25bc"} {belowCount} more
							</text>
						</box>
					)}
				</box>
			)}
			<text fg="gray" marginTop={1}>
				<em>{footerText}</em>
			</text>
		</box>
	);
}
