/**
 * hashline-golden.ts — regenerate testdata/hashline_golden.json.
 *
 * The golden vector pins the TS ⇄ Go hash parity contract documented in
 * hashline.ts: Go (internal/core/hashline.go) must produce these exact digests
 * for these exact lines, and the TS tests assert the same file.
 *
 *   bun run pi-extension/hashline-golden.ts
 *
 * Only change the corpus deliberately: a regenerated file means the hash
 * contract changed, which invalidates every hash an agent may still hold in an
 * open session, and both test suites must be re-run.
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HASH_DEFAULT, HASH_MAX, hashLine } from "./hashline.ts";

/**
 * Deliberately awkward lines: the empty line (blank lines are the common
 * ambiguous case), whitespace-only, tabs, CRLF input (must hash like its LF
 * form), non-ASCII and astral-plane characters, shell/regex metacharacters,
 * and a long line.
 */
const GOLDEN_LINES: string[] = [
	"",
	"a",
	"hello world",
	"const x = 1;",
	"  \t  ",
	"\treturn true;",
	"}",
	"{",
	"0",
	"# comment",
	"line with unicode: héllo wörld",
	"emoji 🐍 and 漢字",
	'backslash \\ quote " dollar $1 & ( ) [ ]',
	"x\r",
	"\t\tdeeply\tindented\ttext\t",
	"a".repeat(500),
];

const cases = GOLDEN_LINES.map((line) => ({
	line,
	hash: hashLine(line, HASH_DEFAULT),
	full: hashLine(line, HASH_MAX),
}));

const out = {
	generator: "bun run pi-extension/hashline-golden.ts",
	hashAlphabet: "0123456789abcdefghjkmnpqrstvwxyz",
	hashLength: HASH_DEFAULT,
	fullHashLength: HASH_MAX,
	comment: "SHA-256 of each line's UTF-8 bytes (one trailing CR removed), mapped to the alphabet via digest[i] & 31. See pi-extension/hashline.ts for the full contract.",
	cases,
};

const target = resolve(dirname(fileURLToPath(import.meta.url)), "..", "testdata", "hashline_golden.json");
writeFileSync(target, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`wrote ${cases.length} hashline golden cases to ${target}`);
