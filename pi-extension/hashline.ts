/**
 * hashline.ts — content-addressed line anchors for propose_edit.
 *
 * A "hashline" is a short digest of a line's own text (e.g. `a3kf`). The agent
 * copies it from the hash column `read` prints and hands it back to
 * propose_edit instead of a line number, so an edit keeps targeting the line it
 * was read from even when earlier edits in the same call shift line numbering.
 *
 * This module is dependency-free (node:crypto only) so `bun test` can cover it
 * without loading pi:  bun test pi-extension/hashline.test.ts
 *
 * ── PARITY CONTRACT ────────────────────────────────────────────────────────
 * internal/core/hashline.go implements the same rules in Go, because the Go
 * backend resolves the same anchors to render the diff the user approves. The
 * two must stay byte-identical, otherwise the approved diff is not the bytes
 * written. The contract is pinned by testdata/hashline_golden.json, asserted by
 * BOTH `bun test pi-extension/hashline.test.ts` and `go test ./internal/core`:
 *
 *   1. A line is the text between "\n" delimiters with ONE trailing "\r"
 *      removed, so CRLF files hash like LF files and keep their own ending.
 *   2. digest = SHA-256 of the UTF-8 bytes of that line text.
 *   3. hash[i] = HASH_ALPHABET[digest[i] & 31] — 5 bits per character, taken
 *      from the low bits of consecutive digest bytes.
 *   4. Addressable lines are the "\n" split parts minus one trailing empty
 *      part: a file ending in "\n" has no line after that final newline.
 *   5. A hash is a PREFIX match, so lengthening it narrows an ambiguous match.
 *   6. In newText, one trailing "\n" terminates the last line rather than
 *      adding an empty line; an empty newText deletes the anchor lines.
 */

import { createHash } from "node:crypto";

/** Crockford base32: 32 unambiguous characters (no i, l, o, u). */
export const HASH_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const HASH_MIN = 4;
export const HASH_MAX = 12;
/** Default width `read` prints and propose_edit expects when none is given. */
export const HASH_DEFAULT = HASH_MIN;

/** One hashline edit: replace `hash` (through `endHash`) with `newText`. */
export interface HashlineEdit {
	/** 4-12 chars copied from read's hash column; longer narrows ambiguity. */
	hash: string;
	/** Inclusive end of a multi-line replacement. */
	endHash?: string;
	/** Insert beside the anchor instead of replacing it. */
	insert?: "before" | "after";
	/** Replacement text for the selected line(s). "" deletes them. */
	newText: string;
}

/** A file as addressable lines plus the line-ending information needed to re-emit it byte-for-byte. */
export interface HashlineDoc {
	/** Line text, WITHOUT "\r" or "\n". */
	lines: string[];
	/** Per line: true when the original line ended "\r\n". */
	crs: boolean[];
	/** True when the content ended with a newline. */
	trailingNewline: boolean;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** Strip one trailing CR so CRLF and LF files hash identically (rule 1). */
export function normalizeLine(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export function hashLine(line: string, length = HASH_DEFAULT): string {
	const text = normalizeLine(line);
	const digest = createHash("sha256").update(text, "utf8").digest();
	const width = Math.max(HASH_MIN, Math.min(HASH_MAX, length));
	let out = "";
	for (let i = 0; i < width; i++) out += HASH_ALPHABET[digest[i] & 31];
	return out;
}

/** Hash of every addressable line, index-aligned with `splitDoc(content).lines`. */
export function fileLineHashes(content: string, length = HASH_DEFAULT): string[] {
	return splitDoc(content).lines.map((line) => hashLine(line, length));
}

// ---------------------------------------------------------------------------
// Line model
// ---------------------------------------------------------------------------

export function splitDoc(content: string): HashlineDoc {
	if (content === "") return { lines: [], crs: [], trailingNewline: false };
	const parts = content.split("\n");
	const trailingNewline = parts[parts.length - 1] === "";
	if (trailingNewline) parts.pop();
	const lines: string[] = [];
	const crs: boolean[] = [];
	for (const part of parts) {
		crs.push(part.endsWith("\r"));
		lines.push(normalizeLine(part));
	}
	return { lines, crs, trailingNewline };
}

export function joinDoc(doc: HashlineDoc): string {
	// No lines means the file is empty — never re-synthesize a lone newline
	// (a file containing just "\n" is one empty line, not zero lines).
	if (doc.lines.length === 0) return "";
	const body = doc.lines.map((line, i) => (doc.crs[i] ? line + "\r" : line)).join("\n");
	return doc.trailingNewline ? body + "\n" : body;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Validate and normalize a hash argument (lowercase, in-alphabet, in length). */
export function normalizeHash(hash: string, editNumber: number, field: string): string {
	const value = (hash ?? "").trim().toLowerCase();
	if (value === "") {
		throw new Error(
			`edit #${editNumber}: ${field} is empty — copy a ${HASH_DEFAULT}-character hash from read's hash column.`,
		);
	}
	if (value.length < HASH_MIN || value.length > HASH_MAX) {
		throw new Error(
			`edit #${editNumber}: ${field} "${value}" must be ${HASH_MIN}-${HASH_MAX} characters (a longer hash narrows an ambiguous match).`,
		);
	}
	for (const ch of value) {
		if (!HASH_ALPHABET.includes(ch)) {
			throw new Error(
				`edit #${editNumber}: ${field} "${value}" contains characters outside the hash alphabet "${HASH_ALPHABET}" — copy the hash column from read output verbatim.`,
			);
		}
	}
	return value;
}

/** Indices of every line whose hash starts with `hash`. */
export function findHashlineMatches(doc: HashlineDoc, hash: string): number[] {
	const found: number[] = [];
	for (let i = 0; i < doc.lines.length; i++) {
		if (hashLine(doc.lines[i], hash.length) === hash) found.push(i);
	}
	return found;
}

const MAX_LISTED_MATCHES = 6;

/**
 * Resolve a hash to exactly one line index (0-based). Never guesses: no match
 * and an ambiguous match are both errors with an actionable remedy, so a stale
 * or duplicate hash can never silently edit the wrong line.
 */
export function resolveHashline(doc: HashlineDoc, rawHash: string, editNumber: number, field: string): number {
	const hash = normalizeHash(rawHash, editNumber, field);
	const matches = findHashlineMatches(doc, hash);
	if (matches.length === 1) return matches[0];
	if (matches.length === 0) {
		throw new Error(
			`edit #${editNumber}: no line matches ${field} "${hash}". The file changed since you read it, or the hash was mistyped — re-read the file (read prints the hash column) and propose again.`,
		);
	}
	const listed = matches
		.slice(0, MAX_LISTED_MATCHES)
		.map((idx) => `line ${idx + 1} is "${hashLine(doc.lines[idx], HASH_MAX)}"`)
		.join(", ");
	const more = matches.length > MAX_LISTED_MATCHES ? ` (+${matches.length - MAX_LISTED_MATCHES} more)` : "";
	throw new Error(
		`edit #${editNumber}: ${field} "${hash}" is ambiguous — it matches ${matches.length} lines: ${listed}${more}. Re-issue with a longer hash (up to ${HASH_MAX} characters) that identifies one line.`,
	);
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/** Split newText into lines, honouring rule 6 (one trailing "\n" is a terminator, not an empty line). */
function newTextLines(newText: string): string[] {
	const trimmed = newText.endsWith("\n") ? newText.slice(0, -1) : newText;
	return trimmed.split("\n");
}

function spliceLines(doc: HashlineDoc, at: number, deleteCount: number, added: string[], cr: boolean): void {
	doc.lines.splice(at, deleteCount, ...added);
	doc.crs.splice(at, deleteCount, ...added.map(() => cr));
}

/**
 * Apply one hashline edit to `content` and return the new content.
 * `editNumber` is 1-based and only used for error messages.
 */
export function applyHashlineEdit(content: string, edit: HashlineEdit, editNumber: number): string {
	const doc = splitDoc(content);
	if (doc.lines.length === 0) {
		throw new Error(
			`edit #${editNumber}: the file has no lines to anchor to — create or overwrite it with a single legacy edit ({ oldText: "", newText: <full file content> }).`,
		);
	}
	if (edit.insert !== undefined && edit.endHash !== undefined) {
		throw new Error(`edit #${editNumber}: "insert" anchors a single line, so it cannot be combined with endHash.`);
	}
	if (edit.insert !== undefined && edit.newText === "") {
		throw new Error(`edit #${editNumber}: insert with an empty newText inserts nothing.`);
	}

	const start = resolveHashline(doc, edit.hash, editNumber, "hash");
	const end = edit.endHash === undefined ? start : resolveHashline(doc, edit.endHash, editNumber, "endHash");
	if (end < start) {
		throw new Error(
			`edit #${editNumber}: endHash "${edit.endHash}" resolves to line ${end + 1}, before the anchor line ${start + 1} — endHash must be at or after hash.`,
		);
	}

	// A replacement range inherits the ending of its LAST line; an insert
	// inherits the anchor's ending.
	const cr = doc.crs[end];
	if (edit.insert === "before") {
		spliceLines(doc, start, 0, newTextLines(edit.newText), cr);
	} else if (edit.insert === "after") {
		spliceLines(doc, end + 1, 0, newTextLines(edit.newText), cr);
	} else if (edit.newText === "") {
		// Deletion drops the lines entirely, newline included, so it does not
		// leave a blank line behind.
		spliceLines(doc, start, end - start + 1, [], cr);
	} else {
		spliceLines(doc, start, end - start + 1, newTextLines(edit.newText), cr);
	}
	return joinDoc(doc);
}

// ---------------------------------------------------------------------------
// read output annotation
// ---------------------------------------------------------------------------

/**
 * Prefix read output with `<line>│<hash>│` so the agent can see the anchors.
 *
 * Only the output lines that verbatim match the file's own lines are annotated;
 * anything else (pi's appended `[Showing lines …]` / `[N more lines …]` notices,
 * truncation warnings) passes through untouched. `startLine` is the 1-indexed
 * file line the output begins at.
 */
export function withHashColumn(
	output: string,
	fileContent: string,
	startLine = 1,
	hashLength = HASH_DEFAULT,
): string {
	const fileLines = splitDoc(fileContent).lines;
	const outLines = output.split("\n");
	const lastAddressable = Math.min(startLine - 1 + outLines.length, fileLines.length);
	const width = String(Math.max(lastAddressable, startLine)).length;
	return outLines
		.map((line, k) => {
			const idx = startLine - 1 + k;
			if (idx >= fileLines.length) return line;
			if (normalizeLine(line) !== fileLines[idx]) return line;
			return `${String(idx + 1).padStart(width, " ")}│${hashLine(fileLines[idx], hashLength)}│${line}`;
		})
		.join("\n");
}
