import { homedir } from "node:os";
import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialogKeyboard } from "@opentui-ui/dialog/react";
import open from "open";
import { useState } from "react";
import { GitHub, GitHubError } from "../../../connectors/github/github";
import { palette } from "../../palette";
import { copyTextToSystemClipboard } from "../../utils/clipboard";

/**
 * `/setupweb`: a step-by-step box that sets up the phone app. Each step says
 * what to do on github.com, opens (or copies) the right page with the form
 * already filled in, and checks the answer before moving on. Nothing is
 * saved until the last step.
 */

export const PHONE_APP_URL = "https://mindaniel.github.io/minh-mobile/";

export interface SetupWebInitial {
	repo?: string;
	cwd?: string;
	autoApprove?: boolean;
	hasToken: boolean;
	running: boolean;
	runningRepo?: string;
}

export type SetupWebResult =
	| {
			action: "save";
			repo: string;
			/** Empty: keep the saved one. */
			token: string;
			login: string;
			cwd: string;
			autoApprove: boolean;
			autostart: boolean;
	  }
	| { action: "start" | "stop" | "phone" };

type Step = "home" | "repo" | "token" | "settings";
type Focus =
	| "open"
	| "copy"
	| "input"
	| "input2"
	| "toggle1"
	| "toggle2"
	| "next";

const REPO_URL =
	"https://github.com/new?name=minh-chat&visibility=private&description=Chats%20with%20minh%20from%20my%20phone";

function tokenUrl(): string {
	const params = new URLSearchParams({
		name: "minh-chat",
		description: "minh phone app and bridge",
		expires_in: "none",
		issues: "write",
		contents: "write",
	});
	return `https://github.com/settings/personal-access-tokens/new?${params}`;
}

export function SetupWebDialogContent(
	props: ChoiceContext<SetupWebResult | null> & { initial: SetupWebInitial },
) {
	const { resolve, dismiss, dialogId, initial } = props;
	const configured = Boolean(initial.repo && initial.hasToken);
	const [step, setStep] = useState<Step>(configured ? "home" : "repo");
	const [focus, setFocus] = useState<Focus>("open");
	const [homeIndex, setHomeIndex] = useState(0);
	const [repo, setRepo] = useState(initial.repo ?? "");
	const [token, setToken] = useState("");
	const [login, setLogin] = useState("");
	const [cwd, setCwd] = useState(initial.cwd ?? homedir());
	const [autoApprove, setAutoApprove] = useState(initial.autoApprove ?? true);
	const [autostart, setAutostart] = useState(true);
	const [note, setNote] = useState<{ text: string; error?: boolean } | null>(
		null,
	);
	const [busy, setBusy] = useState(false);

	const homeItems: Array<{ label: string; run: () => void }> = [
		{
			label: initial.running ? "Restart the bridge" : "Start the bridge",
			run: () => resolve({ action: "start" }),
		},
		...(initial.running
			? [{ label: "Stop the bridge", run: () => resolve({ action: "stop" }) }]
			: []),
		{
			label: "Show the phone link and QR code",
			run: () => resolve({ action: "phone" }),
		},
		{
			label: "Set up again (repo, token, folder)",
			run: () => {
				setStep("repo");
				setFocus("input");
			},
		},
	];

	const focusOrder: Record<Step, Focus[]> = {
		home: [],
		repo: ["open", "copy", "input", "next"],
		token: ["open", "copy", "input", "next"],
		settings: ["input", "toggle1", "toggle2", "next"],
	};

	async function openUrl(url: string) {
		try {
			await open(url);
			setNote({ text: "Opened in your browser." });
		} catch {
			setNote({
				text: `Could not open a browser. Copy the link instead: ${url}`,
				error: true,
			});
		}
	}

	async function copyUrl(url: string) {
		const ok = await copyTextToSystemClipboard(url).catch(() => false);
		setNote(
			ok
				? { text: "Link copied. Paste it into your browser." }
				: { text: `Copy this link: ${url}`, error: true },
		);
	}

	function goto(next: Step) {
		setNote(null);
		setStep(next);
		setFocus(next === "settings" ? "input" : "open");
	}

	function nextFromRepo() {
		const value = repo
			.trim()
			.replace(/^https:\/\/github\.com\//, "")
			.replace(/\/+$/, "");
		if (!/^[\w.-]+\/[\w.-]+$/.test(value)) {
			setNote({
				text: 'Type the repo as owner/name, for example "your-name/minh-chat".',
				error: true,
			});
			setFocus("input");
			return;
		}
		setRepo(value);
		goto("token");
	}

	async function nextFromToken() {
		const entered = token.replace(/\s+/g, "");
		if (!entered && !initial.hasToken) {
			setNote({ text: "Paste the token first.", error: true });
			setFocus("input");
			return;
		}
		if (!entered) {
			// Keeping the saved token: it was checked when it was saved.
			goto("settings");
			return;
		}
		setBusy(true);
		setNote({ text: "Checking the token with GitHub…" });
		try {
			const github = new GitHub(entered, repo);
			const me = await github.whoAmI();
			try {
				await github.getRepo();
			} catch (error) {
				if (!(error instanceof GitHubError) || error.status !== 404)
					throw error;
				if (!(await github.acceptInvitation().catch(() => false))) {
					throw new Error(
						`The token (${me.login}) cannot see ${repo}. Edit the token on github.com and add ${repo} under "Only select repositories".`,
					);
				}
			}
			setLogin(me.login);
			setNote({ text: `Token belongs to ${me.login} and can see ${repo}.` });
			setStep("settings");
			setFocus("input");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setNote({
				text: /401|Bad credentials/i.test(message)
					? "GitHub rejected that token. Copy it again with the copy button next to it."
					: message,
				error: true,
			});
			setFocus("input");
		} finally {
			setBusy(false);
		}
	}

	function finish() {
		if (!cwd.trim()) {
			setNote({ text: "Pick a folder for chats to work in.", error: true });
			setFocus("input");
			return;
		}
		resolve({
			action: "save",
			repo,
			token: token.replace(/\s+/g, ""),
			login,
			cwd: cwd.trim(),
			autoApprove,
			autostart,
		});
	}

	function press(target: Focus) {
		if (busy) return;
		const url = step === "repo" ? REPO_URL : tokenUrl();
		if (target === "open") void openUrl(url);
		else if (target === "copy") void copyUrl(url);
		else if (target === "toggle1") setAutoApprove((value) => !value);
		else if (target === "toggle2") setAutostart((value) => !value);
		else if (target === "next" || target === "input") {
			if (step === "repo") nextFromRepo();
			else if (step === "token") void nextFromToken();
			else finish();
		}
	}

	useDialogKeyboard((key) => {
		if (key.name === "escape") {
			dismiss();
			return;
		}
		if (step === "home") {
			if (key.name === "up")
				setHomeIndex((i) => (i - 1 + homeItems.length) % homeItems.length);
			else if (key.name === "down" || key.name === "tab")
				setHomeIndex((i) => (i + 1) % homeItems.length);
			else if (key.name === "return") homeItems[homeIndex]?.run();
			return;
		}
		if (
			key.name === "tab" ||
			(focus !== "input" && (key.name === "down" || key.name === "up"))
		) {
			const order = focusOrder[step];
			const back = key.shift || key.name === "up";
			setFocus((current) => {
				const index = order.indexOf(current);
				return (
					order[(index + (back ? -1 : 1) + order.length) % order.length] ??
					current
				);
			});
			return;
		}
		if (key.name === "return") {
			press(focus);
			return;
		}
		if (key.name === "space" && (focus === "toggle1" || focus === "toggle2")) {
			press(focus);
		}
	}, dialogId);

	const button = (target: Focus, label: string) => (
		<box
			paddingX={1}
			backgroundColor={focus === target ? palette.selection : undefined}
			onMouseDown={() => {
				setFocus(target);
				press(target);
			}}
		>
			<text fg={focus === target ? palette.textOnSelection : undefined}>
				{label}
			</text>
		</box>
	);

	const field = (
		target: Focus,
		value: string,
		onInput: (v: string) => void,
		placeholder: string,
	) => (
		<box
			border
			borderStyle="rounded"
			borderColor={focus === target ? palette.selection : palette.muted}
			paddingX={1}
			onMouseDown={() => setFocus(target)}
		>
			<input
				value={value}
				onInput={onInput}
				placeholder={placeholder}
				flexGrow={1}
				focused={focus === target}
			/>
		</box>
	);

	const stepLabel = {
		home: "",
		repo: "Step 1 of 3",
		token: "Step 2 of 3",
		settings: "Step 3 of 3",
	}[step];

	return (
		<box flexDirection="column" paddingX={1} gap={1}>
			<text>
				Phone app setup
				{stepLabel ? <span fg={palette.muted}> — {stepLabel}</span> : null}
			</text>

			{step === "home" ? (
				<box flexDirection="column" gap={0}>
					<text fg={palette.muted}>
						Chats go through {initial.repo}. The bridge is{" "}
						{initial.running
							? `running (${initial.runningRepo ?? initial.repo}).`
							: "stopped."}
					</text>
					<text fg={palette.muted}>Phone app: {PHONE_APP_URL}</text>
					<box flexDirection="column" marginTop={1}>
						{homeItems.map((item, index) => (
							<box
								key={item.label}
								paddingX={1}
								backgroundColor={
									homeIndex === index ? palette.selection : undefined
								}
								onMouseDown={() => item.run()}
							>
								<text
									fg={homeIndex === index ? palette.textOnSelection : undefined}
								>
									{item.label}
								</text>
							</box>
						))}
					</box>
				</box>
			) : null}

			{step === "repo" ? (
				<box flexDirection="column" gap={1}>
					<text fg={palette.muted}>
						Your chats live as issues in a private GitHub repo. Make one on
						github.com: the link fills in the name minh-chat and Private, so
						just press "Create repository". Already have one? Skip to the box
						below.
					</text>
					<box flexDirection="row" gap={2}>
						{button("open", "Open in browser")}
						{button("copy", "Copy link")}
					</box>
					<box flexDirection="column">
						<text fg={palette.muted}>The repo, as owner/name</text>
						{field("input", repo, setRepo, "your-name/minh-chat")}
					</box>
					{button("next", "Next →")}
				</box>
			) : null}

			{step === "token" ? (
				<box flexDirection="column" gap={1}>
					<text fg={palette.muted}>
						Now a token, so the bridge and your phone can read and write that
						repo. The link fills in the name and the Issues and Contents
						permissions. On the page:
					</text>
					<text fg={palette.muted}>
						{"  "}1. Repository access: "Only select repositories", then pick{" "}
						{repo || "your repo"}.{"\n"}
						{"  "}2. Press "Generate token", then the copy button next to it.
						{"\n"}
						{"  "}3. Paste it below. Keep it for your phone too; GitHub shows it
						once.
					</text>
					<box flexDirection="row" gap={2}>
						{button("open", "Open in browser")}
						{button("copy", "Copy link")}
					</box>
					<box flexDirection="column">
						<text fg={palette.muted}>
							Token
							{initial.hasToken
								? " — one is saved; leave empty to keep it"
								: ""}
						</text>
						{field("input", token, setToken, "github_pat_…")}
					</box>
					{button("next", busy ? "Checking…" : "Check and continue →")}
				</box>
			) : null}

			{step === "settings" ? (
				<box flexDirection="column" gap={1}>
					<box flexDirection="column">
						<text fg={palette.muted}>
							Folder new chats work in (the phone can pick others later). A
							project folder is safer than your whole home folder: chats can
							read what is in it.
						</text>
						{field("input", cwd, setCwd, homedir())}
					</box>
					{button(
						"toggle1",
						`${autoApprove ? "[x]" : "[ ]"} Let tools run without asking (off: approve each on the phone)`,
					)}
					{button(
						"toggle2",
						`${autostart ? "[x]" : "[ ]"} Start the bridge by itself when minh starts`,
					)}
					{button("next", "Save and start the bridge")}
				</box>
			) : null}

			{note ? (
				<text fg={note.error ? palette.error : palette.muted}>{note.text}</text>
			) : null}

			<text fg={palette.muted}>
				<em>
					{step === "home"
						? "↑↓ to choose, Enter to pick, Esc to close"
						: "Tab to move, Enter to press, Space to tick, Esc to cancel (nothing is saved until the end)"}
				</em>
			</text>
		</box>
	);
}
