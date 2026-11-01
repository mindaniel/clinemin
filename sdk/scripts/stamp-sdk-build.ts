import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// Runs at the end of "build:sdk": records the commit dist/ was built from, so
// the CLI can tell at launch that a `git pull` left the build behind (see
// apps/cli/src/commands/source-update-apply.ts). Kept in a dist/ so a staged
// update's copy of dist/ carries it along.
const repoRoot = path.resolve(import.meta.dir, "..", "..");
const stampFile = path.join(
	repoRoot,
	"sdk",
	"packages",
	"shared",
	"dist",
	".source-commit",
);

try {
	const commit = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repoRoot,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
	fs.writeFileSync(stampFile, commit);
} catch {
	// Not a git checkout (a published tarball): nothing to compare against.
}
