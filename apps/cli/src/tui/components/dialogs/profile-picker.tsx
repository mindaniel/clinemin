import type { BrowserProfile } from "@cline/llms";
import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialogKeyboard } from "@opentui-ui/dialog/react";
import { useState } from "react";
import { palette } from "../../palette";

/**
 * Dialog content for `/profile`: pick which named Chrome profile the web
 * providers log in with.
 *
 * Enter (or click) selects the highlighted profile. `n` opens an inline name
 * field that creates a profile and selects it in one step. `d` deletes the
 * highlighted profile (list entry only — the on-disk Chrome directory, and so
 * the login, is kept). Escape dismisses without changing anything.
 */
export function ProfilePickerContent(
	props: ChoiceContext<string> & {
		profiles: BrowserProfile[];
		active: string;
		defaultProfileName: string;
		onDelete: (name: string) => void;
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
	} = props;

	const [profiles, setProfiles] = useState(initialProfiles);
	const [selected, setSelected] = useState(() => {
		const index = initialProfiles.findIndex((entry) => entry.name === active);
		return index === -1 ? 0 : index;
	});
	const [creating, setCreating] = useState(false);
	const [draft, setDraft] = useState("");
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const safeSelected = Math.min(selected, Math.max(profiles.length - 1, 0));
	const current = profiles[safeSelected];

	useDialogKeyboard((key) => {
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

		if (confirmDelete) {
			if (key.name === "y") {
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

			{creating ? (
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
									{entry.name}
								</text>
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

			{confirmDelete && (
				<box border borderStyle="rounded" borderColor="red" paddingX={1}>
					<text fg="red">
						Forget profile {confirmDelete}? Its browser logins stay on disk.
						(y/n)
					</text>
				</box>
			)}

			{error && <text fg="red">{error}</text>}

			{!creating && (
				<text fg="gray" marginTop={1}>
					<em>Enter to switch, n for new, d to forget, Esc to cancel</em>
				</text>
			)}
		</box>
	);
}
