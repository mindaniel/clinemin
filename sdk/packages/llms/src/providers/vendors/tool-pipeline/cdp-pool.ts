/**
 * One live CDP connection per debug port, shared by every session in the process.
 *
 * Each browser vendor used to keep a single `activeCdp` / `activeCdpKey` pair at
 * module scope: one connection, plus the port it belongs to. Connecting to a
 * different port closed the cached one first, on the assumption that a changed
 * port means `/profile` switched and the old socket is garbage.
 *
 * That assumption holds for one user switching profiles in sequence. It is
 * false in the hub daemon, which runs the turns of every terminal at once. Two
 * sessions on two profiles resolve two ports, so each turn saw a "different"
 * key and closed the other session's socket before opening its own — then the
 * next turn closed it back. Two profiles fighting over one slot.
 *
 * A map keyed by port has no such conflict: both connections are live at once
 * and neither turn touches the other's. The pool is on `globalThis` for the
 * usual reason (two copies of `@cline/llms` in one process, see
 * `process-global.ts`).
 *
 * This caches the SOCKET, not the browser. Chrome itself is tracked separately
 * by `browser-processes.ts` and `browser-claims.ts`, which decide who may close
 * it; dropping a connection here never kills a browser.
 */

import { processGlobal } from "./process-global";

/** The part of a CDP client this pool needs. Kept structural to avoid a cycle. */
export interface PooledCdpClient {
	isOpen(): boolean;
	close(): void;
}

/**
 * Keyed by `<providerId>:<port>`. The port alone would be enough in practice —
 * each provider has its own stock port — but a provider whose port was pinned
 * in config.json can collide with another's, and handing one vendor another
 * vendor's socket would be a confusing failure rather than a loud one.
 */
const pool = () =>
	processGlobal("cdpPool", () => new Map<string, PooledCdpClient>());

function poolKey(providerId: string, port: number): string {
	return `${providerId}:${port}`;
}

/** The open connection for this provider/port, or undefined. */
export function getPooledCdp<T extends PooledCdpClient>(
	providerId: string,
	port: number,
): T | undefined {
	const key = poolKey(providerId, port);
	const cached = pool().get(key);
	if (!cached) return undefined;
	if (cached.isOpen()) return cached as T;
	// Closed on the far end (browser quit, port recycled). Forget it so the
	// caller reconnects rather than handing a dead socket to the next turn.
	pool().delete(key);
	return undefined;
}

/** Remember a freshly opened connection. */
export function setPooledCdp(
	providerId: string,
	port: number,
	cdp: PooledCdpClient,
): void {
	pool().set(poolKey(providerId, port), cdp);
}

/**
 * Close and forget one connection.
 *
 * Only ever called for the port the caller is itself working on. Closing a port
 * a different session is driving is exactly the bug this module exists to stop.
 */
export function dropPooledCdp(providerId: string, port: number): void {
	const key = poolKey(providerId, port);
	const cached = pool().get(key);
	pool().delete(key);
	if (!cached) return;
	try {
		cached.close();
	} catch {
		// Already gone; nothing to release.
	}
}
