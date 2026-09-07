"use client";

import {
	GripVerticalIcon,
	PlusIcon,
	RefreshCwIcon,
	Trash2Icon,
	UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PageFrame, PageHeader } from "@/components/views/page-layout";
import { postToHost } from "@/vscode";
import type {
	WebviewProviderModel,
	WebviewTeamRun,
	WebviewTeamState,
	WebviewTeamWorker,
} from "../../../../webview-protocol";

/** One enabled provider, as the `providers` message reports it. */
type ProviderOption = {
	id: string;
	name: string;
	defaultModelId?: string;
};

type TeamViewProps = {
	/**
	 * Team the dashboard reads. The runtime keys team state by session id, so
	 * this is the id of the session running the lead.
	 */
	teamKey?: string;
};

const WORKER_STATUS_STYLES: Record<string, string> = {
	running: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
	idle: "bg-muted text-muted-foreground",
	stopped: "bg-muted text-muted-foreground",
};

const RUN_STATUS_STYLES: Record<WebviewTeamRun["status"], string> = {
	queued: "bg-muted text-muted-foreground",
	running: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
	completed: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
	failed: "bg-destructive/15 text-destructive",
	cancelled: "bg-muted text-muted-foreground",
	interrupted: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
};

/**
 * A roster row being edited.
 *
 * The row carries its own id because `agentId` is empty on a fresh row and
 * changes as it is typed, so neither it nor the array index identifies a row
 * across renders. Keying on the index would carry a half-typed row's focus and
 * cursor over to its neighbour the moment a row above it is deleted.
 */
type DraftRow = { key: string; worker: WebviewTeamWorker };

let draftRowCounter = 0;

function newDraftRow(worker?: WebviewTeamWorker): DraftRow {
	draftRowCounter += 1;
	return {
		key: `row-${draftRowCounter}`,
		worker: worker ?? { agentId: "", rolePrompt: "" },
	};
}

/**
 * What a provider or model chip carries while it is being dragged.
 *
 * A private MIME type rather than `text/plain`: dropping a chip is a structured
 * assignment, and a stray drag from somewhere else in the page must not be read
 * as one. A model chip carries its provider too — a model id means nothing
 * without the provider that serves it.
 */
const DRAG_MIME = "application/x-cline-provider-model";

type ProviderDrag = { providerId: string; modelId?: string };

function readProviderDrag(
	transfer: DataTransfer | null,
): ProviderDrag | undefined {
	const raw = transfer?.getData(DRAG_MIME);
	if (!raw) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as ProviderDrag;
		return typeof parsed?.providerId === "string" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function setProviderDrag(transfer: DataTransfer, payload: ProviderDrag): void {
	transfer.setData(DRAG_MIME, JSON.stringify(payload));
	// A readable text/plain fallback so dragging into an editor or the role
	// prompt does something sensible instead of pasting nothing.
	transfer.setData(
		"text/plain",
		payload.modelId
			? `${payload.providerId} / ${payload.modelId}`
			: payload.providerId,
	);
	transfer.effectAllowed = "copy";
}

function Field({
	label,
	onChange,
	placeholder,
	value,
}: {
	label: string;
	onChange: (next: string) => void;
	placeholder?: string;
	value: string;
}) {
	return (
		<label className="flex min-w-0 flex-1 flex-col gap-1">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			<input
				className="h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				value={value}
			/>
		</label>
	);
}

/**
 * A picker that still accepts a value it has never heard of.
 *
 * A roster can name a provider or model this hub has not enabled, and the file
 * on disk is the source of truth — silently dropping such a value on the next
 * save would rewrite the user's roster behind their back. So an unknown value
 * is kept as an extra option and marked.
 */
function Picker({
	emptyLabel,
	label,
	onChange,
	options,
	value,
}: {
	emptyLabel: string;
	label: string;
	onChange: (next: string | undefined) => void;
	options: Array<{ id: string; name: string }>;
	value?: string;
}) {
	const known = options.some((option) => option.id === value);
	return (
		<label className="flex min-w-0 flex-1 flex-col gap-1">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			<select
				className="h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
				onChange={(event) => onChange(event.target.value || undefined)}
				value={value ?? ""}
			>
				<option value="">{emptyLabel}</option>
				{value && !known ? (
					<option value={value}>{value} (not available here)</option>
				) : null}
				{options.map((option) => (
					<option key={option.id} value={option.id}>
						{option.name}
					</option>
				))}
			</select>
		</label>
	);
}

export default function TeamView({ teamKey }: TeamViewProps) {
	const [state, setState] = useState<WebviewTeamState | undefined>();
	const [draft, setDraft] = useState<DraftRow[]>([]);
	const [dirty, setDirty] = useState(false);
	const [savedPath, setSavedPath] = useState<string | undefined>();
	const [assignAgentId, setAssignAgentId] = useState("");
	const [assignTask, setAssignTask] = useState("");
	const [assignSent, setAssignSent] = useState(false);
	const [providers, setProviders] = useState<ProviderOption[]>([]);
	const [modelsByProvider, setModelsByProvider] = useState<
		Record<string, WebviewProviderModel[]>
	>({});
	const [openProvider, setOpenProvider] = useState<string | undefined>();
	const [dropTarget, setDropTarget] = useState<string | undefined>();

	const refresh = useCallback(() => {
		// The roster is a file on disk, not session state, so it loads with or
		// without a session. An empty key just means there is no live team to
		// report alongside it.
		postToHost({ type: "loadTeamState", teamKey: teamKey ?? "" });
	}, [teamKey]);

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data;
			if (!message || typeof message !== "object") {
				return;
			}
			if (message.type === "team_state") {
				const next = message as WebviewTeamState;
				setState(next);
				// An in-progress edit is not thrown away by a refresh landing
				// underneath it; the roster on disk only replaces the draft once the
				// user has no unsaved changes.
				setDirty((wasDirty) => {
					if (!wasDirty) {
						setDraft(next.roster.workers.map((worker) => newDraftRow(worker)));
					}
					return wasDirty;
				});
				return;
			}
			if (message.type === "team_roster_saved") {
				setSavedPath(message.path);
				setDirty(false);
				return;
			}
			if (message.type === "providers") {
				setProviders(message.providers as ProviderOption[]);
				return;
			}
			if (message.type === "models") {
				setModelsByProvider((current) => ({
					...current,
					[message.providerId as string]:
						message.models as WebviewProviderModel[],
				}));
			}
		};
		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, []);

	useEffect(() => {
		refresh();
		// The provider list is pushed once during `ready`, before this view
		// exists, so it has to be asked for.
		postToHost({ type: "loadProviders" });
	}, [refresh]);

	// Models are fetched per provider and cached, because the roster can point
	// each worker at a different one and the host serves one provider per call.
	const requestModels = useCallback(
		(providerId: string) => {
			if (!providerId || modelsByProvider[providerId]) {
				return;
			}
			postToHost({ type: "loadModels", providerId });
		},
		[modelsByProvider],
	);

	useEffect(() => {
		for (const providerId of new Set(
			draft
				.map((row) => row.worker.providerId)
				.filter((id): id is string => Boolean(id)),
		)) {
			requestModels(providerId);
		}
	}, [draft, requestModels]);

	const updateWorker = (
		key: string,
		patch: Partial<WebviewTeamWorker>,
	): void => {
		setDirty(true);
		setDraft((rows) =>
			rows.map((row) =>
				row.key === key ? { ...row, worker: { ...row.worker, ...patch } } : row,
			),
		);
	};

	/**
	 * Apply a dropped provider/model to a row.
	 *
	 * Dropping a bare provider clears the model: a model id belongs to exactly
	 * one provider, so keeping the old one would leave the row naming a model
	 * the new provider does not serve — which the roster loader accepts and the
	 * run then fails on.
	 */
	const applyDrag = (key: string, drag: ProviderDrag): void => {
		updateWorker(key, {
			providerId: drag.providerId,
			modelId: drag.modelId,
		});
		requestModels(drag.providerId);
	};

	/**
	 * Rows the roster schema would reject, keyed by draft row.
	 *
	 * These used to be filtered out at save time. That silently wrote an empty
	 * roster for anyone who filled in agent ids and providers but left the role
	 * prompt blank — the save reported success and the workers were simply gone.
	 * Incomplete rows now block the save and say which field is missing.
	 */
	const rowProblems = new Map<string, string>();
	const seenAgentIds = new Set<string>();
	for (const { key, worker } of draft) {
		const agentId = worker.agentId.trim();
		if (!agentId) {
			rowProblems.set(key, "Agent ID is required.");
		} else if (!/^[a-zA-Z0-9._-]+$/.test(agentId)) {
			rowProblems.set(
				key,
				"Agent ID may only contain letters, digits, dot, dash and underscore.",
			);
		} else if (seenAgentIds.has(agentId)) {
			rowProblems.set(key, `Another worker is already called "${agentId}".`);
		} else if (!worker.rolePrompt.trim()) {
			rowProblems.set(
				key,
				"Role prompt is required — say what this worker is for.",
			);
		}
		if (agentId) {
			seenAgentIds.add(agentId);
		}
	}

	const saveRoster = () => {
		if (!state || rowProblems.size > 0) {
			return;
		}
		postToHost({
			type: "saveTeamRoster",
			path: state.roster.path,
			workers: draft.map((row) => ({
				...row.worker,
				agentId: row.worker.agentId.trim(),
				rolePrompt: row.worker.rolePrompt.trim(),
			})),
		});
	};

	const sendAssignment = () => {
		if (!assignAgentId.trim() || !assignTask.trim()) {
			return;
		}
		// The dashboard does not write team state directly — it phrases the
		// instruction and sends it down the ordinary chat path, leaving the lead
		// to run its own tools. Writing to the runtime from here would race the
		// agent loop, which is the only writer that knows what a worker is doing.
		postToHost({
			type: "send",
			prompt:
				`Delegate this to teammate "${assignAgentId.trim()}" using team_run_task ` +
				`(runMode async), then await it and evaluate the reply before marking it done:\n\n${assignTask.trim()}`,
		});
		setAssignTask("");
		setAssignSent(true);
	};

	const runtimeWorkers = state?.workers ?? [];
	const knownWorkerIds = Array.from(
		new Set([
			...runtimeWorkers.map((worker) => worker.agentId),
			...draft
				.map((row) => row.worker.agentId.trim())
				.filter((id) => id.length > 0),
		]),
	);
	const runs = state?.runs ?? [];

	return (
		<PageFrame>
			<PageHeader
				actions={
					<button
						className="flex h-8 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent"
						onClick={refresh}
						type="button"
					>
						<RefreshCwIcon className="size-4" />
						Refresh
					</button>
				}
				description="Workers and recent delegated runs."
				icon={UsersIcon}
				title="Team"
			/>

			{state?.error ? (
				<p className="mb-6 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{state.error}
				</p>
			) : null}
			{state?.roster.error ? (
				<p className="mb-6 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
					Roster file rejected: {state.roster.error}
				</p>
			) : null}

			<section className="mb-10">
				<div className="mb-3 flex items-center justify-between gap-3">
					<div className="min-w-0">
						<h2 className="text-lg font-semibold">Roster</h2>
						<p className="truncate text-xs text-muted-foreground">
							{state?.roster.path}
							{state?.roster.exists ? "" : " (not created yet)"}
						</p>
					</div>
					<div className="flex items-center gap-2">
						<button
							className="flex h-8 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent"
							onClick={() => {
								setDirty(true);
								setDraft((rows) => [...rows, newDraftRow()]);
							}}
							type="button"
						>
							<PlusIcon className="size-4" />
							Add worker
						</button>
						<button
							className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
							disabled={!dirty || rowProblems.size > 0}
							onClick={saveRoster}
							title={
								rowProblems.size > 0
									? "Finish or remove the incomplete workers first."
									: undefined
							}
							type="button"
						>
							Save roster
						</button>
					</div>
				</div>

				<p className="mb-3 text-xs text-muted-foreground">
					Drag a provider — or one of its models — onto a worker to point it
					there. A worker with no provider inherits the lead's. Roster changes
					apply when the team next starts a worker; they do not re-point a
					worker that is already running.
				</p>

				<div className="mb-4 rounded-lg border border-border p-3">
					<div className="mb-2 flex items-center gap-2">
						<GripVerticalIcon className="size-4 text-muted-foreground" />
						<span className="text-xs font-medium text-muted-foreground">
							Providers — drag onto a worker, or click one to see its models
						</span>
					</div>
					{providers.length === 0 ? (
						<p className="text-xs text-muted-foreground">
							No providers enabled yet. Add one in Settings.
						</p>
					) : (
						<div className="flex flex-wrap gap-2">
							{providers.map((provider) => (
								<div className="flex flex-col gap-1" key={provider.id}>
									<button
										className={`flex h-7 cursor-grab items-center gap-1.5 rounded-md border px-2 text-xs font-medium active:cursor-grabbing ${
											openProvider === provider.id
												? "border-primary bg-primary/10"
												: "border-border hover:bg-accent"
										}`}
										draggable
										onClick={() => {
											setOpenProvider((current) =>
												current === provider.id ? undefined : provider.id,
											);
											requestModels(provider.id);
										}}
										onDragStart={(event) =>
											setProviderDrag(event.dataTransfer, {
												providerId: provider.id,
											})
										}
										type="button"
									>
										<GripVerticalIcon className="size-3 text-muted-foreground" />
										{provider.name}
									</button>
									{openProvider === provider.id ? (
										<div className="flex max-w-72 flex-wrap gap-1">
											{(modelsByProvider[provider.id] ?? []).length === 0 ? (
												<span className="text-xs text-muted-foreground">
													Loading models…
												</span>
											) : (
												modelsByProvider[provider.id]?.map((model) => (
													<span
														className="cursor-grab rounded border border-dashed border-border px-1.5 py-0.5 text-xs text-muted-foreground active:cursor-grabbing"
														draggable
														key={model.id}
														onDragStart={(event) =>
															setProviderDrag(event.dataTransfer, {
																providerId: provider.id,
																modelId: model.id,
															})
														}
													>
														{model.name || model.id}
													</span>
												))
											)}
										</div>
									) : null}
								</div>
							))}
						</div>
					)}
				</div>
				{savedPath ? (
					<p className="mb-3 text-xs text-emerald-600 dark:text-emerald-400">
						Saved to {savedPath}
					</p>
				) : null}

				<div className="space-y-3">
					{draft.length === 0 ? (
						<p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
							No workers declared. Add one to pin its provider and role.
						</p>
					) : null}
					{draft.map(({ key, worker }) => (
						// biome-ignore lint/a11y/noStaticElementInteractions: the drop
						// target is the whole row; the same assignment is reachable from
						// the keyboard through the provider and model selects below.
						<div
							className={`rounded-lg border p-3 ${
								dropTarget === key
									? "border-primary bg-primary/5"
									: "border-border"
							}`}
							key={key}
							onDragLeave={() =>
								setDropTarget((current) =>
									current === key ? undefined : current,
								)
							}
							onDragOver={(event) => {
								if (!event.dataTransfer.types.includes(DRAG_MIME)) {
									return;
								}
								// Without preventDefault the browser refuses the drop.
								event.preventDefault();
								event.dataTransfer.dropEffect = "copy";
								setDropTarget(key);
							}}
							onDrop={(event) => {
								const drag = readProviderDrag(event.dataTransfer);
								setDropTarget(undefined);
								if (!drag) {
									return;
								}
								event.preventDefault();
								applyDrag(key, drag);
							}}
						>
							<div className="mb-2 flex flex-wrap items-end gap-3">
								<Field
									label="Agent ID"
									onChange={(next) => updateWorker(key, { agentId: next })}
									placeholder="extractor"
									value={worker.agentId}
								/>
								<Picker
									emptyLabel="inherit from lead"
									label="Provider"
									onChange={(next) => {
										updateWorker(key, {
											providerId: next,
											// Changing provider invalidates the model, same as a drop.
											modelId: undefined,
										});
										if (next) {
											requestModels(next);
										}
									}}
									options={providers}
									value={worker.providerId}
								/>
								<Picker
									emptyLabel={
										worker.providerId ? "provider default" : "inherit from lead"
									}
									label="Model"
									onChange={(next) => updateWorker(key, { modelId: next })}
									options={(
										modelsByProvider[worker.providerId ?? ""] ?? []
									).map((model) => ({
										id: model.id,
										name: model.name || model.id,
									}))}
									value={worker.modelId}
								/>
								<button
									aria-label="Remove worker"
									className="h-8 rounded-md border border-border px-2 text-muted-foreground hover:bg-accent"
									onClick={() => {
										setDirty(true);
										setDraft((rows) => rows.filter((row) => row.key !== key));
									}}
									type="button"
								>
									<Trash2Icon className="size-4" />
								</button>
							</div>
							<label className="flex flex-col gap-1">
								<span className="text-xs font-medium text-muted-foreground">
									Role prompt
								</span>
								<textarea
									className="min-h-16 rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
									onChange={(event) =>
										updateWorker(key, { rolePrompt: event.target.value })
									}
									placeholder="What this worker is for."
									value={worker.rolePrompt}
								/>
							</label>
							{rowProblems.get(key) ? (
								<p className="mt-2 text-xs text-destructive">
									{rowProblems.get(key)}
								</p>
							) : null}
						</div>
					))}
				</div>
			</section>

			<section className="mb-10">
				<h2 className="mb-3 text-lg font-semibold">Live workers</h2>
				{runtimeWorkers.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						{teamKey
							? "No workers running in this team yet."
							: "No session open. The roster above is saved to disk and applies to the next session that starts a worker."}
					</p>
				) : (
					<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
						{runtimeWorkers.map((worker) => (
							<div
								className="rounded-lg border border-border p-3"
								key={worker.agentId}
							>
								<div className="mb-1 flex items-center justify-between gap-2">
									<span className="truncate font-medium">{worker.agentId}</span>
									<span
										className={`rounded px-1.5 py-0.5 text-xs ${
											WORKER_STATUS_STYLES[worker.status ?? "stopped"] ?? ""
										}`}
									>
										{worker.status ?? "stopped"}
									</span>
								</div>
								<p className="text-xs text-muted-foreground">
									{worker.providerId ?? "lead's provider"}
									{worker.modelId ? ` · ${worker.modelId}` : ""}
								</p>
							</div>
						))}
					</div>
				)}
			</section>

			<section className="mb-10">
				<h2 className="mb-3 text-lg font-semibold">Assign work</h2>
				<div className="rounded-lg border border-border p-3">
					<div className="mb-2 flex flex-wrap items-end gap-3">
						<Picker
							emptyLabel="pick a worker"
							label="Worker"
							onChange={(next) => setAssignAgentId(next ?? "")}
							// Live workers first, then anyone the roster declares who has
							// not started yet — the lead spawns those on demand, so they
							// are legitimate targets.
							options={knownWorkerIds.map((id) => ({ id, name: id }))}
							value={assignAgentId || undefined}
						/>
					</div>
					<textarea
						className="mb-2 min-h-20 w-full rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
						onChange={(event) => setAssignTask(event.target.value)}
						placeholder="Describe the task in enough detail that the worker needs no follow-up."
						value={assignTask}
					/>
					<button
						className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
						disabled={!teamKey || !assignAgentId.trim() || !assignTask.trim()}
						onClick={sendAssignment}
						title={
							teamKey
								? undefined
								: "Open a session first — the instruction is sent to its lead."
						}
						type="button"
					>
						Send to lead
					</button>
					{assignSent ? (
						<p className="mt-2 text-xs text-muted-foreground">
							Sent. Watch the run appear below, or open the chat to follow the
							lead's reasoning.
						</p>
					) : null}
				</div>
			</section>

			<section>
				<h2 className="mb-3 text-lg font-semibold">Recent runs</h2>
				{runs.length === 0 ? (
					<p className="text-sm text-muted-foreground">No runs yet.</p>
				) : (
					<div className="space-y-2">
						{runs.map((run) => (
							<div className="rounded-lg border border-border p-3" key={run.id}>
								<div className="mb-1 flex flex-wrap items-center gap-2">
									<span className="font-medium">{run.agentId}</span>
									<span
										className={`rounded px-1.5 py-0.5 text-xs ${RUN_STATUS_STYLES[run.status]}`}
									>
										{run.status}
									</span>
									<span className="text-xs text-muted-foreground">
										{run.currentActivity ?? run.lastProgressMessage ?? ""}
									</span>
								</div>
								{run.error ? (
									<p className="text-xs text-destructive">{run.error}</p>
								) : null}
								{run.textPreview ? (
									<p className="line-clamp-3 text-xs text-muted-foreground">
										{run.textPreview}
									</p>
								) : null}
							</div>
						))}
					</div>
				)}
			</section>
		</PageFrame>
	);
}
