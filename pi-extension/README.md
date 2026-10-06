# pi-extension/coconut.ts

The Coconut desktop app runs the real [`pi` coding agent](https://github.com/earendil-works/pi-mono)
as an RPC sidecar. `coconut.ts` is the agent-side enforcement + tooling layer
loaded into that pi process. It is a single TypeScript file — pi loads it via
[jiti](https://github.com/unjs/jiti), so there is no build step and no
`node_modules/` in this directory. Runtime imports are limited to `node:fs`,
`node:path`, `typebox`, and `@earendil-works/pi-coding-agent` (all provided by
the host pi installation).

## How the app launches pi

```bash
PI_CODING_AGENT_DIR=<coconut's isolated agent dir> \
pi --mode rpc --no-extensions \
   -e pi-extension/coconut.ts \
   --tools read,bash,grep,find,ls,propose_edit,show_content
```

- `--mode rpc`: the Go backend drives pi over JSONL on stdin/stdout.
- `--no-extensions`: no user/global/project extensions are auto-discovered;
  only this file (via `-e`) is loaded.
- `--tools ...`: built-in `edit` and `write` are deliberately absent, so
  `propose_edit` is the agent's only file-modification channel.
- `PI_CODING_AGENT_DIR`: isolates pi's state (sessions, settings, auth) inside
  the app's own directory instead of `~/.pi`.

## What each piece does

### 1. `propose_edit` tool (approval-gated file modification)

Parameters: `path`, `what` (short summary), `why` (rationale), and `edits[]`
of `{ oldText, newText }` exact-match replacements, applied sequentially.
A single edit with `oldText: ""` means create/overwrite the whole file with
`newText`.

Flow:

1. Read the target file (if it exists). For an existing file, verify every
   `oldText` occurs in the current content. On mismatch the tool **throws
   before touching `ctx.ui`** — pi turns thrown errors into `isError: true`
   tool results, and the agent is told to re-read the file.
2. Ask the user via the approval wire contract (below).
3. On approval: apply the edits (an `oldText` occurring multiple times
   replaces only the first occurrence, noted in the result), create parent
   directories, write the file, and return `Applied N edit(s) to <path>`.
4. On dismissal: return a non-error result telling the agent not to retry and
   to wait for the user's chat follow-up.

The whole read → confirm → apply → write window runs inside pi's
`withFileMutationQueue` so parallel tool calls cannot interleave writes to the
same file.

### 2. `show_content` tool (content panel channel)

Parameters: `path` + `content` (composed document) or `file` (an existing
file read directly from disk). Displays a document in the app's fenced
content panel. **Not** approval-gated — it only displays and writes nothing
itself: the backend renders the document from the tool call *arguments*
(`path`/`content`/`file` on `tool_execution_start`) and persists it into the
agent's content library (`<workspace>/.coconut/agents/<slug>/content/`), so
every session of the agent can re-open it from the panel's dropdown (newest
first). File-mode entries are snapshot copies; the doc records its
`sourcePath`. The tool result is intentionally tiny.

### 3. Bash gating (`tool_call` hook)

Every `bash` tool call is split into segments on `&&`, `||`, `;`, `|`, and
newlines. Each segment must be whitelisted or it gates for approval:

- Default read-only prefixes: `ls`, `grep`, `find`, `cat`, `head`, `tail`,
  `pwd`, `wc`, `file`, `stat`, `which`, `echo`, `git status`, `git diff`,
  `git log`, `git show`, `git branch`. A segment matches when it starts with a
  prefix followed by end-of-segment or whitespace.
- **`COCONUT_BASH_WHITELIST`**: comma-separated extra prefixes merged into the
  whitelist (e.g. `COCONUT_BASH_WHITELIST="go test,make,npm run"`). The prefix
  `*` allows everything *not dangerous*.
- **Always gated** (never whitelisted): segments starting with `rm`, `rmdir`,
  `unlink`, `sudo`, `mv`, `chmod`, `chown`, `dd`, `mkfs`, or containing any
  `>` outside quotes. The `>` rule is deliberately naive: `2>/dev/null` on an
  otherwise read-only command also gates — a conservative false positive we
  accept instead of parsing shells.

Fully whitelisted commands run silently; anything else asks the user, and a
decline blocks the call with `User declined this command; they may follow up
in chat.`

Limitations (documented in code too): the splitter does not understand shell
quoting/escaping, and command substitution (`$(...)`, backticks) can hide
commands inside a whitelisted prefix. This is an approval heuristic, not a
sandbox — the human approver is the real boundary.

### 4. System-prompt guidance (`before_agent_start`)

Appends a concise **Coconut environment** section to the system prompt on
every run: file modifications MUST go through `propose_edit` (built-in
edit/write don't exist), `propose_edit` blocks on user approval so the agent
should gather context with read/grep first, propose complete well-formed edits
with clear `what`/`why`, never assume approval, use `show_content` for
deliverables the user should read, and stop (rather than retry) after a
dismissed proposal.

Before that guidance, the hook inserts the agent's **custom system prompt**:
a `system-prompt.md` in the agent's directory, pointed at by
`COCONUT_SYSTEM_PROMPT_FILE` (set by the backend at launch). The hook fires
per user prompt and re-reads the file each time, so edits made in the Agents
& sessions dialog apply to the next message with no sidecar restart. Files
over 64 KB are ignored defensively; a missing file is a no-op.

### 5. Project trust (`project_trust`)

Always returns `{ trusted: "no" }`: the app isolates the agent from
project-local pi settings, extensions, and skills (`.pi/`, `.agents/`) so
untrusted repo content cannot weaken the approval gates.

## Approval wire contract

`ctx.ui.confirm(title, message)` in RPC mode surfaces as an
`extension_ui_request` on stdout; the backend answers with an
`extension_ui_response` on stdin. Coconut encodes approvals as:

| Gate          | `title`                 | `message` (stringified JSON)                                          |
| ------------- | ----------------------- | --------------------------------------------------------------------- |
| propose_edit  | `coconut://propose_edit` | `{ "toolCallId", "path", "what", "why", "edits": [{oldText,newText}] }` |
| bash          | `coconut://bash`         | `{ "toolCallId", "command" }`                                          |

Request on stdout (from pi):

```json
{
  "type": "extension_ui_request",
  "id": "uuid-1",
  "method": "confirm",
  "title": "coconut://propose_edit",
  "message": "{\"toolCallId\":\"call_abc\",\"path\":\"src/app.go\",\"what\":\"...\",\"why\":\"...\",\"edits\":[{\"oldText\":\"...\",\"newText\":\"...\"}]}"
}
```

Response on stdin (from the backend) — approve:

```json
{ "type": "extension_ui_response", "id": "uuid-1", "confirmed": true }
```

Dismiss / decline (both reach the extension as `false`):

```json
{ "type": "extension_ui_response", "id": "uuid-1", "confirmed": false }
{ "type": "extension_ui_response", "id": "uuid-1", "cancelled": true }
```

There is no timeout: the request stays open until the user decides.
`confirmed: true` applies the edit / runs the command; anything else leaves
the filesystem untouched and returns a "dismissed, do not retry" tool result
(for `propose_edit`) or blocks the call (for `bash`).

The `toolCallId` correlates the approval with the `tool_execution_start` /
`tool_execution_end` events the backend already renders in its tool-call list.

## Development

Syntax-check after editing (no typecheck/build step required by pi):

```bash
bun build pi-extension/coconut.ts --no-bundle --outfile /dev/null
```
