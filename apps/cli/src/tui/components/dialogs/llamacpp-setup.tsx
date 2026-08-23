import * as fs from "node:fs";
import * as path from "node:path";
import { Llms } from "@cline/core";
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
			setError(
				"No .gguf files found in that folder (checked one level of subfolders too).",
			);
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
			<text>Select Model ({models.length} found)</text>

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

			<text fg="gray">
				Type to search, ↑/↓ navigate, Enter to select, Esc to go back
			</text>
		</box>
	);
}

function slugifyLlamaCppName(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "server";
}

export interface LlamaCppProfileInput {
	id: string;
	name: string;
	baseUrl: string;
}

/**
 * Names a new llama.cpp server profile and picks a free port for it, so
 * multiple llama-server processes can run concurrently (one per profile)
 * instead of each new model selection ejecting the previous one.
 */
export function LlamaCppNewProfileContent(
	props: ChoiceContext<LlamaCppProfileInput> & {
		existingPorts: string[];
		existingIds: string[];
	},
) {
	const { resolve, dismiss, dialogId, existingPorts, existingIds } = props;
	const suggestedPort = String(
		existingPorts.length > 0
			? Math.max(...existingPorts.map(Number)) + 1
			: 8080,
	);
	const [phase, setPhase] = useState<"name" | "port">("name");
	const [name, setName] = useState("");
	const [port, setPort] = useState(suggestedPort);
	const [error, setError] = useState<string | undefined>(undefined);

	const submitName = () => {
		if (!name.trim()) {
			setError("Enter a name for this server.");
			return;
		}
		setError(undefined);
		setPhase("port");
	};

	const submitPort = () => {
		const trimmed = port.trim();
		const n = Number(trimmed);
		if (!trimmed || !Number.isInteger(n) || n < 1 || n > 65535) {
			setError("Enter a valid port (1-65535).");
			return;
		}
		if (existingPorts.includes(trimmed)) {
			setError(`Port ${trimmed} is already used by another llama.cpp server.`);
			return;
		}
		const finalName = name.trim();
		let id = `llamacpp-${slugifyLlamaCppName(finalName)}`;
		if (existingIds.includes(id)) {
			let suffix = 2;
			while (existingIds.includes(`${id}-${suffix}`)) suffix++;
			id = `${id}-${suffix}`;
		}
		resolve({ id, name: finalName, baseUrl: `http://localhost:${trimmed}/v1` });
	};

	useDialogKeyboard((key) => {
		if (key.name === "escape") {
			if (phase === "port") {
				setPhase("name");
				setError(undefined);
				return;
			}
			dismiss();
			return;
		}
		if (key.name === "return") {
			if (phase === "name") submitName();
			else submitPort();
		}
	}, dialogId);

	return (
		<box flexDirection="column" paddingX={1} gap={1}>
			<text fg={palette.act}>
				<strong>llama.cpp — new server profile</strong>
			</text>
			{phase === "name" ? (
				<>
					<text fg="gray">Name this server (e.g. "fast", "big-context").</text>
					<box
						border
						borderStyle="rounded"
						borderColor={palette.act}
						paddingX={1}
					>
						<input
							value={name}
							onInput={(v: string) => {
								setName(v);
								setError(undefined);
							}}
							placeholder="fast"
							flexGrow={1}
							focused
						/>
					</box>
				</>
			) : (
				<>
					<text fg="gray">
						Port for this server (must differ from any other running llama.cpp
						server).
					</text>
					<box
						border
						borderStyle="rounded"
						borderColor={palette.act}
						paddingX={1}
					>
						<input
							value={port}
							onInput={(v: string) => {
								setPort(v);
								setError(undefined);
							}}
							placeholder={suggestedPort}
							flexGrow={1}
							focused
						/>
					</box>
				</>
			)}
			{error && <text fg="red">{error}</text>}
			<text fg="gray">
				<em>
					Enter to continue, Esc to go back{phase === "port" ? " (name)" : ""}
				</em>
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
const BASE_CONTEXT_SIZE_PRESETS: {
	value: number;
	label: string;
	desc: string;
}[] = [
	{ value: 4096, label: "4,096", desc: "Small — fastest, least RAM" },
	{ value: 8192, label: "8,192", desc: "Default — good balance" },
	{ value: 16384, label: "16,384", desc: "Medium — longer conversations" },
	{ value: 32768, label: "32,768", desc: "Large — big files/contexts" },
	{ value: 65536, label: "65,536", desc: "Extra large — needs more RAM" },
	{ value: 131072, label: "131,072", desc: "128K" },
	{ value: 262144, label: "262,144", desc: "256K" },
	{
		value: 1048576,
		label: "1,048,576",
		desc: "1M — only a few models support this",
	},
];

function formatContextLabel(n: number): string {
	return n.toLocaleString("en-US");
}

/**
 * llama.cpp doesn't clamp an oversized `-c` for you — asking for more context
 * than the model was trained for either gets silently truncated by
 * llama-server or refuses to load, and Cline's own token-budget math (which
 * reuses this same number) would be wrong either way. So instead of letting
 * that happen silently, we read the model's real `context_length` from its
 * GGUF metadata (see readGgufContextLength) and default the picker to that
 * value, flagging any larger preset as exceeding it — still selectable, but
 * an informed choice instead of a silent surprise.
 */
export function LlamaCppContextSizeContent(
	props: ChoiceContext<number> & {
		modelName: string;
		detectedMax: number | null;
	},
) {
	const { resolve, dismiss, dialogId, modelName, detectedMax } = props;

	const presets = detectedMax
		? [
				{
					value: detectedMax,
					label: `${formatContextLabel(detectedMax)} (recommended)`,
					desc: "Detected from this model's metadata",
				},
				...BASE_CONTEXT_SIZE_PRESETS.filter((p) => p.value !== detectedMax).map(
					(p) =>
						p.value > detectedMax
							? {
									...p,
									desc: `${p.desc} — exceeds model's ${formatContextLabel(detectedMax)} limit`,
								}
							: p,
				),
			]
		: BASE_CONTEXT_SIZE_PRESETS;

	const [selected, setSelected] = useState(0);

	useDialogKeyboard((key) => {
		if (key.name === "escape") {
			dismiss();
			return;
		}
		if (key.name === "return" || key.name === "enter") {
			const preset = presets[selected];
			if (preset) resolve(preset.value);
			return;
		}
		if (key.name === "up" || (key.ctrl && key.name === "p")) {
			setSelected((s) => (s <= 0 ? presets.length - 1 : s - 1));
			return;
		}
		if (key.name === "down" || (key.ctrl && key.name === "n")) {
			setSelected((s) => (s >= presets.length - 1 ? 0 : s + 1));
		}
	}, dialogId);

	return (
		<box flexDirection="column" gap={1}>
			<text>Context size for {modelName}</text>
			<text fg="gray">
				{detectedMax
					? `Bigger = more memory of the conversation, but slower and more RAM. This model's metadata reports a ${formatContextLabel(detectedMax)} limit.`
					: "Bigger = more memory of the conversation, but slower and more RAM. Couldn't detect this model's limit from its metadata — pick based on what you know about it."}
			</text>

			<box flexDirection="column">
				{presets.map((preset, i) => (
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
							<text
								fg={i === selected ? palette.textOnSelection : "gray"}
								flexShrink={0}
							>
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
