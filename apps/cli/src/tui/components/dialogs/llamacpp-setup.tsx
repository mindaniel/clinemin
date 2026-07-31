import { Llms } from "@cline/core";
import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialogKeyboard } from "@opentui-ui/dialog/react";
import * as fs from "node:fs";
import * as path from "node:path";
import { useState } from "react";
import { palette } from "../../palette";
import {
	getSearchableListRowsWindow,
	type SearchableItem,
	useSearchableList,
} from "../searchable-list";

/**
 * Step 1 of the llama.cpp setup wizard: point at a folder, resolve to every
 * .gguf file found (one level of subfolders deep, matching LM Studio's
 * "publisher/ModelName/*.gguf" layout). Only resolves once at least one
 * model is found — a bad path just shows an inline error and keeps the
 * dialog open, rather than dead-ending the wizard.
 */
export function LlamaCppFolderInputContent(
	props: ChoiceContext<string[]> & { initialFolder: string },
) {
	const { resolve, dismiss, dialogId, initialFolder } = props;
	const [value, setValue] = useState(initialFolder);
	const [error, setError] = useState<string | undefined>(undefined);

	const submit = () => {
		const folder = value.trim().replace(/^["']|["']$/g, "");
		if (!folder) {
			setError("Enter a folder path.");
			return;
		}
		if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
			setError(`Folder not found: ${folder}`);
			return;
		}
		const models = Llms.scanLlamaCppModels(folder);
		if (models.length === 0) {
			setError("No .gguf files found in that folder (checked one level of subfolders too).");
			return;
		}
		resolve(models);
	};

	useDialogKeyboard((key) => {
		if (key.name === "escape") {
			dismiss();
			return;
		}
		if (key.name === "return") {
			submit();
		}
	}, dialogId);

	return (
		<box flexDirection="column" paddingX={1} gap={1}>
			<text fg={palette.act}>
				<strong>llama.cpp — models folder</strong>
			</text>

			<text fg="gray">
				Folder containing your .gguf files (or a folder of subfolders, like LM
				Studio's layout).
			</text>

			<box border borderStyle="rounded" borderColor={palette.act} paddingX={1}>
				<input
					value={value}
					onInput={(v: string) => {
						setValue(v);
						setError(undefined);
					}}
					placeholder="D:\models"
					flexGrow={1}
					focused
				/>
			</box>

			{error && <text fg="red">{error}</text>}

			<text fg="gray">
				<em>Enter to scan, Esc to go back</em>
			</text>
		</box>
	);
}

/**
 * Step 2: pick one of the .gguf files found in step 1.
 */
export function LlamaCppModelPickerContent(
	props: ChoiceContext<string> & { models: string[] },
) {
	const { resolve, dismiss, dialogId, models } = props;

	const items: SearchableItem[] = models.map((modelPath) => ({
		key: modelPath,
		label: path.basename(modelPath),
		section: path.basename(path.dirname(modelPath)),
		searchText: modelPath,
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
			<text>
				Select Model ({models.length} found)
			</text>

			<box border borderStyle="rounded" borderColor="gray" paddingX={1}>
				<input
					onInput={list.setSearch}
					placeholder="Search models..."
					flexGrow={1}
					focused
				/>
			</box>

			{list.filtered.length === 0 ? (
				<text fg="gray">No models match</text>
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
								<text fg={isSel ? palette.textOnSelection : "gray"} flexShrink={0}>
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

			<text fg="gray">
				Type to search, ↑/↓ navigate, Enter to select, Esc to go back
			</text>
		</box>
	);
}

/**
 * Step 3: pick a context-size preset — fixed choices, no free-typed number.
 * This value both becomes llama-server's `-c` flag AND Cline's own
 * contextWindow budget for compaction, since it's saved as the provider's
 * regular `contextWindow` setting (see ensureLlamaCppRunning's overrides).
 */
const CONTEXT_SIZE_PRESETS: { value: number; label: string; desc: string }[] = [
	{ value: 4096, label: "4,096", desc: "Small — fastest, least RAM" },
	{ value: 8192, label: "8,192", desc: "Default — good balance" },
	{ value: 16384, label: "16,384", desc: "Medium — longer conversations" },
	{ value: 32768, label: "32,768", desc: "Large — big files/contexts" },
	{ value: 65536, label: "65,536", desc: "Extra large — needs more RAM" },
	{ value: 131072, label: "131,072", desc: "Max — only if the model supports it" },
];

export function LlamaCppContextSizeContent(
	props: ChoiceContext<number> & { modelName: string },
) {
	const { resolve, dismiss, dialogId, modelName } = props;
	const [selected, setSelected] = useState(1); // default to the 8192 preset

	useDialogKeyboard((key) => {
		if (key.name === "escape") {
			dismiss();
			return;
		}
		if (key.name === "return" || key.name === "enter") {
			const preset = CONTEXT_SIZE_PRESETS[selected];
			if (preset) resolve(preset.value);
			return;
		}
		if (key.name === "up" || (key.ctrl && key.name === "p")) {
			setSelected((s) => (s <= 0 ? CONTEXT_SIZE_PRESETS.length - 1 : s - 1));
			return;
		}
		if (key.name === "down" || (key.ctrl && key.name === "n")) {
			setSelected((s) => (s >= CONTEXT_SIZE_PRESETS.length - 1 ? 0 : s + 1));
		}
	}, dialogId);

	return (
		<box flexDirection="column" gap={1}>
			<text>Context size for {modelName}</text>
			<text fg="gray">
				Bigger = more memory of the conversation, but slower and more RAM.
			</text>

			<box flexDirection="column">
				{CONTEXT_SIZE_PRESETS.map((preset, i) => (
					<box
						key={preset.value}
						paddingX={1}
						flexDirection="row"
						gap={1}
						justifyContent="space-between"
						backgroundColor={i === selected ? palette.selection : undefined}
						onMouseDown={() => resolve(preset.value)}
					>
						<box flexDirection="row" gap={1} flexShrink={0}>
							<text fg={i === selected ? palette.textOnSelection : "gray"} flexShrink={0}>
								{i === selected ? "\u276f" : " "}
							</text>
							<text fg={i === selected ? palette.textOnSelection : undefined}>
								{preset.label}
							</text>
						</box>
						<text fg={i === selected ? palette.textOnSelection : "gray"}>
							{preset.desc}
						</text>
					</box>
				))}
			</box>

			<text fg="gray">↑/↓ navigate, Enter to select, Esc to go back</text>
		</box>
	);
}
