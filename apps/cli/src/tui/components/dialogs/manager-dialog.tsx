import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialogKeyboard } from "@opentui-ui/dialog/react";
import { palette } from "../../palette";
import {
	getSearchableListRowsWindow,
	type SearchableItem,
	useSearchableList,
} from "../searchable-list";

export type ManagerDialogResult = {
	providerId: string;
};

/**
 * Dialog content for a bare `/manager`: pick which model manages, then start.
 *
 * The manager is the one session in a team whose model choice actually matters
 * — it is doing all the reasoning and none of the work — and it is usually not
 * the provider the session was launched with. Asking for it here means the
 * choice happens once, before the prompt is built, rather than through a
 * `/model` switch that the user has to remember to do first.
 *
 * The roster is shown but not editable: `/workers` owns that, and folding two
 * editors into one dialog is how a "start the manager" keypress ends up
 * rewriting `team.json`.
 */
export function ManagerDialogContent(
	props: ChoiceContext<ManagerDialogResult> & {
		providerIds: string[];
		currentProviderId: string;
		workerNames: string[];
	},
) {
	const {
		resolve,
		dismiss,
		dialogId,
		providerIds,
		currentProviderId,
		workerNames,
	} = props;

	const items: SearchableItem[] = providerIds.map((providerId) => ({
		key: providerId,
		label:
			providerId === currentProviderId
				? `${providerId} (this session)`
				: providerId,
		section: "Manager model",
		searchText: providerId,
	}));
	const list = useSearchableList(items);

	useDialogKeyboard(async (key) => {
		if (key.name === "escape") {
			dismiss();
			return;
		}
		if (key.name === "return") {
			const selected = list.selectedItem?.key;
			if (selected) {
				resolve({ providerId: selected });
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

	const { visibleRows, aboveCount, showAbove } = getSearchableListRowsWindow(
		list.filtered,
		list.safeSelected,
		10,
	);

	return (
		<box flexDirection="column" gap={1}>
			<text>Start manager mode</text>
			{workerNames.length === 0 ? (
				<text fg="red">
					No workers in the roster — a manager would have nobody to delegate to.
					Add some with /workers first.
				</text>
			) : (
				<text fg="gray">Delegates to: {workerNames.join(", ")}</text>
			)}

			<box border borderStyle="rounded" borderColor="gray" paddingX={1}>
				<input
					onInput={list.setSearch}
					placeholder="Filter models..."
					flexGrow={1}
					focused
				/>
			</box>

			<box flexDirection="column">
				{showAbove && (
					<box paddingX={1} justifyContent="center">
						<text fg="gray">
							{"▲"} {aboveCount} more
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
							backgroundColor={isSel ? palette.selection : undefined}
							overflow="hidden"
						>
							<text>{row.item.label}</text>
						</box>
					);
				})}
			</box>

			<text fg="gray">
				Enter starts the manager on the selected model · Esc cancels
			</text>
		</box>
	);
}
