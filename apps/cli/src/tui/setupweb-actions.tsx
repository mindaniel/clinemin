import { statSync } from "node:fs";
import { disableConnectorAutostart } from "@cline/core";
import type { ChoiceContext } from "@opentui-ui/dialog";
import type { useDialog } from "@opentui-ui/dialog/react";
import QRCode from "qrcode";
import { runConnectAdapter, runStopConnector } from "../commands/connect";
import { githubConnector } from "../connectors/adapters/github";
import {
	readSavedConfig,
	saveConfig,
	statePath,
} from "../connectors/github/config";
import { generateVapid } from "../connectors/github/push";
import {
	PHONE_APP_URL,
	SetupWebDialogContent,
	type SetupWebResult,
} from "./components/dialogs/setupweb-dialog";

/**
 * `/setupweb`: set up, start, stop and show the phone app's bridge.
 * The dialog asks; this does the saving and starting, and reports in the
 * chat (status lines), ending with the phone link and a QR code.
 */

type Entry = { kind: "status" | "error"; text: string };

export interface SetupWebDeps {
	dialog: ReturnType<typeof useDialog>;
	termHeight: number;
	refocusTextarea: () => void;
	appendEntry: (entry: Entry) => void;
}

/** The standalone bridge from the minh-mobile repo writes its state every few seconds while it runs. */
function oldBridgeLooksAlive(): boolean {
	try {
		return Date.now() - statSync(statePath()).mtimeMs < 20_000;
	} catch {
		return false;
	}
}

async function phoneMessage(repo: string): Promise<string> {
	let qr = "";
	try {
		qr = await QRCode.toString(PHONE_APP_URL, { type: "utf8", margin: 2 });
	} catch {}
	return [
		"/setupweb: on your phone:",
		`  1. Open ${PHONE_APP_URL} (or scan the code below).`,
		`  2. Enter the repo ${repo} and the same token you pasted here.`,
		"  3. Add it to your home screen: Android Chrome menu > Add to Home screen; iPhone Safari Share > Add to Home Screen.",
		"  4. In the app's menu, tap Turn on notifications.",
		...(qr ? ["", qr.trimEnd()] : []),
	].join("\n");
}

export async function openSetupWeb(deps: SetupWebDeps): Promise<boolean> {
	const saved = readSavedConfig();
	const running = githubConnector.running();
	const result = await deps.dialog.choice<SetupWebResult | null>({
		size: "large",
		style: { maxHeight: deps.termHeight - 2 },
		content: (ctx: ChoiceContext<SetupWebResult | null>) => (
			<SetupWebDialogContent
				{...ctx}
				initial={{
					repo: saved?.repo,
					cwd: saved?.cwd,
					autoApprove: saved?.autoApproveTools,
					hasToken: Boolean(saved?.token),
					running: Boolean(running),
					runningRepo: running?.repo,
				}}
			/>
		),
	});
	deps.refocusTextarea();
	if (!result) return true;

	const say = (text: string) => deps.appendEntry({ kind: "status", text });
	const io = {
		writeln: (text?: string) => {
			if (text) say(text);
		},
		writeErr: (text?: string) => {
			if (text) deps.appendEntry({ kind: "error", text });
		},
	};

	try {
		if (result.action === "phone") {
			say(await phoneMessage(saved?.repo ?? "your-name/minh-chat"));
			return true;
		}
		if (result.action === "stop") {
			await runStopConnector("github", io);
			say(
				"/setupweb: bridge stopped. Messages from the phone wait in the repo until it starts again.",
			);
			return true;
		}

		if (result.action === "save") {
			const previous = saved ?? {};
			saveConfig({
				...previous,
				repo: result.repo,
				...(result.token ? { token: result.token } : {}),
				// Whoever owns the token is the one chatting; a wrong answer here
				// is what left a first setup ignoring every message.
				allowedUsers: result.login
					? [result.login.toLowerCase()]
					: (previous.allowedUsers ?? []),
				cwd: result.cwd,
				autoApproveTools: result.autoApprove,
				pollSeconds: previous.pollSeconds ?? 3,
				vapid:
					previous.vapid ??
					generateVapid(
						`https://github.com/${result.login || result.repo.split("/")[0]}`,
					),
			});
			say(
				`/setupweb: saved (repo ${result.repo}, folder ${result.cwd}). The token is sealed for this Windows account.`,
			);
		}

		// Both bridges keep their progress in the same state file, which the
		// standalone one touches every few seconds: fresh and not ours means it runs.
		const oldBridge = !githubConnector.running() && oldBridgeLooksAlive();

		// Start, or restart so it picks up new settings.
		if (githubConnector.running())
			await runStopConnector("github", io, { autostart: "preserve" });
		const code = await runConnectAdapter("github", [], io);
		if (code !== 0) return true;
		if (result.action === "save" && !result.autostart)
			disableConnectorAutostart("github");
		say(
			"/setupweb: bridge running in the background. Run /setupweb again to stop or restart it.",
		);
		if (oldBridge) {
			deps.appendEntry({
				kind: "error",
				text: "/setupweb: a bridge started from the minh-mobile folder (bun run bridge) is running too. Close that window (Ctrl+C), or chats get answered twice.",
			});
		}
		if (result.action === "save") say(await phoneMessage(result.repo));
	} catch (error) {
		deps.appendEntry({
			kind: "error",
			text: `/setupweb: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
	return true;
}
