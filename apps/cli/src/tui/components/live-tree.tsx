import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { useEffect, useRef, useState } from "react";

// Live Christmas tree: apps/cli/scripts/tree/tree_stream.py renders christmas_tree.py as
// braille frames at the panel's size and streams them as JSON lines on stdout.
const SCRIPT = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"scripts",
	"tree",
	"tree_stream.py",
);
const PYTHON =
	process.env.CLINE_TREE_PYTHON ??
	(process.platform === "win32" ? "python" : "python3");

/** Tree is drawn about 0.65 rows per column; keep that shape when fitting a space. */
export function fitTreeSize(maxCols: number, maxRows: number) {
	const cols = Math.min(maxCols, 72, Math.round(maxRows / 0.65));
	const rows = Math.min(maxRows, Math.round(cols * 0.65));
	return { cols, rows };
}

export function liveTreeAvailable(): boolean {
	return process.env.CLINE_NO_TREE !== "1" && existsSync(SCRIPT);
}

interface Segment {
	text: string;
	fg?: string;
}

interface StreamFrame {
	w: number;
	rows: string[];
	runs: (number | string | null)[];
}

function toSegments(frame: StreamFrame): Segment[][] {
	const colors: (string | undefined)[] = [];
	for (let i = 0; i + 1 < frame.runs.length; i += 2) {
		const color = (frame.runs[i + 1] as string | null) ?? undefined;
		for (let n = frame.runs[i] as number; n > 0; n--) colors.push(color);
	}
	return frame.rows.map((row, y) => {
		const segs: Segment[] = [];
		const chars = Array.from(row);
		for (let x = 0; x < chars.length; x++) {
			const fg = colors[y * frame.w + x];
			const last = segs[segs.length - 1];
			if (last && last.fg === fg) last.text += chars[x];
			else segs.push({ text: chars[x] ?? " ", fg });
		}
		return segs;
	});
}

/** Runs the Python renderer while enabled. `failed` turns true if Python is missing or crashes. */
export function useLiveTree(cols: number, rows: number, enabled: boolean) {
	const [lines, setLines] = useState<Segment[][] | null>(null);
	const [failed, setFailed] = useState(false);
	const childRef = useRef<ChildProcess | null>(null);
	const sizeRef = useRef({ cols, rows });
	sizeRef.current = { cols, rows };

	useEffect(() => {
		if (!enabled || failed) return;
		const { cols: c, rows: r } = sizeRef.current;
		let child: ChildProcess;
		try {
			child = spawn(PYTHON, ["-u", SCRIPT, String(c), String(r)], {
				stdio: ["pipe", "pipe", "ignore"],
				windowsHide: true,
				env: { ...process.env, PYTHONIOENCODING: "utf-8" },
			});
		} catch {
			setFailed(true);
			return;
		}
		childRef.current = child;
		let buffer = "";
		let gotFrame = false;
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			const end = buffer.lastIndexOf("\n");
			if (end < 0) return;
			// Only the newest complete frame matters; drop any backlog.
			const start = buffer.lastIndexOf("\n", end - 1) + 1;
			const line = buffer.slice(start, end);
			buffer = buffer.slice(end + 1);
			try {
				setLines(toSegments(JSON.parse(line) as StreamFrame));
				gotFrame = true;
			} catch {
				// partial or malformed line: wait for the next one
			}
		});
		child.on("error", () => setFailed(true));
		child.on("exit", () => {
			if (!gotFrame) setFailed(true);
		});
		const killChild = () => child.kill();
		process.once("exit", killChild);
		return () => {
			process.off("exit", killChild);
			child.stdin?.end();
			child.kill();
			childRef.current = null;
			setLines(null);
		};
	}, [enabled, failed]);

	useEffect(() => {
		childRef.current?.stdin?.write(`${cols} ${rows}\n`);
	}, [cols, rows]);

	return { lines, failed };
}

export function LiveTree(props: { lines: Segment[][] | null; cols: number }) {
	if (!props.lines) return null;
	return (
		<box flexDirection="column" width={props.cols} flexShrink={0}>
			{props.lines.map((segs, y) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed row order
				<text key={`tree-${y}`}>
					{segs.map((seg, j) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed segment order
						<span key={`tree-${y}-${j}`} fg={seg.fg}>
							{seg.text}
						</span>
					))}
				</text>
			))}
		</box>
	);
}
