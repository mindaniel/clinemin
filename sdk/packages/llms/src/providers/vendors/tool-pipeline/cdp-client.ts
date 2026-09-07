/**
 * The Chrome DevTools Protocol socket every web vendor drives its browser with.
 *
 * This existed six times — in chatgpt-web, claude-web, gemini-web, grok-web,
 * kimi-web and qwen-web — at about 250 lines each including the three connect
 * helpers below. Five of the six copies were byte-identical apart from the
 * provider name passed to `retryOnMissingExecutionContext`. The sixth,
 * chatgpt-web, had gained a per-call timeout parameter that the other five
 * never got, which is exactly how copy-paste rots: a fix lands in one file and
 * nobody knows the other five need it.
 *
 * The chatgpt-web version is the one kept, because its default is the same
 * 30000ms the others hardcoded — so adopting it changes no behaviour and hands
 * every vendor the knob.
 *
 * The provider name is a constructor argument rather than a module constant:
 * it only ever appears in a log line, and a shared client that logged the wrong
 * provider would be worse than one that logged none.
 */

import { retryOnMissingExecutionContext } from "./cdp-execution-context";

/** How long one CDP call may take before it is abandoned. */
export const CDP_CALL_TIMEOUT_MS = 30000;

/** How long the websocket has to come up before the connection is abandoned. */
const CDP_OPEN_TIMEOUT_MS = 8000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class CdpClient {
	private ws: WebSocket;
	private id = 0;
	private pending = new Map<
		number,
		{ resolve: (value: any) => void; reject: (reason: any) => void }
	>();
	private listeners = new Map<
		string,
		Set<(params: any, sessionId?: string) => void>
	>();

	constructor(
		wsUrl: string,
		/** Provider id, used only to attribute a retry in the log. */
		private readonly providerId: string,
	) {
		this.ws = new WebSocket(wsUrl);
		this.ws.addEventListener("message", (event: any) => {
			try {
				const data = event.data;
				const msg = JSON.parse(data.toString());
				if (msg.id !== undefined && this.pending.has(msg.id)) {
					const { resolve, reject } = this.pending.get(msg.id)!;
					this.pending.delete(msg.id);
					if (msg.error) reject(new Error(msg.error.message));
					else resolve(msg.result);
				} else if (msg.method) {
					const cbs = this.listeners.get(msg.method);
					if (cbs) {
						for (const cb of cbs) {
							try {
								cb(msg.params, msg.sessionId);
							} catch {
								/* ignore */
							}
						}
					}
				}
			} catch {
				/* ignore */
			}
		});
	}

	waitOpen(): Promise<void> {
		return new Promise((resolve, reject) => {
			const t = setTimeout(
				() => reject(new Error("CDP websocket timeout")),
				CDP_OPEN_TIMEOUT_MS,
			);
			const onOpen = () => {
				clearTimeout(t);
				resolve();
			};
			const onError = () => {
				clearTimeout(t);
				reject(new Error("CDP websocket error"));
			};
			this.ws.addEventListener("open", onOpen);
			this.ws.addEventListener("error", onError);
		});
	}

	// Wrapped so a page that is mid-navigation — no execution context yet —
	// waits the moment out instead of failing the turn with nothing typed.
	// See tool-pipeline/cdp-execution-context.ts.
	send(
		method: string,
		params: any = {},
		sessionId?: string,
		timeoutMs?: number,
	): Promise<any> {
		return retryOnMissingExecutionContext(
			method,
			() => this.sendOnce(method, params, sessionId, timeoutMs),
			sleep,
			this.providerId,
		);
	}

	private sendOnce(
		method: string,
		params: any = {},
		sessionId?: string,
		timeoutMs: number = CDP_CALL_TIMEOUT_MS,
	): Promise<any> {
		const id = ++this.id;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(
				JSON.stringify({
					id,
					method,
					params,
					...(sessionId ? { sessionId } : {}),
				}),
			);
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`CDP timeout: ${method}`));
				}
			}, timeoutMs);
		});
	}

	on(method: string, cb: (params: any, sessionId?: string) => void): void {
		if (!this.listeners.has(method)) this.listeners.set(method, new Set());
		this.listeners.get(method)?.add(cb);
	}

	off(method: string, cb: (params: any, sessionId?: string) => void): void {
		this.listeners.get(method)?.delete(cb);
	}

	isOpen(): boolean {
		return this.ws.readyState === WebSocket.OPEN;
	}

	close(): void {
		this.ws.close();
	}
}

export async function isEndpointUp(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
			signal: AbortSignal.timeout(2000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

export async function connectCdp(
	port: number,
	timeoutMs: number,
	providerId: string,
): Promise<CdpClient> {
	const endpoint = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const version = (await (
				await fetch(`${endpoint}/json/version`)
			).json()) as { webSocketDebuggerUrl: string };
			const cdp = new CdpClient(version.webSocketDebuggerUrl, providerId);
			await cdp.waitOpen();
			return cdp;
		} catch (err) {
			lastError = err;
			await sleep(750);
		}
	}
	const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
	throw new Error(
		`Could not connect to Chrome DevTools at ${endpoint} within ${Math.round(timeoutMs / 1000)}s${detail}`,
	);
}

export async function waitForEndpoint(
	port: number,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			if (await isEndpointUp(port)) {
				return;
			}
		} catch (err) {
			lastError = err;
		}
		await sleep(500);
	}
	const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
	throw new Error(
		`Chrome DevTools endpoint at port ${port} did not become available within ${Math.round(timeoutMs / 1000)}s${detail}`,
	);
}
