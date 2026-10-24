import {
	describeProfile,
	type Profile,
	shortProviderName,
	type TeamRosterWorker,
} from "@cline/shared";
import type { SearchableItem } from "../searchable-list";

/**
 * The tools a worker may use, from the roster's point of view.
 *
 * A worker starts with PowerShell (`run_commands`) and `apply_patch`: with a
 * shell it can read, search and run anything, so finer presets only got in
 * its way. The manager narrows or widens a worker per job with a `TOOLS:` line
 * (see manager-block.ts); the roster just sets what it starts with. The rest
 * are opt-in extras.
 */
export const WORKER_TOOLS = [
	{ name: "run_commands", label: "PowerShell (run_commands)" },
	{ name: "apply_patch", label: "apply_patch (edit files)" },
	{ name: "read_files", label: "read_files" },
	{ name: "search_codebase", label: "search_codebase" },
	{ name: "fetch_web_content", label: "fetch_web_content (web)" },
	{ name: "skills", label: "skills" },
] as const;

export const DEFAULT_WORKER_TOOLS: readonly string[] = [
	"run_commands",
	"apply_patch",
];

export const DEFAULT_WORKER_ROLE_PROMPT =
	"Carries out the manager's instructions. Use PowerShell to read, search and run things, and apply_patch to change files. Report what you ran, what you changed with file:line, and what it produced.";

/**
 * `editor` and `apply_patch` are one grant ("may change files"): the worker's
 * provider decides which one it actually gets (applyTeammateToolScope in
 * team-tools.ts), so either name counts as apply_patch here.
 */
function hasTool(tools: readonly string[], name: string): boolean {
	return name === "apply_patch"
		? tools.includes("apply_patch") || tools.includes("editor")
		: tools.includes(name);
}

export function describeTools(tools: string[] | undefined): string {
	if (!tools) {
		return "every tool (unscoped)";
	}
	if (tools.length === 0) {
		return "nothing but reporting back";
	}
	return tools
		.map((name) =>
			name === "run_commands"
				? "PowerShell"
				: name === "editor"
					? "apply_patch"
					: name,
		)
		.filter((name, index, all) => all.indexOf(name) === index)
		.join(", ");
}

/**
 * Keys for the rows that are commands rather than workers.
 *
 * `+` is not legal in an `agentId` (see `TeamRosterWorkerSchema`), so these can
 * never collide with a real worker's key. That matters more than it looks: the
 * bug this dialog replaces was a command and a name sharing one input, and a
 * key like `__add__` would re-create it for anyone who named a worker that.
 */
export const ROW_ADD = "+add";
export const ROW_SAVE = "+save";
export const ROW_BACK = "+back";
export const ROW_INHERIT = "+inherit";
export const ROW_DONE = "+done";
/** "This worker has no profile — pick a provider by hand instead." */
export const ROW_NO_PROFILE = "+no-profile";

export const ACTION_PROVIDER = "+provider";
export const ACTION_MODEL = "+model";
export const ACTION_PROFILE = "+profile";
export const ACTION_TOOLS = "+tools";
export const ACTION_NOTES = "+notes";
export const ACTION_RENAME = "+rename";
export const ACTION_DELETE = "+delete";

/**
 * Where the dialog is.
 *
 * `agentId: null` in the provider/model/tools steps means the wizard is adding
 * a worker rather than editing one, and the partial choices ride along on the
 * step itself so there is no separate draft state that can drift out of sync
 * with the screen that is showing.
 */
export type WorkersStep =
	| { kind: "list" }
	| { kind: "actions"; agentId: string }
	| { kind: "profile"; agentId: string | null }
	| { kind: "provider"; agentId: string | null }
	| { kind: "model"; agentId: string | null; providerId: string }
	| { kind: "tools"; agentId: string }
	| { kind: "notes"; agentId: string }
	| { kind: "rename"; agentId: string }
	| { kind: "delete"; agentId: string };

export function isValidAgentId(value: string): boolean {
	return /^[a-zA-Z0-9._-]+$/.test(value);
}

/** A name derived from the provider, made unique against the roster. */
export function uniqueAgentId(base: string, taken: string[]): string {
	const seed = isValidAgentId(base) ? base : "worker";
	if (!taken.includes(seed)) {
		return seed;
	}
	for (let n = 2; n < 1000; n++) {
		const candidate = `${seed}-${n}`;
		if (!taken.includes(candidate)) {
			return candidate;
		}
	}
	return `${seed}-${Date.now()}`;
}

export function describeWorker(
	worker: TeamRosterWorker,
	profiles?: Profile[],
): string {
	// A worker on a profile is described by the profile, because that is what
	// decides its account. Printing the provider as well would invite reading
	// two workers on one provider as a duplicate, which is the confusion
	// profiles exist to remove.
	const connection = worker.profile
		? describeProfileReference(worker.profile, profiles)
		: `${worker.providerId ?? "lead's provider"} · ${worker.modelId ?? "lead's model"}`;
	const base = `${worker.agentId} — ${connection} · ${describeTools(worker.tools)}`;
	return worker.notes ? `${base} · ${worker.notes}` : base;
}

/**
 * How a worker's profile reads, including when it no longer exists.
 *
 * A dangling name is called out here rather than left to look fine: at spawn
 * time it silently falls back to the lead's account, and two workers doing that
 * land in one chat.
 */
export function describeProfileReference(
	name: string,
	profiles: Profile[] | undefined,
): string {
	const profile = profiles?.find((candidate) => candidate.name === name);
	if (!profile) {
		return `${name} (missing from profiles.json)`;
	}
	const parts = [profile.providerId, profile.modelId ?? "provider's default"];
	if (profile.browserProfile) parts.push(`chrome:${profile.browserProfile}`);
	return `${name} (${parts.join(" · ")})`;
}

/**
 * Point a worker at a named profile.
 *
 * The provider and model are dropped rather than kept alongside. They are the
 * pre-profile way of saying the same thing, and a worker carrying both has two
 * answers for which account it uses — see the `profile` field in the roster
 * schema.
 */
export function applyProfile(
	worker: TeamRosterWorker,
	profileName: string,
): TeamRosterWorker {
	const { providerId: _p, modelId: _m, ...rest } = worker;
	return { ...rest, profile: profileName };
}

/** Take a worker off profiles and back onto a hand-picked provider. */
export function clearProfile(worker: TeamRosterWorker): TeamRosterWorker {
	const { profile: _dropped, ...rest } = worker;
	return rest;
}

export function buildProfileChoiceRows(
	profiles: Profile[],
	current: string | undefined,
): SearchableItem[] {
	return [
		...profiles.map((profile) => ({
			key: profile.name,
			label:
				profile.name === current
					? `${describeProfile(profile)} (current)`
					: describeProfile(profile),
			section: "Profiles",
			searchText: `${profile.name} ${profile.providerId} ${profile.modelId ?? ""} ${profile.browserProfile ?? ""}`,
		})),
		{
			key: ROW_NO_PROFILE,
			label: "No profile — pick a provider by hand",
			section: "Actions",
			searchText: "none provider manual",
		},
	];
}

/**
 * Set or clear a worker's note.
 *
 * An empty box clears it rather than storing `""`, because the roster schema
 * requires a non-empty string and a blank note is the same thing as no note.
 */
export function applyNotes(
	worker: TeamRosterWorker,
	notes: string,
): TeamRosterWorker {
	const trimmed = notes.replace(/\s+/g, " ").trim();
	if (!trimmed) {
		const { notes: _dropped, ...rest } = worker;
		return rest;
	}
	return { ...worker, notes: trimmed };
}

/** Rows for the top level: every worker, then the two commands. */
export function buildWorkerRows(
	workers: TeamRosterWorker[],
	dirty: boolean,
	profiles?: Profile[],
): SearchableItem[] {
	return [
		...workers.map((worker) => ({
			key: worker.agentId,
			label: describeWorker(worker, profiles),
			section: "Workers",
			searchText: `${worker.agentId} ${worker.profile ?? ""} ${worker.providerId ?? ""} ${worker.modelId ?? ""} ${worker.notes ?? ""}`,
		})),
		{
			key: ROW_ADD,
			label: "Add a worker...",
			section: "Actions",
			searchText: "add new worker",
		},
		{
			key: ROW_SAVE,
			label: dirty ? "Save changes" : "Save changes (nothing changed)",
			section: "Actions",
			searchText: "save",
		},
	];
}

export function buildActionRows(
	worker: TeamRosterWorker,
	profiles?: Profile[],
): SearchableItem[] {
	const rows: SearchableItem[] = [
		{
			key: ACTION_PROFILE,
			label: `Profile: ${
				worker.profile
					? describeProfileReference(worker.profile, profiles)
					: "(none)"
			}`,
			searchText: "profile account credentials login",
		},
	];
	// Hidden while a profile is set, because they would do nothing: the profile
	// supersedes them at spawn time, and a row that silently has no effect is
	// worse than one that is not offered.
	if (!worker.profile) {
		rows.push(
			{
				key: ACTION_PROVIDER,
				label: `Provider: ${worker.providerId ?? "lead's provider"}`,
				searchText: "provider",
			},
			{
				key: ACTION_MODEL,
				label: `Model: ${worker.modelId ?? "lead's model"}`,
				searchText: "model",
			},
		);
	}
	rows.push(
		{
			key: ACTION_TOOLS,
			label: `Tools: ${describeTools(worker.tools)}`,
			searchText: "tools approval",
		},
		{
			key: ACTION_NOTES,
			label: `Notes: ${worker.notes ?? "(none)"}`,
			searchText: "notes hint manager description",
		},
		{ key: ACTION_RENAME, label: "Rename...", searchText: "rename" },
		{ key: ACTION_DELETE, label: "Remove this worker", searchText: "delete" },
		{ key: ROW_BACK, label: "Back", searchText: "back" },
	);
	return rows;
}

export function buildProviderRows(
	providerIds: string[],
	currentProviderId: string | undefined,
): SearchableItem[] {
	return providerIds.map((providerId) => ({
		key: providerId,
		label:
			providerId === currentProviderId ? `${providerId} (current)` : providerId,
		section: "Provider",
		searchText: `${providerId} ${shortProviderName(providerId)}`,
	}));
}

export function buildModelRows(
	modelIds: string[],
	currentModelId: string | undefined,
): SearchableItem[] {
	return [
		{
			key: ROW_INHERIT,
			label:
				currentModelId === undefined
					? "Provider's saved model (current)"
					: "Provider's saved model",
			section: "Model",
			searchText: "inherit default saved lead",
		},
		...modelIds.map((modelId) => ({
			key: modelId,
			label: modelId === currentModelId ? `${modelId} (current)` : modelId,
			section: "Model",
			searchText: modelId,
		})),
	];
}

export function buildToolRows(tools: string[] | undefined): SearchableItem[] {
	const held = tools ?? WORKER_TOOLS.map((tool) => tool.name);
	return [
		...WORKER_TOOLS.map((tool) => ({
			key: tool.name,
			label: `${hasTool(held, tool.name) ? "[x]" : "[ ]"} ${tool.label}${
				DEFAULT_WORKER_TOOLS.includes(tool.name) ? " (default)" : ""
			}`,
			section: "Tools this worker starts with (Enter toggles)",
			searchText: `${tool.name} ${tool.label}`,
		})),
		{ key: ROW_DONE, label: "Done", searchText: "done back" },
	];
}

/**
 * Point a worker at a different provider.
 *
 * A manager addresses a worker by the short model name (`TO: qwen`), so a
 * worker named after its provider has to keep that name when the provider
 * changes — otherwise the roster still says "qwen" and the messages go to a
 * Gemini chat. A hand-picked name is left alone, the same way a hand-written
 * role prompt is left alone. The model is dropped because a model id
 * from the old provider is not valid for the new one, and keeping it would fail
 * at spawn time instead of here.
 */
export function applyProvider(
	worker: TeamRosterWorker,
	providerId: string,
	taken: string[],
): TeamRosterWorker {
	if (worker.providerId === providerId) {
		return worker;
	}
	const followsProvider =
		worker.providerId !== undefined &&
		worker.agentId === shortProviderName(worker.providerId);
	const agentId = followsProvider
		? uniqueAgentId(
				shortProviderName(providerId),
				taken.filter((id) => id !== worker.agentId),
			)
		: worker.agentId;
	const { modelId: _dropped, ...rest } = worker;
	return { ...rest, providerId, agentId };
}

export function applyModel(
	worker: TeamRosterWorker,
	modelId: string | undefined,
): TeamRosterWorker {
	if (modelId === undefined) {
		const { modelId: _dropped, ...rest } = worker;
		return rest;
	}
	return { ...worker, modelId };
}

/**
 * Turn one tool on or off for a worker. An unscoped worker (no list) holds
 * every tool, so it starts from the full list.
 */
export function toggleWorkerTool(
	worker: TeamRosterWorker,
	name: string,
): TeamRosterWorker {
	const held = worker.tools ?? WORKER_TOOLS.map((tool) => tool.name);
	const tools = hasTool(held, name)
		? held.filter(
				(tool) =>
					tool !== name && !(name === "apply_patch" && tool === "editor"),
			)
		: [...held, name];
	return { ...worker, tools };
}

export function buildWorker(options: {
	providerId: string;
	modelId?: string;
	taken: string[];
}): TeamRosterWorker {
	return {
		agentId: uniqueAgentId(
			shortProviderName(options.providerId),
			options.taken,
		),
		rolePrompt: DEFAULT_WORKER_ROLE_PROMPT,
		providerId: options.providerId,
		...(options.modelId === undefined ? {} : { modelId: options.modelId }),
		tools: [...DEFAULT_WORKER_TOOLS],
	};
}

/**
 * A worker built from a profile rather than a hand-picked provider.
 *
 * Named after the profile, because that is what distinguishes it from the
 * sibling on the same provider — `deepseek-work` says which account, where
 * `deepseek-2` says only that there are two.
 */
export function buildWorkerFromProfile(options: {
	profile: Profile;
	taken: string[];
}): TeamRosterWorker {
	return {
		agentId: uniqueAgentId(options.profile.name, options.taken),
		rolePrompt: DEFAULT_WORKER_ROLE_PROMPT,
		profile: options.profile.name,
		tools: [...DEFAULT_WORKER_TOOLS],
	};
}

export type RenameResult =
	| { ok: true; workers: TeamRosterWorker[] }
	| { ok: false; error: string };

export function renameWorker(
	workers: TeamRosterWorker[],
	from: string,
	to: string,
): RenameResult {
	const name = to.trim();
	if (!name) {
		return { ok: false, error: "A worker needs a name." };
	}
	if (!isValidAgentId(name)) {
		return {
			ok: false,
			error: "Only letters, digits, dot, underscore and hyphen.",
		};
	}
	if (name !== from && workers.some((worker) => worker.agentId === name)) {
		return { ok: false, error: `There is already a worker called ${name}.` };
	}
	return {
		ok: true,
		workers: workers.map((worker) =>
			worker.agentId === from ? { ...worker, agentId: name } : worker,
		),
	};
}
