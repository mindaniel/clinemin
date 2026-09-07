import type { BasicLogger, ITelemetryService } from "@cline/shared";
import type { CronServiceOptions } from "../../cron/service/cron-service";
import type {
	HubScheduleRuntimeHandlers,
	HubScheduleServiceOptions,
} from "../../cron/service/schedule-service";
import type {
	PendingPromptsRuntimeService,
	RuntimeHost,
} from "../../runtime/host/runtime-host";
import type { CoreSettingsService } from "../../settings";
import type { HubOwnerContext } from "../discovery";

export interface HubWebSocketServerOptions {
	host?: string;
	port?: number;
	pathname?: string;
	owner?: HubOwnerContext;
	sessionHost?: RuntimeHost & Partial<PendingPromptsRuntimeService>;
	settingsService?: CoreSettingsService;
	runtimeHandlers: HubScheduleRuntimeHandlers;
	scheduleOptions?: Omit<HubScheduleServiceOptions, "runtimeHandlers">;
	/**
	 * File-based cron automation options. When provided, the hub starts a
	 * `CronService` that watches global `~/.cline/cron/` by default, reconciles
	 * specs into `cron.db`, and executes queued runs through `runtimeHandlers`.
	 * Pass `cronOptions.specs` to use a different source, including future
	 * workspace-scoped specs.
	 */
	cronOptions?: Omit<CronServiceOptions, "runtimeHandlers">;
	/**
	 * Shut the hub down once nothing is using it.
	 *
	 * The daemon outlives the CLI that spawned it, which is what lets a
	 * background session keep running after you close the terminal. The cost is
	 * that it also outlives a rebuild: `bun run build:sdk` compiles new code
	 * while the running daemon keeps serving the modules it loaded at startup,
	 * so the next run silently tests the old build.
	 *
	 * With this set, the hub exits once its last client disconnects and no
	 * session is still running — so closing the terminal is enough, and the next
	 * run starts a daemon on the new build. A session that is still working
	 * keeps it alive, so detached sessions are unaffected.
	 *
	 * Milliseconds to wait after the last disconnect. Omit or 0 to stay up
	 * forever, which is what an explicitly started hub does.
	 */
	idleShutdownMs?: number;
	/**
	 * Called when `idleShutdownMs` elapses with nothing left to serve. The
	 * server does not exit the process itself — the daemon entry point owns
	 * that, so it can flush telemetry first.
	 */
	onIdle?: () => void;
	/**
	 * Custom `fetch` implementation forwarded to the internally-constructed
	 * `LocalRuntimeHost` that executes incoming `session.create` traffic.
	 * Used by the AI gateway providers for every session that runs inside
	 * this hub process.
	 *
	 * Ignored when `sessionHost` is supplied — in that case the caller owns
	 * runtime construction and is responsible for wiring its own fetch.
	 */
	fetch?: typeof fetch;
	/**
	 * Telemetry forwarded to the internally-constructed `LocalRuntimeHost`.
	 * Ignored when `sessionHost` is supplied.
	 */
	telemetry?: ITelemetryService;
	/**
	 * Structured logger forwarded to the internally-constructed local runtime.
	 * Ignored when `sessionHost` is supplied.
	 */
	logger?: BasicLogger;
}

export interface HubWebSocketServer {
	host: string;
	port: number;
	url: string;
	authToken: string;
	close(): Promise<void>;
}

export interface EnsureHubWebSocketServerOptions
	extends HubWebSocketServerOptions {
	allowPortFallback?: boolean;
}

export interface EnsuredHubWebSocketServerResult {
	server?: HubWebSocketServer;
	url: string;
	authToken?: string;
	action: "reuse" | "started";
}
