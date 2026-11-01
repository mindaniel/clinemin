import { type BrowserProfile, browserProfileDisplayName } from "@cline/llms";
import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialogKeyboard } from "@opentui-ui/dialog/react";
import { useState } from "react";
import { palette } from "../../palette";

/**
 * Dialog content for `/profile`: pick which named Chrome profile the web
 * providers log in with.
 *
 * Enter (or click) selects the highlighted profile. `n` opens an inline name
 * field that creates a profile and selects it in one step. `e` renames the
 * highlighted profile and `a` names it after its signed-in email (both display
 * only: the Chrome directories stay keyed by the original name). `d` deletes
 * it: `y` also deletes its Chrome directories (the logins), `k` keeps them so
 * creating the same name later reuses them. `r` keeps the entry and deletes
 * the Chrome directories, signing that profile out of every web provider.
 * Escape dismisses without changing anything.
 */
export function ProfilePickerContent(
	props: ChoiceContext<string> & {
		profiles: BrowserProfile[];
		active: string;
		defaultProfileName: string;
		onDelete: (name: string) => void;
		onRename: (
			name: string,
			label: string | undefined | "auto",
		) => BrowserProfile;
	},
) {
	const {
		resolve,
		dismiss,
		dialogId,
		profiles: initialProfiles,
		active,
		defaultProfileName,
		onDelete,
		onRename,
	} = props;

	const [profiles, setProfiles] = useState(initialProfiles);
	const [selected, setSelected] = useState(() => {
		const index = initialProfiles.findIndex((entry) => entry.name === active);
		return index === -1 ? 0 : index;
	});
	const [creating, setCreating] = useState(false);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const [confirmReset, setConfirmReset] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const safeSelected = Math.min(selected, Math.max(profiles.length - 1, 0));
	const current = profiles[safeSelected];

	const applyRename = (name: string, label: string | undefined | "auto") => {
		try {
			const updated = onRename(name, label);
			setProfiles((prev) =>
				prev.map((entry) => (entry.name === name ? updated : entry)),
			);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	useDialogKeyboard((key) => {
		if (renaming) {
			// Same as the create field: typing belongs to the input.
			if (key.name === "escape") {
				setRenaming(null);
				setDraft("");
				return;
			}
			if (key.name === "return") {
				// An empty name goes back to the profile's own name.
				applyRename(renaming, draft.trim() || undefined);
				setRenaming(null);
				setDraft("");
			}
			return;
		}

		if (creating) {
			// The name field owns typing; only the two control keys are handled
			// here so a name containing "n" or "d" cannot trigger the shortcuts.
			if (key.name === "escape") {
				setCreating(false);
				setDraft("");
				setError(null);
				return;
			}
			if (key.name === "return") {
				if (!draft.trim()) {
					setError("Enter a name, or press Escape to cancel.");
					return;
				}
				resolve(`__create__:${draft.trim()}`);
			}
			return;
		}

		if (confirmReset) {
			if (key.name === "y") {
				resolve(`__reset__:${confirmReset}`);
				return;
			}
			setConfirmReset(null);
			return;
		}

		if (confirmDelete) {
			if (key.name === "y") {
				resolve(`__delete__:${confirmDelete}`);
				return;
			}
			if (key.name === "k") {
				try {
					onDelete(confirmDelete);
					setProfiles((prev) =>
						prev.filter((entry) => entry.name !== confirmDelete),
					);
					setSelected(0);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			}
			setConfirmDelete(null);
			return;
		}

		if (key.name === "escape") {
			dismiss();
			return;
		}
		if (key.name === "return") {
			if (current) resolve(current.name);
			return;
		}
		// Ctrl+N/Ctrl+P are the list-movement bindings used elsewhere, so they
		// must be taken before the bare `n`/`d` shortcuts below.
		if (key.ctrl && key.name === "n") {
			setSelected((prev) => (prev >= profiles.length - 1 ? 0 : prev + 1));
			return;
		}
		if (key.ctrl && key.name === "p") {
			setSelected((prev) => (prev <= 0 ? profiles.length - 1 : prev - 1));
			return;
		}
		if (key.name === "n") {
			setCreating(true);
			setDraft("");
			setError(null);
			return;
		}
		if (key.name === "e") {
			if (!current) return;
			setError(null);
			setDraft("");
			setRenaming(current.name);
			return;
		}
		if (key.name === "a") {
			if (!current) return;
			if (current.autoLabel && !current.label) {
				applyRename(current.name, undefined);
				return;
			}
			applyRename(current.name, "auto");
			if (!current.account) {
				setError(
					`No email known for ${current.name} yet: it takes the name once you /login or send a DeepSeek message on it.`,
				);
			}
			return;
		}
		if (key.name === "r") {
			if (!current) return;
			setError(null);
			setConfirmReset(current.name);
			return;
		}
		if (key.name === "d") {
			if (!current) return;
			if (current.name === defaultProfileName) {
				setError("The default profile cannot be deleted.");
				return;
			}
			setError(null);
			setConfirmDelete(current.name);
			return;
		}
		if (key.name === "up") {
			setSelected((prev) => (prev <= 0 ? profiles.length - 1 : prev - 1));
			return;
		}
		if (key.name === "down") {
			setSelected((prev) => (prev >= profiles.length - 1 ? 0 : prev + 1));
		}
	}, dialogId);

	return (
		<box flexDirection="column" gap={1}>
			<text>Browser profile for web providers</text>

			{renaming ? (
				<box flexDirection="column" gap={1}>
					<box border borderStyle="rounded" borderColor="gray" paddingX={1}>
						<input
							onInput={setDraft}
							placeholder={`New name for ${renaming} (empty = ${renaming})`}
							flexGrow={1}
							focused
						/>
					</box>
					<text fg="gray">
						<em>Enter to rename, Esc to cancel</em>
					</text>
				</box>
			) : creating ? (
				<box flexDirection="column" gap={1}>
					<box border borderStyle="rounded" borderColor="gray" paddingX={1}>
						<input
							onInput={setDraft}
							placeholder="New profile name (e.g. work)"
							flexGrow={1}
							focused
						/>
					</box>
					<text fg="gray">
						<em>Enter to create and switch, Esc to cancel</em>
					</text>
				</box>
			) : (
				<box flexDirection="column">
					{profiles.map((entry, index) => {
						const isSel = index === safeSelected;
						const isActive = entry.name === active;
						return (
							<box
								key={entry.name}
								paddingX={1}
								flexDirection="row"
								gap={1}
								height={1}
								overflow="hidden"
								backgroundColor={isSel ? palette.selection : undefined}
								onMouseDown={() => resolve(entry.name)}
							>
								<text
									fg={isSel ? palette.textOnSelection : "gray"}
									flexShrink={0}
								>
									{isSel ? "❯" : " "}
								</text>
								<text fg={isSel ? palette.textOnSelection : undefined}>
									{browserProfileDisplayName(entry)}
								</text>
								{entry.account &&
									entry.account !== browserProfileDisplayName(entry) && (
										<text fg={isSel ? palette.textOnSelection : "gray"}>
											{entry.account}
										</text>
									)}
								{entry.autoLabel && !entry.label && (
									<text fg={isSel ? palette.textOnSelection : "gray"}>
										(auto)
									</text>
								)}
								{isActive && (
									<text fg={isSel ? palette.textOnSelection : "green"}>
										(active)
									</text>
								)}
							</box>
						);
					})}
				</box>
			)}

			{confirmReset && (
				<box
					border
					borderStyle="rounded"
					borderColor="red"
					paddingX={1}
					flexDirection="column"
				>
					<text fg="red">
						Sign profile {confirmReset} out of every web provider? (y/n)
					</text>
					<text fg="gray">
						This permanently deletes its Chrome directories — cookies, logins,
						all of them. You will have to sign in again in each browser window.
					</text>
				</box>
			)}

			{confirmDelete && (
				<box
					border
					borderStyle="rounded"
					borderColor="red"
					paddingX={1}
					flexDirection="column"
				>
					<text fg="red">Delete profile {confirmDelete}?</text>
					<text fg="gray">
						y = delete it and its browser logins, k = remove from the list but
						keep the logins, any other key = cancel
					</text>
				</box>
			)}

			{error && <text fg="red">{error}</text>}

			{!creating && !renaming && (
				<text fg="gray" marginTop={1}>
					<em>
						Enter to switch, n new, e rename, a auto-name from email, d delete,
						r sign out, Esc cancel
					</em>
				</text>
			)}
		</box>
	);
}
