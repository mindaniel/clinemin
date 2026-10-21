#!/usr/bin/env bun

// Swap in a staged source update before anything else loads, so no module
// the swap replaces is already in memory (see commands/source-update-apply).
import { applyStagedUpdateAtLaunch } from "./commands/source-update-apply";

applyStagedUpdateAtLaunch();
await import("./cli-entry");
