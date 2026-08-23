import type { DeepSeekWebV2ChatEntry } from "@cline/llms";
import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialogKeyboard } from "@opentui-ui/dialog/react";
import { palette } from "../../palette";
import {
	getSearchableListRowsWindow,
	type SearchableItem,
	useSearchableList,
} from "../searchable-list";

/**
 * Dialog content for `/findchat`: a searchable list of the persisted
 * DeepSeek Web v2 chats. Press Enter (or click) to pick one → resolves with its
 * `sessionId`; Escape dismisses.
 */
export function FindChatDialogContent(
	props: ChoiceContext<string> & { chats: DeepSeekWebV2ChatEntry[] },
) {
	const { resolve, dismiss, dialogId, chats } = props;

	const items: SearchableItem[] = chats.map((chat) => ({
		key: chat.sessionId,
		label: `${new Date(chat.lastActive).toLocaleString()} — ${chat.sessionId}`,
		section: "DeepSeek Web v2 chats",
		searchText: `${chat.sessionId} ${chat.chatKey} ${chat.lastActive}`,
	}));

	const list = useSearchableList(items);

	useDialogKeyboard((key) => {
		if (key.name === "escape") {
			dismiss();
			return;
		}
		if (key.name === "return") {
			if (list.selectedItem) resolve(list.selectedItem.key);
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

	return (
		<box flexDirection="column" gap={1}>
			<text>Find a DeepSeek Web v2 chat ({chats.length} found)</text>

			<box border borderStyle="rounded" borderColor="gray" paddingX={1}>
				<input
					onInput={list.setSearch}
					placeholder="Search chats... (Enter to open, Esc to cancel)"
					flexGrow={1}
					focused
				/>
			</box>

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
		</box>
	);
}
