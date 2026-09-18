import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialogKeyboard } from "@opentui-ui/dialog/react";

/**
 * Confirm for `/manager off`.
 *
 * Leaving manager mode rebuilds the system prompt, and a system prompt is
 * fixed for the life of a session — so the session restarts and the
 * conversation goes with it. That is the whole reason this asks first.
 */
export function ManagerOffConfirmContent(ctx: ChoiceContext<boolean>) {
	useDialogKeyboard((key) => {
		if (key.name === "return" || key.name === "y") {
			ctx.resolve(true);
		} else if (key.name === "escape" || key.name === "n") {
			ctx.dismiss();
		}
	}, ctx.dialogId);

	return (
		<box flexDirection="column" paddingX={1}>
			<text>Turn manager mode off?</text>
			<text fg="gray" marginTop={1}>
				This session goes back to doing the work itself. The system prompt is
				rebuilt, which restarts the session and clears this conversation.
			</text>
			<text fg="gray" marginTop={1}>
				<em>Y/Enter to confirm, N/Esc to cancel</em>
			</text>
		</box>
	);
}
