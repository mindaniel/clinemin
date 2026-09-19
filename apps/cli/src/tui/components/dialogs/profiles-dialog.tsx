import type { Profile } from "@cline/shared";
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
	ACTION_CHROME,
	ACTION_DELETE,
	ACTION_MODEL,
	ACTION_NOTES,
	ACTION_PROVIDER,
	ACTION_RENAME,
	applyBrowserProfile,
	applyModel,
	applyNotes,
	applyProvider,
	browserLoginOwners,
	buildChromeRows,
	buildModelRows,
	buildProfile,
	buildProfileActionRows,
	buildProfileRows,
	buildProviderRows,
	type ProfilesStep,
	ROW_ADD,
	ROW_BACK,
	ROW_INHERIT,
	ROW_NEW_CHROME,
	ROW_NO_CHROME,
	ROW_SAVE,
	renameProfile,
	suggestProfileName,
	usesBrowserLogin,
	validateProfileName,
} from "./profiles-dialog-helpers";

export type ProfilesDialogResult = {
	profiles: Profile[];
	/** Chrome logins the user asked for that do not exist yet. */
	newBrowserProfiles: string[];
};

const YES = "+yes";
const NO = "+no";

/**
 * Dialog content for `/profiles`: the named connections, editable in place.
 *
 * A profile is a provider plus the credential that authenticates it, so this
 * dialog is what makes two workers on one provider possible — `deepseek-work`
 * and `deepseek-personal` are two Chrome logins, not two names for one.
 *
 * ## The API key is not editable here, on purpose
 *
 * A profile may carry `apiKey`, `baseUrl` and `headers`, and this dialog sets
 * none of them. The TUI has one text field, it echoes what is typed, and what
 * is typed also lands in the input history — so a key entered here would be on
 * screen and in a scrollback that gets pasted into bug reports. The web
 * providers, which are the case that actually needs several profiles, have no
 * key at all: their credential is the Chrome login, which this dialog does set.
 * For an API provider, add the key by hand to `profiles.json`; the file is
 * written with 0600 and the schema accepts it.
 *
 * Every action is a row you select with Enter and no letter key does anything,
 * for the reason the workers dialog documents: a dialog cannot have both a text
 * field and single-letter commands.
 */
export function ProfilesDialogContent(
	props: ChoiceContext<ProfilesDialogResult> & {
		initialProfiles: Profile[];
		providerIds: string[];
		modelsByProvider: Record<string, string[]>;
		browserProfiles: string[];
		storePath: string;
	},
) {
	const {
		resolve,
		dismiss,
		dialogId,
		initialProfiles,
		providerIds,
		modelsByProvider,
		browserProfiles,
		storePath,
	} = props;
	const [profiles, setProfiles] = useState<Profile[]>(initialProfiles);
	const [newBrowserProfiles, setNewBrowserProfiles] = useState<string[]>([]);
	const [step, setStep] = useState<ProfilesStep>({ kind: "list" });
	const [dirty, setDirty] = useState(false);
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | undefined>();

	const focused =
		"name" in step && step.name
			? profiles.find((profile) => profile.name === step.name)
			: undefined;

	const knownBrowserProfiles = useMemo(
		() => [...browserProfiles, ...newBrowserProfiles],
		[browserProfiles, newBrowserProfiles],
	);

	const items: SearchableItem[] = useMemo(() => {
		switch (step.kind) {
			case "list":
				return buildProfileRows(profiles, dirty);
			case "actions":
				return focused ? buildProfileActionRows(focused) : [];
			case "provider":
				return buildProviderRows(providerIds, focused?.providerId);
			case "model":
				return buildModelRows(
					modelsByProvider[step.providerId] ?? [],
					focused?.modelId,
				);
			case "chrome":
				return buildChromeRows({
					browserProfiles: knownBrowserProfiles,
					providerId: step.providerId,
					current: focused?.browserProfile,
					takenBy: browserLoginOwners(
						profiles,
						step.providerId,
						step.name ?? undefined,
					),
				});
			case "delete":
				return [
					{ key: NO, label: "No, keep it" },
					{ key: YES, label: `Yes, remove ${step.name}` },
				];
			case "newChrome":
			case "name":
			case "notes":
			case "rename":
				return [];
		}
	}, [
		step,
		profiles,
		dirty,
		focused,
		providerIds,
		modelsByProvider,
		knownBrowserProfiles,
	]);

	const list = useSearchableList(items);

	const goTo = (next: ProfilesStep): void => {
		setError(undefined);
		list.setSearch("");
		setStep(next);
	};

	const editProfile = (
		name: string,
		change: (profile: Profile) => Profile,
	): void => {
		setDirty(true);
		setProfiles((current) =>
			current.map((profile) =>
				profile.name === name ? change(profile) : profile,
			),
		);
	};

	/**
	 * The last step of the add wizard: name it and put it in the list.
	 *
	 * Creation is deferred to here rather than done as soon as the provider is
	 * picked, because a profile with no name cannot go in the list, and a
	 * placeholder name that the user then renames would leave a half-made entry
	 * behind if they pressed Escape.
	 */
	const createProfile = (
		rawName: string,
		draftStep: Extract<ProfilesStep, { kind: "name" }>,
	): void => {
		// An empty box takes the suggestion rather than erroring. The suggestion
		// is already on screen above the field, so Enter on an untouched box is a
		// deliberate "yes, that one" and not a slip.
		const result = validateProfileName(
			profiles,
			rawName.trim() || suggestedName(draftStep),
		);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		const created = buildProfile({
			name: result.name,
			providerId: draftStep.providerId,
			modelId: draftStep.modelId,
			browserProfile: draftStep.browserProfile,
		});
		setDirty(true);
		setProfiles((current) => [...current, created]);
		goTo({ kind: "actions", name: created.name });
	};

	/** Where the add wizard goes after a model is chosen. */
	const afterModel = (
		name: string | null,
		providerId: string,
		modelId: string | undefined,
	): void => {
		if (name !== null) {
			editProfile(name, (profile) => applyModel(profile, modelId));
			goTo({ kind: "actions", name });
			return;
		}
		if (usesBrowserLogin(providerId)) {
			goTo({ kind: "chrome", name: null, providerId, modelId });
			return;
		}
		setDraft("");
		goTo({ kind: "name", providerId, modelId });
	};

	const select = (key: string): void => {
		switch (step.kind) {
			case "list": {
				if (key === ROW_SAVE) {
					resolve({ profiles, newBrowserProfiles });
					return;
				}
				if (key === ROW_ADD) {
					goTo({ kind: "provider", name: null });
					return;
				}
				goTo({ kind: "actions", name: key });
				return;
			}
			case "actions": {
				if (key === ROW_BACK) {
					goTo({ kind: "list" });
					return;
				}
				if (key === ACTION_PROVIDER) {
					goTo({ kind: "provider", name: step.name });
					return;
				}
				if (key === ACTION_MODEL) {
					if (!focused) return;
					goTo({
						kind: "model",
						name: step.name,
						providerId: focused.providerId,
					});
					return;
				}
				if (key === ACTION_CHROME) {
					if (!focused) return;
					goTo({
						kind: "chrome",
						name: step.name,
						providerId: focused.providerId,
						modelId: focused.modelId,
					});
					return;
				}
				if (key === ACTION_NOTES) {
					setDraft("");
					goTo({ kind: "notes", name: step.name });
					return;
				}
				if (key === ACTION_RENAME) {
					setDraft(step.name);
					goTo({ kind: "rename", name: step.name });
					return;
				}
				if (key === ACTION_DELETE) {
					goTo({ kind: "delete", name: step.name });
				}
				return;
			}
			case "provider": {
				if (step.name === null) {
					goTo({ kind: "model", name: null, providerId: key });
					return;
				}
				editProfile(step.name, (profile) => applyProvider(profile, key));
				goTo({ kind: "actions", name: step.name });
				return;
			}
			case "model": {
				afterModel(
					step.name,
					step.providerId,
					key === ROW_INHERIT ? undefined : key,
				);
				return;
			}
			case "chrome": {
				if (key === ROW_NEW_CHROME) {
					setDraft("");
					goTo({
						kind: "newChrome",
						name: step.name,
						providerId: step.providerId,
						modelId: step.modelId,
					});
					return;
				}
				const browserProfile = key === ROW_NO_CHROME ? undefined : key;
				if (step.name === null) {
					setDraft("");
					goTo({
						kind: "name",
						providerId: step.providerId,
						modelId: step.modelId,
						browserProfile,
					});
					return;
				}
				editProfile(step.name, (profile) =>
					applyBrowserProfile(profile, browserProfile),
				);
				goTo({ kind: "actions", name: step.name });
				return;
			}
			case "delete": {
				if (key === YES) {
					setDirty(true);
					setProfiles((current) =>
						current.filter((profile) => profile.name !== step.name),
					);
					goTo({ kind: "list" });
					return;
				}
				goTo({ kind: "actions", name: step.name });
				return;
			}
			case "newChrome":
			case "name":
			case "notes":
			case "rename":
				return;
		}
	};

	/** Enter on a step whose input is a text field rather than a list. */
	const submitDraft = (): void => {
		switch (step.kind) {
			case "name": {
				createProfile(draft, step);
				return;
			}
			case "rename": {
				const result = validateProfileName(profiles, draft, step.name);
				if (!result.ok) {
					setError(result.error);
					return;
				}
				setDirty(true);
				setProfiles((current) =>
					renameProfile(current, step.name, result.name),
				);
				goTo({ kind: "actions", name: result.name });
				return;
			}
			case "notes": {
				editProfile(step.name, (profile) => applyNotes(profile, draft));
				goTo({ kind: "actions", name: step.name });
				return;
			}
			case "newChrome": {
				const name = draft.trim();
				if (!name) {
					setError("A Chrome login needs a name.");
					return;
				}
				// Only recorded here; the login is created by the caller on save.
				// Creating it from inside the dialog would leave a directory behind
				// for a profile the user then abandoned with Escape.
				if (!knownBrowserProfiles.includes(name)) {
					setNewBrowserProfiles((current) => [...current, name]);
				}
				if (step.name === null) {
					setDraft("");
					goTo({
						kind: "name",
						providerId: step.providerId,
						modelId: step.modelId,
						browserProfile: name,
					});
					return;
				}
				editProfile(step.name, (profile) => applyBrowserProfile(profile, name));
				goTo({ kind: "actions", name: step.name });
				return;
			}
			default:
				return;
		}
	};

	/** The name this profile gets if the user just presses Enter. */
	const suggestedName = (
		draftStep: Extract<ProfilesStep, { kind: "name" }>,
	): string =>
		suggestProfileName({
			providerId: draftStep.providerId,
			browserProfile: draftStep.browserProfile,
			taken: profiles.map((profile) => profile.name),
		});

	const isTextStep =
		step.kind === "name" ||
		step.kind === "rename" ||
		step.kind === "notes" ||
		step.kind === "newChrome";

	useDialogKeyboard(async (key) => {
		if (key.name === "escape") {
			if (step.kind === "list") {
				dismiss();
				return;
			}
			goTo(
				"name" in step && step.name
					? { kind: "actions", name: step.name }
					: { kind: "list" },
			);
			return;
		}

		if (key.name === "return" || key.name === "enter") {
			if (isTextStep) {
				submitDraft();
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
				return `Profiles (${profiles.length})${dirty ? " — unsaved" : ""}`;
			case "actions":
				return step.name;
			case "provider":
				return step.name === null
					? "New profile — pick a provider"
					: `${step.name} — pick a provider`;
			case "model":
				return `${step.name ?? "New profile"} — pick a model on ${step.providerId}`;
			case "chrome":
				return `${step.name ?? "New profile"} — which Chrome login?`;
			case "newChrome":
				return "Name the new Chrome login";
			case "name":
				return "Name this profile";
			case "notes":
				return `${step.name} — notes`;
			case "rename":
				return `Rename ${step.name}`;
			case "delete":
				return `Remove ${step.name}?`;
		}
	})();

	const placeholder = (() => {
		switch (step.kind) {
			case "name":
				return "deepseek-work...";
			case "rename":
				return "New name...";
			case "notes":
				return "my second account...";
			case "newChrome":
				return "work...";
			default:
				return "Filter...";
		}
	})();

	const footer = (() => {
		switch (step.kind) {
			case "list":
				return "Enter opens · Esc discards unsaved changes";
			case "name":
				return "Enter creates · Esc goes back";
			case "notes":
				return "Enter saves (empty clears it) · Esc goes back";
			case "rename":
			case "newChrome":
				return "Enter confirms · Esc goes back";
			default:
				return "Enter selects · Esc goes back";
		}
	})();

	const hint = (() => {
		switch (step.kind) {
			case "name":
				return `How a worker in team.json refers to this profile. Enter on an empty box uses "${suggestedName(step)}".`;
			case "rename":
				return "Workers in team.json that name the old one will have to be pointed at the new name.";
			case "newChrome":
				return "A separate Chrome user-data-dir and debug port — a second logged-in account for every web provider.";
			case "chrome":
				return "Two workers on one provider need two logins here, or they share a browser and a chat.";
			default:
				return undefined;
		}
	})();

	return (
		<box flexDirection="column" gap={1}>
			<text>{heading}</text>
			{step.kind === "list" ? <text fg="gray">{storePath}</text> : null}
			{error ? <text fg="red">{error}</text> : null}

			<box border borderStyle="rounded" borderColor="gray" paddingX={1}>
				<input
					// Remounting per step clears the box, so a filter typed on one screen
					// does not silently hide rows on the next one.
					key={`${step.kind}-${"name" in step ? step.name : ""}`}
					onInput={isTextStep ? setDraft : list.setSearch}
					placeholder={placeholder}
					flexGrow={1}
					focused
				/>
			</box>

			{hint ? <text fg="gray">{hint}</text> : null}

			{isTextStep ? null : (
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
