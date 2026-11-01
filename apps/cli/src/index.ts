#!/usr/bin/env bun

// Swap in a staged source update before anything else loads, so no module
// the swap replaces is already in memory (see commands/source-update-apply).
// Same for a stale SDK build: loading it would crash on a missing export.
import {
	applyStagedUpdateAtLaunch,
	rebuildStaleSdkAtLaunch,
} from "./commands/source-update-apply";

applyStagedUpdateAtLaunch();
rebuildStaleSdkAtLaunch();
await import("./cli-entry");
