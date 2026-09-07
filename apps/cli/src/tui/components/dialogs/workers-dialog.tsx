import { shortProviderName, type TeamRosterWorker } from "@cline/shared";
import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialogKeyboard } from "@opentui-ui/dialog/react";
import { useState } from "react";
import { palette } from "../../palette";
import {
	getSearchableListRowsWindow,
	type SearchableItem,
	useSearchableList,
} from "../searchable-list";

/**
 * What a worker is allowed to do, as a few named settings.
 *
 * The roster stores a list of tool names, but picking tools one at a time in a
 * dialog is fiddly and gets it wrong in the dangerous direction — the whole
 * point of scoping is that a worker asked to survey a repo cannot decide to
 * delete half of it. Three presets cover what the roles actually are, and
 * `team.json` is still there for anything finer.
 */
export const WORKER_TOOL_PRESETS = [
	{
		id: "read",
		label: "read-only",
		tools: ["read_files", "search_codebase"],
		rolePrompt:
			"Reads files and reports exactly what is in them. Quote the line and give file:line for every claim. You cannot edit anything.",
	},
	{
		id: "edit",
		label: "read + edit",
		tools: ["read_files", "search_codebase", "editor"],
		rolePrompt:
			"Follows the manager's instructions and edits code. Read a file before changing it, and report what you changed with file:line.",
	},
	{
		id: "full",
		label: "read + edit + shell",
		tools: ["read_files", "search_codebase", "editor", "run_commands"],
		rolePrompt:
			"Carries out the manager's instructions, including running commands. Report what you ran and what it produced.",
	},
	{
		id: "web",
		label: "web lookup",
		tools: ["fetch_web_content", "search_codebase"],
		rolePrompt:
			"Looks things up on the web and reports what the source says, with the URL for every claim.",
	},
] as const;

export type WorkerToolPreset = (typeof WORKER_TOOL_PRESETS)[number];

/** Which preset a worker's tool list corresponds to, if any. */
export function presetForTools(
	tools: string[] | undefined,
): WorkerToolPreset | undefined {
	if (!tools) {
		return undefined;
	}
	const key = [...tools].sort().join(",");
	return WORKER_TOOL_PRESETS.find(
		(preset) => [...preset.tools].sort().join(",") === key,
	);
}

function describeTools(tools: string[] | undefined): string {
	if (!tools) {
		return "every tool (unscoped)";
	}
	if (tools.length === 0) {
		return "nothing but reporting back";
	}
	return presetForTools(tools)?.label ?? tools.join(", ");
}

export type WorkersDialogResult = {
	workers: TeamRosterWorker[];
};

/**
 * Dialog content for `/workers`: the roster, editable in place.
 *
 * Enter cycles a worker's provider, `t` cycles what it may do, `d` deletes it,
 * and typing a name then pressing `n` adds one. `s` saves; Escape leaves the
 * file alone.
 */
export function WorkersDialogContent(
	props: ChoiceContext<WorkersDialogResult> & {
		initialWorkers: TeamRosterWorker[];
		providerIds: string[];
		rosterPath: string;
	},
) {
	const {
		resolve,
		dismiss,
		dialogId,
		initialWorkers,
		providerIds,
		rosterPath,
	} = props;
	const [workers, setWorkers] = useState<TeamRosterWorker[]>(initialWorkers);
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);

	const items: SearchableItem[] = workers.map((worker) => ({
		key: worker.agentId,
		label: `${worker.agentId} — ${worker.providerId ?? "lead's provider"} — ${describeTools(worker.tools)}`,
		section: "Workers",
		searchText: `${worker.agentId} ${worker.providerId ?? ""}`,
	}));
	const list = useSearchableList(items);

	const updateSelected = (
		change: (worker: TeamRosterWorker) => TeamRosterWorker,
	): void => {
		const selected = list.selectedItem?.key;
		if (!selected) {
			return;
		}
		setDirty(true);
		setWorkers((current) =>
			current.map((worker) =>
				worker.agentId === selected ? change(worker) : worker,
			),
		);
	};

	useDialogKeyboard(async (key) => {
		if (confirmDelete) {
			if (key.name === "y") {
				setDirty(true);
				setWorkers((current) =>
					current.filter((worker) => worker.agentId !== confirmDelete),
				);
			}
			setConfirmDelete(null);
			return;
		}

		if (key.name === "escape") {
			dismiss();
			return;
		}
		if (key.name === "s") {
			resolve({ workers });
			return;
		}
		if (key.name === "n") {
			// The search box doubles as the name field, the same trick `/findchat`
			// uses to import a chat id: one input, no separate form.
			const agentId = list.search.trim();
			if (!agentId || !/^[a-zA-Z0-9._-]+$/.test(agentId)) {
				return;
			}
			if (workers.some((worker) => worker.agentId === agentId)) {
				return;
			}
			const preset = WORKER_TOOL_PRESETS[0];
			setDirty(true);
			setWorkers((current) => [
				...current,
				{
					agentId,
					rolePrompt: preset.rolePrompt,
					// Typing a model name is the normal way to add a worker, so honour
					// it — by its short name or its full provider id — instead of
					// dropping the user on whatever sorts first.
					providerId:
						providerIds.find(
							(id) => id === agentId || shortProviderName(id) === agentId,
						) ?? providerIds[0],
					tools: [...preset.tools],
				},
			]);
			list.setSearch("");
			return;
		}
		if (key.name === "d") {
			const selected = list.selectedItem?.key;
			if (selected) {
				setConfirmDelete(selected);
				list.setSearch("");
			}
			return;
		}
		if (key.name === "t") {
			updateSelected((worker) => {
				const currentIndex = WORKER_TOOL_PRESETS.findIndex(
					(preset) => preset.id === presetForTools(worker.tools)?.id,
				);
				const next =
					WORKER_TOOL_PRESETS[
						(currentIndex + 1) % WORKER_TOOL_PRESETS.length
					] ?? WORKER_TOOL_PRESETS[0];
				return {
					...worker,
					tools: [...next.tools],
					// The role prompt follows the preset unless it has been customised
					// in team.json — replacing a hand-written one here would silently
					// throw away the thing the user cared most about.
					rolePrompt: WORKER_TOOL_PRESETS.some(
						(preset) => preset.rolePrompt === worker.rolePrompt,
					)
						? next.rolePrompt
						: worker.rolePrompt,
				};
			});
			return;
		}
		if (key.name === "return") {
			updateSelected((worker) => {
				if (providerIds.length === 0) {
					return worker;
				}
				const currentIndex = providerIds.indexOf(worker.providerId ?? "");
				const nextProviderId =
					providerIds[(currentIndex + 1) % providerIds.length];
				return {
					...worker,
					providerId: nextProviderId,
					// A manager addresses a worker by the short model name (`TO: qwen`),
					// so a worker named after its provider has to keep that name when
					// the provider changes — otherwise the roster still says "qwen" and
					// the messages go to a Gemini chat. A hand-picked name is left
					// alone, the same way a hand-written role prompt is below.
					agentId:
						worker.providerId &&
						worker.agentId === shortProviderName(worker.providerId) &&
						nextProviderId
							? shortProviderName(nextProviderId)
							: worker.agentId,
				};
			});
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
			<text>
				Workers ({workers.length}){dirty ? " — unsaved" : ""}
			</text>
			<text fg="gray">{rosterPath}</text>

			{confirmDelete ? (
				<box border borderStyle="rounded" borderColor="red" paddingX={1}>
					<text fg="red">Remove worker {confirmDelete}? (y/n)</text>
				</box>
			) : (
				<box border borderStyle="rounded" borderColor="gray" paddingX={1}>
					<input
						onInput={list.setSearch}
						placeholder="Filter, or type a new worker name and press n..."
						flexGrow={1}
						focused
					/>
				</box>
			)}

			{workers.length === 0 ? (
				<text fg="gray">
					No workers yet. Type a name and press n to add one.
				</text>
			) : (
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
			)}

			<text fg="gray">
				Enter cycles provider · t cycles tools · d removes · n adds · s saves ·
				Esc cancels
			</text>
		</box>
	);
}
