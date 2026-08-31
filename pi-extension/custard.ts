/**
 * Custard pi extension
 *
 * Agent-side enforcement + tooling layer for the Custard desktop app.
 * Custard runs the real `pi` coding agent as an RPC sidecar:
 *
 *   pi --mode rpc --no-extensions -e custard.ts \
 *      --tools read,bash,grep,find,ls,propose_edit,write_content
 *
 * The Go backend renders its own UI and talks to pi over JSONL RPC, so ALL
 * user interaction here goes through the RPC-bridged extension-UI protocol
 * (ctx.ui.confirm → `extension_ui_request` / `extension_ui_response`).
 *
 * Approval wire contract (parsed by the Go backend — do not change lightly):
 *   - title:   "custard://propose_edit" | "custard://bash"
 *   - message: stringified JSON including the pi toolCallId
 *   - reply:   extension_ui_response with { confirmed: true } approves;
 *              { confirmed: false } or { cancelled: true } dismisses/blocks.
 *
 * Pieces:
 *   1. propose_edit tool — the ONLY way the agent can create/modify files
 *      (built-in edit/write are not in --tools). Gated on user approval.
 *   2. write_content tool — ungated channel for rendering markdown documents
 *      into the app's content panel. Staged OUTSIDE the workspace so it can
 *      never create/modify project files.
 *   3. tool_call hook gating `bash` behind a read-only whitelist + approval,
 *      and hard-blocking built-in edit/write/apply_patch if a pi build ever
 *      activates them despite --tools.
 *   4. before_agent_start — appends "Custard environment" system-prompt guidance.
 *   5. project_trust — always "no": the app isolates the agent from
 *      project-local pi settings/extensions.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ProposeEditParamsSchema = Type.Object({
	path: Type.String({
		description: "Path of the file to modify, relative to the working directory or absolute.",
	}),
	what: Type.String({ description: "Short summary of what the change does (shown to the user)." }),
	why: Type.String({ description: "Rationale for the change (shown to the user)." }),
	edits: Type.Array(
		Type.Object({
			oldText: Type.String({
				description:
					"Exact text to find in the current file. A single edit with an empty oldText creates/overwrites the whole file with newText.",
			}),
			newText: Type.String({ description: "Replacement text." }),
		}),
		{ minItems: 1, description: "Exact-match replacements, applied sequentially in order." },
	),
});
export type ProposeEditParams = Static<typeof ProposeEditParamsSchema>;

const WriteContentParamsSchema = Type.Object({
	path: Type.String({ description: 'Document file name, e.g. "report.md" (staged outside the project tree).' }),
	content: Type.String({ description: "Full document content (usually Markdown)." }),
});
export type WriteContentParams = Static<typeof WriteContentParamsSchema>;

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

// write_content stages documents here — inside pi's agent dir, which custard
// sets to its own isolated config dir — so the ungated render channel can
// never write into the user's project.
const CONTENT_STAGING = join(process.env.PI_CODING_AGENT_DIR ?? tmpdir(), "content");

// Resolve a model-supplied document name into the staging dir, refusing
// anything that would escape it (absolute paths, drive letters, "..").
function stagingPath(name: string): string {
	const cleaned = cleanPath(name).replace(/^([A-Za-z]:)?[\\/]+/, "");
	const parts = cleaned.split(/[\\/]+/).filter((p) => p !== "" && p !== "." && p !== "..");
	if (parts.length === 0) parts.push("content.md");
	const abs = resolve(CONTENT_STAGING, parts.join(sep));
	if (abs !== CONTENT_STAGING && !abs.startsWith(CONTENT_STAGING + sep)) {
		return join(CONTENT_STAGING, "content.md");
	}
	return abs;
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

// ---------------------------------------------------------------------------
// System-prompt guidance
// ---------------------------------------------------------------------------

const CUSTARD_GUIDANCE = `## Custard environment

You are running inside the Custard desktop app. Its environment differs from a stock pi setup:

- The built-in \`edit\` and \`write\` tools do NOT exist here. The ONLY way to create or modify files is the \`propose_edit\` tool.
- \`propose_edit\` blocks on explicit user approval before anything is written, so:
  - Gather context first with \`read\`, \`grep\`, \`find\`, \`ls\` (and read-only \`bash\` commands) before proposing a change.
  - Propose complete, well-formed edits: every \`oldText\` must match the file's current content exactly, and give each proposal a clear \`what\` and \`why\` — the user reads them when deciding.
  - Never assume a proposal was approved; check the tool result.
  - If the user dismisses a proposal, do NOT retry the same edit. Stop and wait — the user will follow up in chat with what to change.
- Use \`write_content\` to render markdown documents (reports, plans, notes, summaries) into the user's content panel. It is the sanctioned channel for deliverables the user should read and is not approval-gated; documents are staged outside the project tree and CANNOT create or modify project files — use \`propose_edit\` for anything that belongs in the project.
- \`bash\` commands outside a read-only whitelist require user approval and anything destructive is always gated. Prefer read-only commands so your work is not interrupted.`;

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Extra comma-separated bash whitelist prefixes from the environment.
	const extraWhitelist = (process.env.CUSTARD_BASH_WHITELIST ?? "")
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
			"Propose a modification to a file. This is the ONLY way to create or modify files in this environment (built-in edit/write are unavailable). Every proposal is shown to the user and applied only if approved. For an existing file, each edit's oldText must match the current file content exactly; edits apply sequentially. To create a new file (or fully overwrite one), pass a single edit with oldText set to the empty string and newText set to the complete file content.",
		promptSnippet: "Propose file edits for user approval (the only file-modification channel)",
		promptGuidelines: [
			"Use propose_edit for EVERY file creation or modification; built-in edit/write tools are not available in this environment.",
			"Use propose_edit only after reading the target file, with oldText matching its current content exactly.",
		],
		parameters: ProposeEditParamsSchema,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const path = cleanPath(params.path);
			const absPath = toAbsolute(ctx.cwd, path);
			const { what, why, edits } = params;

			// Queue the entire read → confirm → apply → write window on the target
			// path so parallel tool calls cannot interleave mutations of one file.
			// (The per-file lock is held while the user decides; acceptable here
			// because approvals are the serialization point Custard wants anyway.)
			return withFileMutationQueue(absPath, async () => {
				const wholeFile = edits.length === 1 && edits[0].oldText === "";

				if (!wholeFile && edits.some((e) => e.oldText === "")) {
					throw new Error(
						`propose_edit: an empty oldText (whole-file create/overwrite) is only allowed as the sole edit; got ${edits.length} edits.`,
					);
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

				// Verify every oldText BEFORE asking the user anything. Throwing marks
				// the tool result isError:true (pi has no isError field on tool results).
				if (current !== null && !wholeFile) {
					const misses: string[] = [];
					for (let i = 0; i < edits.length; i++) {
						if (!current.includes(edits[i].oldText)) {
							misses.push(`edit #${i + 1} oldText not found: "${preview(edits[i].oldText)}"`);
						}
					}
					if (misses.length > 0) {
						throw new Error(
							`propose_edit: ${misses.length} edit(s) do not match the current content of ${path}. Re-read the file and propose against its current content.\n${misses.join("\n")}`,
						);
					}
				}

				// Approval gate — wire contract with the Go backend. No timeout:
				// the request stays open until the user decides.
				const approved = await ctx.ui.confirm(
					"custard://propose_edit",
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
					next = current as string;
					for (let i = 0; i < edits.length; i++) {
						const { oldText, newText } = edits[i];
						const occurrences = countOccurrences(next, oldText);
						if (occurrences === 0) {
							throw new Error(
								`propose_edit: edit #${i + 1} oldText no longer matches after applying earlier edit(s): "${preview(oldText)}"`,
							);
						}
						if (occurrences > 1) {
							// Ambiguous anchor: replace the first occurrence and tell the agent.
							notes.push(`edit #${i + 1}: oldText occurred ${occurrences} times; replaced the first occurrence only`);
						}
						next = replaceFirst(next, oldText, newText);
					}
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
	// 2. write_content — ungated document channel into the app's content panel
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "write_content",
		label: "Write Content",
		description:
			"Render a document (usually Markdown) into the user's content panel. The document is staged OUTSIDE the project tree: this tool cannot create or modify project files (use propose_edit for those). This is the sanctioned, non-gated output channel for deliverables the user should read.",
		promptSnippet: "Render a markdown document into the user's content panel",
		promptGuidelines: [
			"Use write_content for documents the user should read (reports, plans, notes, summaries); it does not create project files — use propose_edit for anything that belongs in the project.",
		],
		parameters: WriteContentParamsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const absPath = stagingPath(params.path);

			await withFileMutationQueue(absPath, async () => {
				await mkdir(dirname(absPath), { recursive: true });
				await writeFile(absPath, params.content, "utf8");
			});

			// Keep the result tiny: the backend renders path/content from the tool
			// call arguments, not from this result.
			return {
				content: [{ type: "text", text: `content rendered to the user's panel (staged outside the project at ${absPath})` }],
				details: { path: params.path },
			};
		},
	});

	// -----------------------------------------------------------------------
	// 3. Bash gating
	// -----------------------------------------------------------------------

	pi.on("tool_call", async (event, ctx) => {
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

		if (event.toolName !== "bash") return undefined;

		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string" || command.trim() === "") return undefined;

		let needsApproval = false;
		for (const rawSegment of splitSegments(command)) {
			const seg = rawSegment.trim();
			if (seg === "") continue;
			// Dangerous segments ALWAYS gate, even with "*" in the whitelist.
			if (isDangerousSegment(seg) || !isWhitelistedSegment(seg, bashWhitelist)) {
				needsApproval = true;
				break;
			}
		}

		if (!needsApproval) return undefined; // fully whitelisted → allow silently

		// Wire contract with the Go backend (see file header). No timeout.
		const ok = await ctx.ui.confirm(
			"custard://bash",
			JSON.stringify({ toolCallId: event.toolCallId, command }),
		);
		if (ok) return undefined; // approved → fall through, let bash run

		return { block: true, reason: "User declined this command; they may follow up in chat." };
	});

	// -----------------------------------------------------------------------
	// 4. System-prompt guidance
	// -----------------------------------------------------------------------

	pi.on("before_agent_start", async (event) => {
		return { systemPrompt: `${event.systemPrompt}\n\n${CUSTARD_GUIDANCE}` };
	});

	// -----------------------------------------------------------------------
	// 5. Project trust
	// -----------------------------------------------------------------------

	// Custard deliberately isolates the agent from project-local pi settings,
	// extensions, and skills (.pi/, .agents/) — untrusted repo content must not
	// be able to weaken the app's approval gates — so trust is always "no".
	pi.on("project_trust", async () => ({ trusted: "no" }));
}
