/**
 * Coconut pi extension
 *
 * Agent-side enforcement + tooling layer for the Coconut desktop app.
 * Coconut runs the real `pi` coding agent as an RPC sidecar:
 *
 *   pi --mode rpc --no-extensions -e coconut.ts \
 *      --tools read,run,grep,find,ls,propose_edit,show_content
 *
 * The Go backend renders its own UI and talks to pi over JSONL RPC, so ALL
 * user interaction here goes through the RPC-bridged extension-UI protocol
 * (ctx.ui.confirm → `extension_ui_request` / `extension_ui_response`).
 *
 * Approval wire contract (parsed by the Go backend — do not change lightly):
 *   - title:   "coconut://propose_edit" | "coconut://run"
 *   - message: stringified JSON including the pi toolCallId
 *   - reply:   extension_ui_response with { confirmed: true } approves;
 *              { confirmed: false } or { cancelled: true } dismisses/blocks.
 *
 * Pieces:
 *   1. propose_edit tool — the ONLY way the agent can create/modify files
 *      (built-in edit/write are not in --tools). Gated on user approval.
 *   2. show_content tool — ungated display channel into the app's content
 *      panel. Mode A (path+content): render a composed document. Mode B
 *      (file): render an existing file read directly from disk. The tool
 *      itself writes nothing; the backend persists shown documents into
 *      the agent's content library (.coconut/agents/<slug>/content/) so
 *      every session of the agent can re-open them.
 *   3. run tool — replaces the built-in bash tool with a registered tool that
 *      requires what/why; whitelisted commands run without approval, others
 *      open the coconut://run approval dialog.
 *   4. tool_call hook hard-blocking built-in edit/write/apply_patch if a pi
 *      build ever activates them despite --tools.
 *   5. before_agent_start — appends the agent's custom system prompt
 *      (COCONUT_SYSTEM_PROMPT_FILE, re-read every prompt) plus the
 *      "Coconut environment" guidance.
 *   6. project_trust — always "no": the app isolates the agent from
 *      project-local pi settings/extensions.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	type ExtensionAPI,
	withFileMutationQueue,
	createReadTool,
	createGrepTool,
	createFindTool,
	createLsTool,
} from "@earendil-works/pi-coding-agent";
// Hashline addressing — the hash column read shows and the resolver
// propose_edit uses. Shared with the Go backend through
// testdata/hashline_golden.json; see hashline.ts for the contract.
import { applyHashlineEdit, withHashColumn } from "./hashline.ts";
import { Type, type Static } from "typebox";
import { exec } from "node:child_process";
import { promisify } from "node:util";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ProposeEditParamsSchema = Type.Object({
	path: Type.String({
		description: "Path of the file to modify, relative to the working directory or absolute.",
	}),
	what: Type.String({ description: "Short summary of what the change does (shown to the user)." }),
	why: Type.String({ description: "Rationale for the change (shown to the user)." }),
	groupLabel: Type.String({
		description: "Short label to group this call with related calls; defaults to _default if omitted.",
	}),
	edits: Type.Array(
		Type.Object({
			hash: Type.Optional(Type.String({ description: "Hash of the line to address, copied from read's hash column. Longer is fine (up to 12 chars) to disambiguate; the match is a prefix." })),
			endHash: Type.Optional(Type.String({ description: "Hash of the last line of an inclusive replacement range. Defaults to hash, i.e. a single line." })),
			insert: Type.Optional(Type.String({ description: "Insert beside the anchored line instead of replacing it: \"before\" or \"after\". Requires newText and cannot combine with endHash." })),
			oldText: Type.Optional(Type.String({ description: "Legacy exact-match anchor; use only when hash is omitted. Must match the current content exactly." })),
			newText: Type.String({ description: "Replacement text for the anchored lines; \"\" deletes them." }),
		}),
		{
			minItems: 1,
			description:
				"Edits to apply, in order. Prefer hashline edits: copy a line's hash from read's hash column into `hash` and give `newText` (`\"\"` deletes the line); `endHash` replaces an inclusive range, `insert` adds lines beside the anchor. A hash is a digest of the line's own content, so earlier edits in the same batch cannot shift it onto the wrong line. A stale or ambiguous hash is refused with an error — re-read the file (or lengthen the hash) instead of guessing. Legacy mode (omit `hash`, provide `oldText`) replaces the first exact occurrence; to create or fully overwrite a file, pass a single legacy edit with `oldText: \"\"` and `newText` set to the complete file content.",
		},
	),
});
export type ProposeEditParams = Static<typeof ProposeEditParamsSchema>;

const ShowContentParamsSchema = Type.Object({
	path: Type.Optional(
	Type.String({
		description: 'Document file name, e.g. "report.md". Becomes an entry in the agent\'s content library.',
	}),
	),
	content: Type.Optional(
		Type.String({ description: "Full document content (usually Markdown). Required unless file is set." }),
	),
	file: Type.Optional(
		Type.String({ description: "Path of an existing file to display (read directly from disk — no content needed)." }),
	),
	what: Type.String({ description: "Short summary of what this document conveys (shown to the user)." }),
	why: Type.String({ description: "Rationale for why this document is being shown (shown to the user)." }),
	groupLabel: Type.String({
		description: "Short label to group this call with related calls; defaults to _default if omitted.",
	}),
	format: Type.Optional(
		Type.String({
			description: "Display format: 'markdown' (default) or 'html'. HTML is rendered in a sandboxed iframe without scripts.",
		}),
	),
});
export type ShowContentParams = Static<typeof ShowContentParamsSchema>;

const RunParamsSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute." }),
	what: Type.String({
		description: "Short summary of what this command does (shown to the user for approval).",
	}),
	why: Type.String({
		description: "Rationale for why this command is needed (shown to the user for approval).",
	}),
	groupLabel: Type.String({
		description: "Short label to group this call with related calls; defaults to _default if omitted.",
	}),
});
export type RunParams = Static<typeof RunParamsSchema>;

// ---------------------------------------------------------------------------
// Built-in tool override schemas (read, grep, find, ls)
// Each extends the built-in tool's schema with required `what`/`why` fields.
// ---------------------------------------------------------------------------

const ReadSchemaWithWhatWhy = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
		hashes: Type.Optional(Type.Boolean({ description: "Prefix each content line with the hash propose_edit addresses it by (default true). Pass false for raw file content." })),
	what: Type.String({ description: "Short summary of what this tool call does (shown to the user)." }),
	why: Type.String({ description: "Rationale for why this tool call is needed (shown to the user)." }),
	groupLabel: Type.String({
		description: "Short label to group this call with related calls; defaults to _default if omitted.",
	}),
});

const GrepSchemaWithWhatWhy = Type.Object({
	pattern: Type.String({ description: "The regex pattern to search for" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search in (defaults to cwd)" })),
	glob: Type.Optional(Type.String({ description: "Glob pattern to filter files (e.g. '*.ts')" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string" })),
	context: Type.Optional(Type.Number({ description: "Number of context lines to show" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results" })),
	what: Type.String({ description: "Short summary of what this tool call does (shown to the user)." }),
	why: Type.String({ description: "Rationale for why this tool call is needed (shown to the user)." }),
	groupLabel: Type.String({
		description: "Short label to group this call with related calls; defaults to _default if omitted.",
	}),
});

const FindSchemaWithWhatWhy = Type.Object({
	pattern: Type.String({ description: "Glob pattern to find files (e.g. '**/*.ts')" }),
	path: Type.Optional(Type.String({ description: "Directory to search in (defaults to cwd)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results" })),
	what: Type.String({ description: "Short summary of what this tool call does (shown to the user)." }),
	why: Type.String({ description: "Rationale for why this tool call is needed (shown to the user)." }),
	groupLabel: Type.String({
		description: "Short label to group this call with related calls; defaults to _default if omitted.",
	}),
});

const LsSchemaWithWhatWhy = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (defaults to cwd)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries" })),
	what: Type.String({ description: "Short summary of what this tool call does (shown to the user)." }),
	why: Type.String({ description: "Rationale for why this tool call is needed (shown to the user)." }),
	groupLabel: Type.String({
		description: "Short label to group this call with related calls; defaults to _default if omitted.",
	}),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Some models prefix path arguments with "@"; built-in tools strip it, so do we.
function cleanPath(p: string): string {
	return p.startsWith("@") ? p.slice(1) : p;
}

function toAbsolute(cwd: string, p: string): string {
	return isAbsolute(p) ? p : resolve(cwd, p);
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let idx = 0;
	while (true) {
		idx = haystack.indexOf(needle, idx);
		if (idx === -1) return count;
		count++;
		idx += needle.length;
	}
}

// Slice-based replacement so `$`-patterns in `replacement` stay literal
// (String.replace would interpret "$&", "$1", ...).
function replaceFirst(haystack: string, needle: string, replacement: string): string {
	const idx = haystack.indexOf(needle);
	if (idx === -1) return haystack;
	return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}

function preview(s: string, max = 80): string {
	const oneLine = s.replace(/\n/g, "\\n");
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

// Check whether a command is safe to run without approval (all segments
// are non-dangerous and whitelisted).
function isWhitelistedCommand(command: string, bashWhitelist: string[]): boolean {
	for (const rawSegment of splitSegments(command)) {
		const seg = rawSegment.trim();
		if (seg === "") continue;
		if (isDangerousSegment(seg) || !isWhitelistedSegment(seg, bashWhitelist)) {
			return false;
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// Bash gating
// ---------------------------------------------------------------------------

const DEFAULT_READ_ONLY = [
	"ls",
	"grep",
	"find",
	"cat",
	"head",
	"tail",
	"pwd",
	"wc",
	"file",
	"stat",
	"which",
	"echo",
	"git status",
	"git diff",
	"git log",
	"git show",
	"git branch",
];

// Leading command words that are never whitelisted.
const DANGEROUS_LEADING = /^(rm|rmdir|unlink|sudo|mv|chmod|chown|dd|mkfs)(\s|$)/;

// Naive segment splitter: does NOT understand shell quoting, escaping,
// backticks, or $(...) subshells. This is an approval heuristic, not a sandbox:
// its failures err toward more approval prompts (e.g. `echo "a && b"` splits
// into two segments), except that command substitution can still hide commands
// inside a whitelisted prefix — the human approver remains the real boundary.
function splitSegments(command: string): string[] {
	return command.split(/&&|\|\||;|\||\n/);
}

function isWhitelistedSegment(seg: string, whitelist: string[]): boolean {
	for (const prefix of whitelist) {
		if (prefix === "*") return true; // "*" allows everything not dangerous
		if (!seg.startsWith(prefix)) continue;
		// Prefix must be followed by end-of-segment or whitespace.
		if (seg.length === prefix.length || seg[prefix.length] === " " || seg[prefix.length] === "\t") {
			return true;
		}
	}
	return false;
}

function isDangerousSegment(seg: string): boolean {
	if (DANGEROUS_LEADING.test(seg)) return true;
	// Simplest correct redirection rule: ANY `>` outside quotes gates the
	// segment. This deliberately includes stderr redirects (`2>/dev/null`) on
	// otherwise read-only commands — a conservative false positive we accept
	// rather than parsing shells. Quote handling is naive (no escapes).
	let inSingle = false;
	let inDouble = false;
	for (const ch of seg) {
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (ch === ">" && !inSingle && !inDouble) return true;
	}
	return false;
}

/**
 * Apply a whole propose_edit batch sequentially and return the resulting text.
 * Hashline anchors resolve against the file as it stands at that point in the
 * batch, which is what keeps them pointing at the same line after an earlier
 * edit inserts or deletes above them. Legacy exact-match edits behave as
 * before. Throws on the first anchor that cannot be resolved, so callers can
 * dry-run a proposal before asking the user to approve it.
 */
function applyProposalEdits(content: string, edits: ProposeEditParams["edits"], notes: string[] = []): string {
	let next = content;
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		if (edit.hash !== undefined) {
			next = applyHashlineEdit(
				next,
				{ hash: edit.hash, endHash: edit.endHash, insert: edit.insert, newText: edit.newText },
				i + 1,
			);
			continue;
		}

		const oldText = edit.oldText as string;
		const occurrences = countOccurrences(next, oldText);
		if (occurrences === 0) throw new Error(`edit #${i + 1}: oldText not found: "${preview(oldText)}"`);
		if (occurrences > 1) notes.push(`edit #${i + 1}: oldText occurred ${occurrences} times; replaced the first occurrence only`);
		next = replaceFirst(next, oldText, edit.newText);
	}
	return next;
}

/**
 * Prefix a built-in read result with the hash column propose_edit anchors to.
 *
 * The column is computed from the FILE, not from the output: only output lines
 * that verbatim match the file's own lines get a hash, so pi's appended
 * "[Showing lines …]" notices never look like anchors and an offset read still
 * numbers its lines by their real position. When the file cannot be re-read
 * (missing, unreadable, replaced mid-call) the result passes through
 * unannotated — a worse lookup, never a wrong one.
 */
async function annotateReadResult(result: unknown, cwd: string, path: unknown, offset = 1): Promise<unknown> {
	if (!result || typeof result !== "object") return result;
	const items = (result as { content?: unknown }).content;
	if (!Array.isArray(items) || typeof path !== "string" || path === "") return result;
	let fileContent: string;
	try {
		fileContent = await readFile(toAbsolute(cwd, cleanPath(path)), "utf8");
	} catch {
		return result;
	}
	const startLine = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 1;
	let annotated = false;
	const next = items.map((item) => {
		if (!item || typeof item !== "object") return item;
		const entry = item as { type?: string; text?: unknown };
		if (entry.type !== "text" || typeof entry.text !== "string") return item;
		annotated = true;
		return { ...entry, text: withHashColumn(entry.text, fileContent, startLine) };
	});
	return annotated ? { ...(result as object), content: next } : result;
}

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// System-prompt guidance
// ---------------------------------------------------------------------------

// Per-agent custom instructions: the backend points
// COCONUT_SYSTEM_PROMPT_FILE at <agent-dir>/system-prompt.md. The hook below
// fires per user prompt and re-reads the file each time, so edits apply to
// the next message with no sidecar restart. Pathological sizes are ignored
// rather than bloating the context window.
const MAX_CUSTOM_PROMPT_CHARS = 64 * 1024;

const COCONUT_GUIDANCE = `## Coconut environment

You are running inside the Coconut desktop app. Its environment differs from a stock pi setup:

- The built-in \`edit\` and \`write\` tools do NOT exist here. The ONLY way to create or modify files is the \`propose_edit\` tool.
- \`propose_edit\` blocks on explicit user approval before anything is written, so:
  - Gather context first with \`read\`, \`grep\`, \`find\`, \`ls\` (and read-only \`run\` commands) before proposing a change.
  - Propose complete, well-formed edits addressed by line hash: \`read\` prints a short hash in front of every line, and an edit is \`{ hash, newText }\` (\`newText: ""\` deletes the line, \`endHash\` spans a range, \`insert\` adds lines beside the anchor). Hashes identify lines by content, so a batch of edits cannot drift onto the wrong line the way line numbers do. An unknown or ambiguous hash is an error, never a guess: re-read the file and retry with the current hash, or lengthen it to disambiguate. Legacy exact-match edits (omit \`hash\`, provide \`oldText\`) still work and must match the current content exactly; a whole-file create stays a single legacy edit with \`oldText: ""\`. Give every proposal a clear \`what\` and \`why\` — the user reads them when deciding.
  - Never assume a proposal was approved; check the tool result.
  - If the user dismisses a proposal, do NOT retry the same edit. Stop and wait — the user will follow up in chat with what to change.
- Use \`show_content\` to display markdown documents (reports, plans, notes, summaries) in the user's content panel. It is NOT a file-writing tool: it creates no project files and modifies nothing — use \`propose_edit\` for anything that belongs in the project.
- When the user asks to be SHOWN something ("show me…", "let me see…", "display…") — or your reply would be a long document, table, list, or code block — render it with \`show_content\` instead of stating it inline. To show an existing file, pass \`file\` (you do not need to reproduce its contents); to render a document you compose, pass \`path\` + \`content\`. Keep the chat reply itself short (a sentence pointing at the panel); the panel is the reading surface, chat is the conversation.
- \`run\` is the shell-command tool (replacing \`bash\`). It requires \`what\` and \`why\` arguments so the user can approve commands with context. Whitelisted commands (ls, grep, cat, git status, etc.) run without approval; anything else opens an approval dialog.
- Every tool call requires three fields: \`what\`, \`why\`, and \`groupLabel\`. \`what\` is a concise summary of the action and \`why\` is the rationale — the user reads both in the chat timeline. \`groupLabel\` is a **human-readable** label (e.g. "Search for todo auto-completion logic", "Implement changes to auto-completion logic") that groups independent tool calls that belong together — reading 3 files before editing them, or a read/edit/verify cycle. All calls with the same \`groupLabel\` string collapse into one expandable group in the chat timeline, making it easier for the user to review. It should concisely communicate the underlying intended outcome of the grouped tool calls.
- Each agent has a per-agent env file at \`$COCONUT_AGENT_ENV\` (discover the path with \`echo $COCONUT_AGENT_ENV\`). It is sourced before every \`run\` command, so you can persist PATH additions and other environment setup (e.g. \`export PATH="/usr/local/go/bin:$PATH"\`) without hardcoding absolute paths in every command.
`;

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Extra comma-separated bash whitelist prefixes from the environment.
	const extraWhitelist = (process.env.COCONUT_BASH_WHITELIST ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const bashWhitelist = [...DEFAULT_READ_ONLY, ...extraWhitelist];

	// -----------------------------------------------------------------------
	// 1. propose_edit — approval-gated file modification
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "propose_edit",
		label: "Propose Edit",
		description:
			"Propose a modification to a file. This is the ONLY way to create or modify files in this environment (built-in edit/write are unavailable). Every proposal is shown to the user and applied only if approved. Address edits with the hash that read prints in front of each line: { hash, newText } replaces that line, { hash, endHash, newText } replaces the inclusive range, { hash, insert: \"before\" | \"after\", newText } adds lines beside the anchor, and { hash, newText: \"\" } deletes it. A hash identifies a line by content, so it stays valid even when earlier edits in the same call shift line numbering; a stale or ambiguous hash fails with an error instead of editing the wrong line — re-read and retry. Legacy exact matching (omit hash, provide oldText) replaces the first occurrence and must match the current content exactly. To create or fully overwrite a file, pass a single legacy edit with oldText set to the empty string and newText set to the complete file content. Edits apply sequentially.",
		promptSnippet: "Propose file edits for user approval (the only file-modification channel)",
		promptGuidelines: [
			"Use propose_edit for EVERY file creation or modification; built-in edit/write tools are not available in this environment.",
			"Address each edit with the hash read prints in front of the line (`{ hash, newText }`); prefer that over legacy oldText. A hash identifies the line by content, so it cannot land on the wrong line after another edit shifts numbering. On an unknown-hash or ambiguity error, re-read the file and retry with a current hash (or a longer prefix of it) — never guess.",
		],
		parameters: ProposeEditParamsSchema,
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as Record<string, unknown>;
			if (!input.groupLabel) input.groupLabel = "_default";
			return input;
		},
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const path = cleanPath(params.path);
			const absPath = toAbsolute(ctx.cwd, path);
			const { what, why, edits } = params;

			// Queue the entire read → confirm → apply → write window on the target
			// path so parallel tool calls cannot interleave mutations of one file.
			// (The per-file lock is held while the user decides; acceptable here
			// because approvals are the serialization point Coconut wants anyway.)
			return withFileMutationQueue(absPath, async () => {
				// An edit addresses lines by hash (hashline) or by exact text (legacy).
				const isLegacy = (edit: ProposeEditParams["edits"][number]) => edit.hash === undefined;
				const wholeFile = edits.length === 1 && isLegacy(edits[0]) && edits[0].oldText === "";

				if (!wholeFile && edits.some((e) => isLegacy(e) && e.oldText === "")) {
					throw new Error(
						`propose_edit: an empty oldText (whole-file create/overwrite) is only allowed as the sole legacy edit; got ${edits.length} edits.`,
					);
				}
				if (edits.some((e) => isLegacy(e) && e.oldText === undefined)) {
					throw new Error("propose_edit: every edit needs a hash from read's hash column, or (legacy) an oldText to match exactly.");
				}

				let current: string | null = null;
				try {
					current = await readFile(absPath, "utf8");
				} catch (err) {
					if ((err as { code?: string } | undefined)?.code !== "ENOENT") throw err;
				}

				if (current === null && !wholeFile) {
					throw new Error(
						`propose_edit: ${path} does not exist. To create it, pass a single edit with oldText "" and newText containing the full file content.`,
					);
				}

				// Resolve every anchor and apply the whole batch to an in-memory copy
				// BEFORE asking the user: a stale or ambiguous hash must fail here, not
				// after the user approved a diff that cannot actually be produced.
				if (current !== null && !wholeFile) {
					try {
						applyProposalEdits(current, edits);
					} catch (err) {
						throw new Error(`propose_edit: ${path} cannot be edited. Re-read the file and propose against its current content.\n${err instanceof Error ? err.message : String(err)}`);
					}
				}

				// Approval gate — wire contract with the Go backend. No timeout:
				// the request stays open until the user decides.
				const approved = await ctx.ui.confirm(
					"coconut://propose_edit",
					JSON.stringify({ toolCallId, path, what, why, edits }),
				);

				if (!approved) {
					return {
						content: [
							{
								type: "text",
								text: "The user dismissed this edit proposal without approving it. Do NOT retry the same edit; the user will follow up in chat with what to change.",
							},
						],
						details: { path, applied: false },
					};
				}

				const notes: string[] = [];
				let next: string;
				if (wholeFile) {
					next = edits[0].newText;
				} else {
					next = applyProposalEdits(current as string, edits, notes);
				}

				await mkdir(dirname(absPath), { recursive: true });
				await writeFile(absPath, next, "utf8");

				let text = `Applied ${edits.length} edit(s) to ${path}`;
				if (notes.length > 0) text += `\nNote: ${notes.join("; ")}.`;
				return {
					content: [{ type: "text", text }],
					details: { path, applied: true, ...(notes.length > 0 ? { notes } : {}) },
				};
			});
		},
	});

	// -----------------------------------------------------------------------
	// 2. show_content — display channel into the app's content panel.
	//    Ungated: it only displays a document and writes nothing itself;
	//    the backend persists shown documents into the agent's content
	//    library (.coconut/agents/<slug>/content/).
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "show_content",
		label: "Show Content",
		description:
			"Display a document (Markdown or HTML) to the user in the app's content panel. This is NOT a file-writing tool: it creates no project files and modifies nothing the user works on — it only displays the document. HTML is rendered in a sandboxed iframe without scripts. If the user asked you to create, write, or save a file, use propose_edit instead.",
		promptSnippet: "Display a markdown or HTML document in the user's content panel",
		promptGuidelines: [
			"Use show_content to display documents for the user to read (reports, plans, notes, summaries); it never creates project files — use propose_edit for anything that belongs in the project.",
			"When the user asks to be shown something, or your answer is a long document/list/table, render it with show_content and keep the chat reply to a one-line pointer.",
		],
		parameters: ShowContentParamsSchema,
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as Record<string, unknown>;
			if (!input.what) input.what = `Display document ${input.path ?? input.file ?? "content"}`;
			if (!input.why) input.why = "Showing content to the user as requested";
			if (!input.groupLabel) input.groupLabel = "_default";
			if (!input.format) input.format = "markdown";
			return input;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// Nothing to stage: the backend renders from these args — Mode A
			// (path+content) from the args themselves, Mode B (file) read off
			// disk by the backend — and persists the document into the agent's
			// content library.
			if (!params.file && !params.path) {
				throw new Error('show_content: pass "file" (existing file) or "path" + "content" (composed document)');
			}
			const label = params.file ?? params.path;
			// Keep the result tiny: the backend renders path/content from the
			// tool call arguments, not from this result.
			return {
				content: [{ type: "text", text: `displayed "${label}" in the user's content panel` }],
				details: { path: label },
			};
		},
	});

	// -----------------------------------------------------------------------
	// 3. run — approval-gated shell command
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "run",
		label: "Run",
		description:
			"Run a shell command. Whitelisted read-only commands (ls, grep, cat, git status, etc.) execute without approval; anything else opens the coconut://run approval dialog. Built-in bash is not available; use this tool instead.",
		promptSnippet: "Run a shell command (approval-gated for non-whitelisted commands)",
		promptGuidelines: [
			"Use `run` for shell commands. Whitelisted read-only commands run without approval; others open an approval dialog.",
			"Always provide a clear `what` (what the command does) and `why` (why it's needed) so the user can approve with context.",
		],
		parameters: RunParamsSchema,
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as Record<string, unknown>;
			if (!input.groupLabel) input.groupLabel = "_default";
			return input;
		},
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const { command, what, why } = params;

			if (!isWhitelistedCommand(command, bashWhitelist)) {
				// Wire contract with the Go backend (see file header). No timeout.
				const approved = await ctx.ui.confirm(
					"coconut://run",
					JSON.stringify({ toolCallId, command, what, why }),
				);
				if (!approved) {
					return {
						content: [
							{
								type: "text",
								text: "The user dismissed this command without approving it. Do NOT retry the same command; the user will follow up in chat with what to change.",
							},
						],
						details: { command, approved: false },
					};
				}
			}

			// Source the agent's per-agent env file (if any) before running
			// the command. This lets the agent persist PATH additions and
			// other env setup via propose_edit across tool calls. Errors from
			// sourcing are suppressed so a broken env file can't block all
			// commands; the command always runs.
			const envFile = process.env.COCONUT_AGENT_ENV ?? "";
			let script = command;
			if (envFile && existsSync(envFile)) {
				script = `. "${envFile}" 2>/dev/null; ${command}`;
			}

			// Execute the command via Node's child_process. execAsync resolves
			// with { stdout, stderr } on success or rejects on non-zero exit.
			let stdout = "";
			let stderr = "";
			let exitCode = 0;
			try {
				const result = await execAsync(script, { cwd: ctx.cwd });
				stdout = result.stdout;
				stderr = result.stderr;
			} catch (err: any) {
				stdout = err.stdout ?? "";
				stderr = err.stderr ?? "";
				exitCode = typeof err.code === "number" ? err.code : 1;
			}

			return {
				content: [
					{
						type: "text",
						text: `Command: ${command}\n\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}\n\nExit code: ${exitCode}`,
					},
				],
				details: { command, exitCode, approved: true },
			};
		},
		});

	// -----------------------------------------------------------------------
	// 3. Built-in tool overrides — add `what`/`why` to read, grep, find, ls
	// These register tools with the same name as pi's built-ins, replacing
	// their schema and execution. The execute functions delegate to the
	// built-in tool factories, preserving exact behavior (image detection,
	// ripgrep/fd, truncation, rendering) while enforcing what/why.
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "read",
		label: "Read",
		description: "Read the contents of a file with line offset and limit support. Each content line is prefixed with a short hash and a pipe (e.g. \"a3kf | text\"), except line 1 which shows the full digest as a calibration sample; that hash is the anchor propose_edit addresses lines by. Pass hashes:false to get raw content without the column.",
		promptSnippet: "Read file contents",
		promptGuidelines: [
			"Use read to examine files instead of cat or sed.",
			"Copy a line's hash from read's hash column into propose_edit's hash field — it is the anchor for edits and stays correct when earlier edits shift line numbers.",
		],
		parameters: ReadSchemaWithWhatWhy,
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as Record<string, unknown>;
			if (!input.what) input.what = `Read file contents for ${input.path ?? "file"}`;
			if (!input.why) input.why = "Examining file contents as part of the requested task";
			if (!input.groupLabel) input.groupLabel = "_default";
			return input;
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tool = createReadTool(ctx.cwd);
			const { what: _what, why: _why, groupLabel: _groupLabel, hashes, ...rest } = params;
			const result = await tool.execute(toolCallId, rest, signal, onUpdate);
			// The hash column is propose_edit's addressing scheme: one digest per
			// line, so an edit names the line it was read from instead of a line
			// number that an earlier edit may already have invalidated.
			return hashes === false ? result : annotateReadResult(result, ctx.cwd, rest.path, rest.offset);
		},
	});

	pi.registerTool({
		name: "grep",
		label: "Grep",
		description: "Search file contents for patterns (respects .gitignore).",
		promptSnippet: "Search file contents for patterns",
		promptGuidelines: ["Use grep to search file contents for patterns; it respects .gitignore."],
		parameters: GrepSchemaWithWhatWhy,
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as Record<string, unknown>;
			if (!input.what) input.what = `Search for pattern in files`;
			if (!input.why) input.why = "Searching file contents as part of the requested task";
			if (!input.groupLabel) input.groupLabel = "_default";
			return input;
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tool = createGrepTool(ctx.cwd);
			const { what: _what, why: _why, groupLabel: _groupLabel, ...rest } = params;
			return tool.execute(toolCallId, rest, signal, onUpdate);
		},
	});

	pi.registerTool({
		name: "find",
		label: "Find",
		description: "Find files by glob pattern (respects .gitignore).",
		promptSnippet: "Find files by glob pattern",
		promptGuidelines: ["Use find to locate files by name or glob pattern; it respects .gitignore."],
		parameters: FindSchemaWithWhatWhy,
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as Record<string, unknown>;
			if (!input.what) input.what = `Search for files matching pattern`;
			if (!input.why) input.why = "Locating files as part of the requested task";
			if (!input.groupLabel) input.groupLabel = "_default";
			return input;
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tool = createFindTool(ctx.cwd);
			const { what: _what, why: _why, groupLabel: _groupLabel, ...rest } = params;
			return tool.execute(toolCallId, rest, signal, onUpdate);
		},
	});

	pi.registerTool({
		name: "ls",
		label: "List",
		description: "List directory contents.",
		promptSnippet: "List directory contents",
		promptGuidelines: ["Use ls to list directory contents."],
		parameters: LsSchemaWithWhatWhy,
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as Record<string, unknown>;
			if (!input.what) input.what = "List directory contents";
			if (!input.why) input.why = "Examining directory structure as part of the requested task";
			if (!input.groupLabel) input.groupLabel = "_default";
			return input;
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tool = createLsTool(ctx.cwd);
			const { what: _what, why: _why, groupLabel: _groupLabel, ...rest } = params;
			return tool.execute(toolCallId, rest, signal, onUpdate);
		},
	});

	// -----------------------------------------------------------------------
	// 4. tool_call hook — hard-block built-in file tools
	// -----------------------------------------------------------------------

	pi.on("tool_call", async (event) => {
		// Hard-block built-in file-mutation tools if a pi build ever activates
		// them despite the --tools allowlist: propose_edit is the only
		// sanctioned file-mutation channel.
		if (event.toolName === "edit" || event.toolName === "write" || event.toolName === "apply_patch") {
			return {
				block: true,
				reason:
					"Built-in file tools are disabled in this environment. Use propose_edit (approval-gated) for any file creation or modification.",
			};
		}

		return undefined;
	});

	// -----------------------------------------------------------------------
	// 5. System-prompt guidance
	// -----------------------------------------------------------------------

	pi.on("before_agent_start", async (event) => {
		let custom = "";
		const promptFile = process.env.COCONUT_SYSTEM_PROMPT_FILE;
		if (promptFile) {
			try {
				const text = (await readFile(promptFile, "utf8")).trim();
				if (text.length > 0 && text.length <= MAX_CUSTOM_PROMPT_CHARS) {
					custom = text;
				}
			} catch {
				// No prompt file (or unreadable): the agent runs stock.
			}
		}
		const parts = [event.systemPrompt];
		if (custom) {
			// Custom instructions precede the Coconut guidance so the
			// approval-gate rules keep the final, most salient position.
			parts.push(`## Agent instructions\n\n${custom}`);
		}
		parts.push(COCONUT_GUIDANCE);
		return { systemPrompt: parts.join("\n\n") };
	});

	// -----------------------------------------------------------------------
	// 6. Project trust
	// -----------------------------------------------------------------------

	// Coconut deliberately isolates the agent from project-local pi settings,
	// extensions, and skills (.pi/, .agents/) — untrusted repo content must not
	// be able to weaken the app's approval gates — so trust is always "no".
	pi.on("project_trust", async () => ({ trusted: "no" }));
}
