import { describe, expect, it } from "vitest";
import { renderAskUserInputAsText } from "./claude-web";

describe("renderAskUserInputAsText", () => {
	it("writes out a question the runtime has no tool to carry", () => {
		// A session without `ask_question` — a manager, or any hub session, since
		// the hub supplies no askQuestion executor — used to drop this payload
		// entirely and end the turn with no content at all.
		const rendered = renderAskUserInputAsText(
			JSON.stringify({
				questions: [
					{
						question: "Delete the kanban app directory as well?",
						options: ["Yes, remove it", "No, leave it"],
					},
				],
			}),
		);

		expect(rendered).toBe(
			[
				"Delete the kanban app directory as well?",
				"- Yes, remove it",
				"- No, leave it",
			].join("\n"),
		);
	});

	it("handles a question with no options", () => {
		expect(
			renderAskUserInputAsText(
				JSON.stringify({ questions: [{ question: "Which repo?" }] }),
			),
		).toBe("Which repo?");
	});

	it("returns nothing for a payload it cannot read", () => {
		expect(renderAskUserInputAsText("not json")).toBeUndefined();
		expect(
			renderAskUserInputAsText(JSON.stringify({ questions: [] })),
		).toBeUndefined();
		expect(
			renderAskUserInputAsText(JSON.stringify({ other: 1 })),
		).toBeUndefined();
	});
});
