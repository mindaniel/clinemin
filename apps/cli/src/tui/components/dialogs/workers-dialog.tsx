import type { TeamRosterWorker } from "@cline/shared";
import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialogKeyboard } from "@opentui-ui/dialog/react";
import { useMemo, useState } from "react";
import { palette } from "../../palette";
import {
	getSearchableListRowsWindow,
	type SearchableItem,
	useSearchableList,
} from "../searchable-list";
import {
	ACTION_DELETE,
	ACTION_MODEL,
	ACTION_PROVIDER,
	ACTION_RENAME,
	ACTION_TOOLS,
	applyModel,
	applyProvider,
	applyToolPreset,
	buildActionRows,
	buildModelRows,
	buildProviderRows,
	buildToolRows,
	buildWorker,
	buildWorkerRows,
	ROW_ADD,
	ROW_BACK,
	ROW_INHERIT,
	ROW_SAVE,
	renameWorker,
	type WorkersStep,
} from "./workers-dialog-helpers";

export {
	presetForTools,
	WORKER_TOOL_PRESETS,
	type WorkerToolPreset,
} from "./workers-dialog-helpers";

export type WorkersDialogResult = {
	workers: TeamRosterWorker[];
};

const YES = "+yes";
const NO = "+no";

/**
 * Dialog content for `/workers`: the roster, editable in place.
 *
 * Every action is a row you select with Enter, and no letter key does anything.
 * The previous version bound `n`, `d`, `t` and `s` to add/delete/tools/save
 * while the same keystrokes were also going into the name field, so typing a
 * name like `deepseek` deleted a worker and saved the file on the way past. A
 * dialog cannot have both a text field and single-letter commands; the list is
 * the command surface, and the text box only ever filters or names.
 */
export function WorkersDialogContent(
	props: ChoiceContext<WorkersDialogResult> & {
		initialWorkers: TeamRosterWorker[];
		providerIds: string[];
		modelsByProvider: Record<string, string[]>;
		rosterPath: string;
	},
) {
	const {
		resolve,
		dismiss,
		dialogId,
		initialWorkers,
		providerIds,
		modelsByProvider,
		rosterPath,
	} = props;
	const [workers, setWorkers] = useState<TeamRosterWorker[]>(initialWorkers);
	const [step, setStep] = useState<WorkersStep>({ kind: "list" });
	const [dirty, setDirty] = useState(false);
	const [nameDraft, setNameDraft] = useState("");
	const [error, setError] = useState<string | undefined>();

	const focusedWorker =
		"agentId" in step && step.agentId
			? workers.find((worker) => worker.agentId === step.agentId)
			: undefined;

	const items: SearchableItem[] = useMemo(() => {
		switch (step.kind) {
			case "list":
				return buildWorkerRows(workers, dirty);
			case "actions":
				return focusedWorker ? buildActionRows(focusedWorker) : [];
			case "provider":
				return buildProviderRows(providerIds, focusedWorker?.providerId);
			case "model":
				return buildModelRows(
					modelsByProvider[step.providerId] ?? [],
					focusedWorker?.modelId,
				);
			case "tools":
				return buildToolRows(focusedWorker?.tools);
			case "delete":
				return [
					{ key: NO, label: "No, keep it" },
					{ key: YES, label: `Yes, remove ${step.agentId}` },
				];
			case "rename":
				return [];
		}
	}, [step, workers, dirty, focusedWorker, providerIds, modelsByProvider]);

	const list = useSearchableList(items);

	const goTo = (next: WorkersStep): void => {
		setError(undefined);
		list.setSearch("");
		setStep(next);
	};

	const editWorker = (
		agentId: string,
		change: (worker: TeamRosterWorker) => TeamRosterWorker,
	): void => {
		setDirty(true);
		setWorkers((current) =>
			current.map((worker) =>
				worker.agentId === agentId ? change(worker) : worker,
			),
		);
	};

	const select = (key: string): void => {
		switch (step.kind) {
			case "list": {
				if (key === ROW_SAVE) {
					resolve({ workers });
					return;
				}
				if (key === ROW_ADD) {
					goTo({ kind: "provider", agentId: null });
					return;
				}
				goTo({ kind: "actions", agentId: key });
				return;
			}
			case "actions": {
				if (key === ROW_BACK) {
					goTo({ kind: "list" });
					return;
				}
				if (key === ACTION_PROVIDER) {
					goTo({ kind: "provider", agentId: step.agentId });
					return;
				}
				if (key === ACTION_MODEL) {
					const providerId = focusedWorker?.providerId;
					if (!providerId) {
						// Without a provider there is no model list to show, and picking a
						// model that belongs to some other provider is exactly the silent
						// mismatch this rewrite is meant to remove.
						setError("Pick a provider first — models are per provider.");
						return;
					}
					goTo({ kind: "model", agentId: step.agentId, providerId });
					return;
				}
				if (key === ACTION_TOOLS) {
					const providerId = focusedWorker?.providerId;
					goTo({
						kind: "tools",
						agentId: step.agentId,
						providerId: providerId ?? "",
						modelId: focusedWorker?.modelId,
					});
					return;
				}
				if (key === ACTION_RENAME) {
					setNameDraft(step.agentId);
					goTo({ kind: "rename", agentId: step.agentId });
					return;
				}
				if (key === ACTION_DELETE) {
					goTo({ kind: "delete", agentId: step.agentId });
				}
				return;
			}
			case "provider": {
				if (step.agentId === null) {
					goTo({ kind: "model", agentId: null, providerId: key });
					return;
				}
				const target = workers.find(
					(worker) => worker.agentId === step.agentId,
				);
				if (!target) {
					goTo({ kind: "list" });
					return;
				}
				const updated = applyProvider(
					target,
					key,
					workers.map((worker) => worker.agentId),
				);
				editWorker(step.agentId, () => updated);
				goTo({ kind: "actions", agentId: updated.agentId });
				return;
			}
			case "model": {
				const modelId = key === ROW_INHERIT ? undefined : key;
				if (step.agentId === null) {
					goTo({
						kind: "tools",
						agentId: null,
						providerId: step.providerId,
						modelId,
					});
					return;
				}
				editWorker(step.agentId, (worker) => applyModel(worker, modelId));
				goTo({ kind: "actions", agentId: step.agentId });
				return;
			}
			case "tools": {
				if (step.agentId === null) {
					const created = buildWorker({
						providerId: step.providerId,
						modelId: step.modelId,
						presetId: key,
						taken: workers.map((worker) => worker.agentId),
					});
					setDirty(true);
					setWorkers((current) => [...current, created]);
					goTo({ kind: "actions", agentId: created.agentId });
					return;
				}
				editWorker(step.agentId, (worker) => applyToolPreset(worker, key));
				goTo({ kind: "actions", agentId: step.agentId });
				return;
			}
			case "delete": {
				if (key === YES) {
					setDirty(true);
					setWorkers((current) =>
						current.filter((worker) => worker.agentId !== step.agentId),
					);
					goTo({ kind: "list" });
					return;
				}
				goTo({ kind: "actions", agentId: step.agentId });
				return;
			}
			case "rename":
				return;
		}
	};

	useDialogKeyboard(async (key) => {
		if (key.name === "escape") {
			// Escape walks back up the wizard so a mis-step costs one keypress, and
			// only leaves the dialog from the top. Unsaved edits die with it, which
			// is why the list step says so.
			if (step.kind === "list") {
				dismiss();
				return;
			}
			goTo(
				"agentId" in step && step.agentId
					? { kind: "actions", agentId: step.agentId }
					: { kind: "list" },
			);
			return;
		}

		if (key.name === "return" || key.name === "enter") {
			if (step.kind === "rename") {
				const result = renameWorker(workers, step.agentId, nameDraft);
				if (!result.ok) {
					setError(result.error);
					return;
				}
				setDirty(true);
				setWorkers(result.workers);
				goTo({ kind: "actions", agentId: nameDraft.trim() });
				return;
			}
			const selected = list.selectedItem?.key;
			if (selected) {
				select(selected);
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

	const heading = (() => {
		switch (step.kind) {
			case "list":
				return `Workers (${workers.length})${dirty ? " — unsaved" : ""}`;
			case "actions":
				return `${step.agentId}`;
			case "provider":
				return step.agentId === null
					? "New worker — pick a provider"
					: `${step.agentId} — pick a provider`;
			case "model":
				return `${step.agentId ?? "New worker"} — pick a model on ${step.providerId}`;
			case "tools":
				return `${step.agentId ?? "New worker"} — what may it do?`;
			case "rename":
				return `Rename ${step.agentId}`;
			case "delete":
				return `Remove ${step.agentId}?`;
		}
	})();

	const footer = (() => {
		switch (step.kind) {
			case "list":
				return "Enter opens · Esc discards unsaved changes";
			case "rename":
				return "Enter renames · Esc goes back";
			default:
				return "Enter selects · Esc goes back";
		}
	})();

	return (
		<box flexDirection="column" gap={1}>
			<text>{heading}</text>
			{step.kind === "list" ? <text fg="gray">{rosterPath}</text> : null}
			{error ? <text fg="red">{error}</text> : null}

			<box border borderStyle="rounded" borderColor="gray" paddingX={1}>
				<input
					// Remounting per step clears the box, so a filter typed on one screen
					// does not silently hide rows on the next one.
					key={`${step.kind}-${"agentId" in step ? step.agentId : ""}`}
					onInput={step.kind === "rename" ? setNameDraft : list.setSearch}
					placeholder={step.kind === "rename" ? "New name..." : "Filter..."}
					flexGrow={1}
					focused
				/>
			</box>

			{step.kind === "rename" ? (
				<text fg="gray">
					Letters, digits, dot, underscore and hyphen. The manager addresses
					this worker by this name.
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
					{list.filtered.length === 0 && step.kind === "model" ? (
						<text fg="gray">
							No models listed for this provider — it decides the model itself.
						</text>
					) : null}
				</box>
			)}

			<text fg="gray">{footer}</text>
		</box>
	);
}
