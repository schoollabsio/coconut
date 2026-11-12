/**
 * hashline.test.ts — `bun test pi-extension/hashline.test.ts`
 *
 * Two jobs:
 *   1. Assert the committed golden vector, so the TS implementation cannot
 *      drift from the Go one (internal/core/hashline.go asserts the same file).
 *   2. Cover the resolution rules agents depend on: never a silent wrong-line
 *      edit, ambiguity is an error with a remedy, CRLF endings survive.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
	applyHashlineEdit,
	fileLineHashes,
	hashLine,
	normalizeLine,
	resolveHashline,
	splitDoc,
	joinDoc,
	withHashColumn,
	HASH_ALPHABET,
	HASH_DEFAULT,
	HASH_MAX,
	type HashlineDoc,
} from "./hashline.ts";

const golden: { cases: { line: string; hash: string; full: string }[] } = JSON.parse(
	readFileSync(new URL("../testdata/hashline_golden.json", import.meta.url), "utf8"),
);

const h = (line: string, len = HASH_DEFAULT) => hashLine(line, len);
const docOf = (content: string): HashlineDoc => splitDoc(content);

const SAMPLE = "alpha\nbeta\ngamma\nbeta\n";
const hAlpha = h("alpha");
const hBeta = h("beta");
const hGamma = h("gamma");

describe("golden vector (TS ⇄ Go parity anchor)", () => {
	test("every committed digest matches this implementation", () => {
		for (const c of golden.cases) {
			expect(hashLine(c.line, golden.hashLength)).toBe(c.hash);
			expect(hashLine(c.line, golden.fullHashLength)).toBe(c.full);
		}
	});
	test("the alphabet is 32 unambiguous characters", () => {
		expect(HASH_ALPHABET).toHaveLength(32);
		for (const banned of ["i", "l", "o", "u"]) expect(HASH_ALPHABET).not.toContain(banned);
	});
	test("hashing is stable and independent of line ending", () => {
		expect(h("x")).toBe(h("x"));
		expect(h("x\r")).toBe(h("x"));
		expect(normalizeLine("x\r")).toBe("x");
	});
	test("the empty line has a hash (blank lines are addressable, just often ambiguous)", () => {
		expect(h("")).toHaveLength(HASH_DEFAULT);
	});
});

describe("line model", () => {
	test("split/join round-trips byte-for-byte", () => {
		for (const content of ["", "a", "a\n", "a\nb", "a\nb\n", "a\n\n", "a\r\nb\r\n", "\n", "\n\n", "a\n\nb\n"]) {
			expect(joinDoc(splitDoc(content))).toBe(content);
		}
	});
	test("a trailing newline does not create a phantom line", () => {
		expect(splitDoc("a\nb\n").lines).toEqual(["a", "b"]);
		expect(splitDoc("a\nb").lines).toEqual(["a", "b"]);
		expect(splitDoc("a\n\n").lines).toEqual(["a", ""]);
		expect(splitDoc("").lines).toEqual([]);
	});
	test("CRLF endings are recorded per line", () => {
		const doc = splitDoc("a\r\nb\n");
		expect(doc.lines).toEqual(["a", "b"]);
		expect(doc.crs).toEqual([true, false]);
	});
	test("fileLineHashes is index-aligned with the lines", () => {
		expect(fileLineHashes(SAMPLE)).toEqual([hAlpha, hBeta, hGamma, hBeta]);
	});
});

describe("resolveHashline", () => {
	test("a unique hash resolves to its line", () => {
		expect(resolveHashline(docOf(SAMPLE), hAlpha, 1, "hash")).toBe(0);
		expect(resolveHashline(docOf(SAMPLE), hGamma, 1, "hash")).toBe(2);
	});
	test("uppercase input is accepted (hashes are copied, casing is forgiving)", () => {
		expect(resolveHashline(docOf(SAMPLE), hAlpha.toUpperCase(), 1, "hash")).toBe(0);
	});
	test("a duplicated line is an error naming both matches and their longer digests", () => {
		expect(() => resolveHashline(docOf(SAMPLE), hBeta, 3, "hash")).toThrow(/ambiguous/);
		expect(() => resolveHashline(docOf(SAMPLE), hBeta, 3, "hash")).toThrow(/line 2 is/);
		expect(() => resolveHashline(docOf(SAMPLE), hBeta, 3, "hash")).toThrow(/line 4 is/);
	});
	test("a longer hash cannot disambiguate truly identical lines — the error says so", () => {
		// Identical lines share every digest bit, so no hash length helps; the
		// caller must fall back to an exact-match edit instead.
		expect(() => resolveHashline(docOf(SAMPLE), hashLine("beta", HASH_MAX), 1, "hash")).toThrow(/ambiguous/);
	});
	test("distinct lines have unique digests at HASH_MAX, so lengthening self-repairs", () => {
		const doc = docOf("foo bar\nfoo baz\n");
		expect(resolveHashline(doc, hashLine("foo bar", HASH_MAX), 1, "hash")).toBe(0);
		expect(resolveHashline(doc, hashLine("foo baz", HASH_MAX), 1, "hash")).toBe(1);
	});
	test("stale or mistyped hashes error rather than editing a wrong line", () => {
		expect(() => resolveHashline(docOf(SAMPLE), "0000", 2, "hash")).toThrow(/no line matches/);
	});
	test("malformed hashes error with the alphabet and length rule", () => {
		expect(() => resolveHashline(docOf(SAMPLE), "abc", 1, "hash")).toThrow(/must be 4-12 characters/);
		expect(() => resolveHashline(docOf(SAMPLE), "oooo", 1, "hash")).toThrow(/hash alphabet/); // 'o' is excluded from Crockford base32
		expect(() => resolveHashline(docOf(SAMPLE), "abc!", 1, "hash")).toThrow(/hash alphabet/);
		expect(() => resolveHashline(docOf(SAMPLE), "", 1, "hash")).toThrow(/is empty/);
		expect(() => resolveHashline(docOf(SAMPLE), "a".repeat(13), 1, "hash")).toThrow(/must be 4-12 characters/);
	});
});

describe("applyHashlineEdit", () => {
	test("replaces one line, keeping every other byte", () => {
		expect(applyHashlineEdit(SAMPLE, { hash: hAlpha, newText: "ALPHA" }, 1)).toBe("ALPHA\nbeta\ngamma\nbeta\n");
		// A hash shared by identical lines is refused, never applied to the first match.
		expect(() => applyHashlineEdit(SAMPLE, { hash: hBeta, newText: "BETA" }, 1)).toThrow(/ambiguous/);
	});
	test("replaces an inclusive range given by two hashes", () => {
		const edit = { hash: hAlpha, endHash: hGamma, newText: "x\ny" };
		expect(applyHashlineEdit(SAMPLE, edit, 1)).toBe("x\ny\nbeta\n");
	});
	test("empty newText deletes the lines including their newline (no blank line left)", () => {
		expect(applyHashlineEdit(SAMPLE, { hash: hGamma, newText: "" }, 1)).toBe("alpha\nbeta\nbeta\n");
	});
	test("deleting every line yields an empty file", () => {
		expect(applyHashlineEdit("solo\n", { hash: h("solo"), newText: "" }, 1)).toBe("");
	});
	test("insert before/after leaves the anchor intact", () => {
		expect(applyHashlineEdit(SAMPLE, { hash: hGamma, insert: "before", newText: "above" }, 1)).toBe(
			"alpha\nbeta\nabove\ngamma\nbeta\n",
		);
		expect(applyHashlineEdit(SAMPLE, { hash: hGamma, insert: "after", newText: "below" }, 1)).toBe(
			"alpha\nbeta\ngamma\nbelow\nbeta\n",
		);
	});
	test("one trailing newline in newText terminates the last line instead of adding a blank one", () => {
		expect(applyHashlineEdit(SAMPLE, { hash: hGamma, newText: "gamma\n" }, 1)).toBe(SAMPLE);
		expect(applyHashlineEdit(SAMPLE, { hash: hGamma, insert: "after", newText: "below\n" }, 1)).toBe(
			"alpha\nbeta\ngamma\nbelow\nbeta\n",
		);
	});
	test("anchors survive earlier edits that shift line numbers", () => {
		let content = SAMPLE;
		content = applyHashlineEdit(content, { hash: hAlpha, insert: "after", newText: "a1\na2\na3" }, 1);
		// gamma moved from line 3 to line 6; its hash did not change.
		content = applyHashlineEdit(content, { hash: hGamma, newText: "GAMMA" }, 2);
		expect(content).toBe("alpha\na1\na2\na3\nbeta\nGAMMA\nbeta\n");
	});
	test("CRLF endings are preserved for edited and inserted lines", () => {
		const crlf = "one\r\ntwo\r\n";
		expect(applyHashlineEdit(crlf, { hash: h("two"), newText: "TWO" }, 1)).toBe("one\r\nTWO\r\n");
		expect(applyHashlineEdit(crlf, { hash: h("two"), insert: "after", newText: "three\nfour" }, 1)).toBe(
			"one\r\ntwo\r\nthree\r\nfour\r\n",
		);
	});
	test("a file with no final newline stays without one", () => {
		expect(applyHashlineEdit("a\nb", { hash: h("b"), newText: "B" }, 1)).toBe("a\nB");
	});
	test("endHash before hash is an error", () => {
		expect(() => applyHashlineEdit(SAMPLE, { hash: hGamma, endHash: hAlpha, newText: "x" }, 1)).toThrow(
			/before the anchor line/,
		);
	});
	test("insert cannot be combined with endHash, nor with empty newText", () => {
		expect(() => applyHashlineEdit(SAMPLE, { hash: hAlpha, endHash: hGamma, insert: "after", newText: "x" }, 1)).toThrow(
			/cannot be combined with endHash/,
		);
		expect(() => applyHashlineEdit(SAMPLE, { hash: hAlpha, insert: "after", newText: "" }, 1)).toThrow(/inserts nothing/);
	});
	test("an empty file has nothing to anchor to and says how to create it", () => {
		expect(() => applyHashlineEdit("", { hash: h("x"), newText: "x" }, 1)).toThrow(/legacy edit/);
	});
	test("error messages identify the edit by number", () => {
		expect(() => applyHashlineEdit(SAMPLE, { hash: "0000", newText: "x" }, 7)).toThrow(/edit #7/);
	});
});

describe("withHashColumn", () => {
	test("annotates file lines with line number and hash", () => {
		const out = withHashColumn(SAMPLE, SAMPLE, 1);
		expect(out.split("\n")).toEqual([
			`1│${hAlpha}│alpha`,
			`2│${hBeta}│beta`,
			`3│${hGamma}│gamma`,
			`4│${hBeta}│beta`,
			"",
		]);
	});
	test("honours the read offset and pads line numbers to the window width", () => {
		const out = withHashColumn("gamma\n", SAMPLE, 3);
		expect(out).toBe(`3│${hGamma}│gamma\n`);
	});
	test("pi's appended notices pass through unannotated", () => {
		const output = "alpha\nbeta\n\n[2 more lines in file. Use offset=3 to continue.]";
		const out = withHashColumn(output, SAMPLE, 1);
		const lines = out.split("\n");
		expect(lines[0]).toBe(`1│${hAlpha}│alpha`);
		expect(lines[1]).toBe(`2│${hBeta}│beta`);
		expect(lines[2]).toBe("");
		expect(lines[3]).toBe("[2 more lines in file. Use offset=3 to continue.]");
	});
	test("a content line that happens to look like a notice still gets its hash", () => {
		const content = "[Truncated: not really]\n";
		const out = withHashColumn(content, content, 1);
		expect(out).toBe(`1│${h("[Truncated: not really]")}│[Truncated: not really]\n`);
	});
	test("CRLF output keeps its carriage return in the annotated line", () => {
		const content = "one\r\ntwo\r\n";
		const out = withHashColumn(content, content, 1);
		expect(out.split("\n")).toEqual([`1│${h("one")}│one\r`, `2│${h("two")}│two\r`, ""]);
	});
	test("hashes shown for a window match the hashes of the same lines in the whole file", () => {
		const window = splitDoc(SAMPLE).lines.slice(1).join("\n");
		const annotated = withHashColumn(window, SAMPLE, 2);
		expect(annotated.split("\n")[0]).toBe(`2│${hBeta}│beta`);
	});
});

