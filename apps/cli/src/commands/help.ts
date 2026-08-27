import { getCliDisplayVersion } from "../utils/common";
import { writeln } from "../utils/output";

export function showVersion(): void {
	writeln(getCliDisplayVersion());
}
