/**
 * Reading Gemini's response stream.
 *
 * Gemini returns length-prefixed JSON (each line starts with "[").
 * Assistant text lives in arrays whose first element is an "rc_"
 * string; the following element holds the list of text parts.
 */

// ── SSE parser for Gemini ──────────────────────────────────────────────────────

export function consumeGeminiSse(
	body: string,
	onChunk: (text: string) => void,
	onDone: () => void,
	onError: (err: Error) => void,
): void {
	try {
		const extractText = (obj: any): string | null => {
			if (typeof obj === "string") {
				const s = obj.trim();
				if (s.startsWith("[") || s.startsWith("{")) {
					try {
						return extractText(JSON.parse(s));
					} catch {
						return null;
					}
				}
				return null;
			}
			if (Array.isArray(obj)) {
				if (
					obj.length > 1 &&
					typeof obj[0] === "string" &&
					obj[0].startsWith("rc_") &&
					Array.isArray(obj[1])
				) {
					const parts = obj[1].filter((p: unknown) => typeof p === "string");
					if (parts.length) return parts.join("");
				}
				for (const item of obj) {
					const t = extractText(item);
					if (t) return t;
				}
				return null;
			}
			if (obj && typeof obj === "object") {
				for (const value of Object.values(obj)) {
					const t = extractText(value);
					if (t) return t;
				}
			}
			return null;
		};

		let bestText = "";
		for (const rawLine of body.split("\n")) {
			const line = rawLine.trim();
			if (!line || !line.startsWith("[")) continue;
			let data: any;
			try {
				data = JSON.parse(line);
			} catch {
				continue;
			}
			const text = extractText(data);
			if (text && text.length > bestText.length) bestText = text;
		}

		const finalText = bestText.trim();
		if (finalText) onChunk(finalText);
		onDone();
	} catch (err) {
		onError(err instanceof Error ? err : new Error(String(err)));
	}
}
