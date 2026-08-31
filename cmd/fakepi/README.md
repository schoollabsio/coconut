# fakepi

`fakepi` is a scripted, wire-compatible stand-in for `pi --mode rpc`. It
lets custard's Go backend (and integration tests) exercise the full
JSONL protocol — streaming deltas, tool events, and the approval
sub-protocol — without making LLM calls.

## Run

```sh
go run ./cmd/fakepi                                  # canned replies only
go run ./cmd/fakepi -scenario testdata/scenarios/todo-app.json
```

It reads JSONL commands on stdin and writes JSONL responses/events on
stdout (framing per `docs/rpc.md`: split on `\n` only, one trailing `\r`
stripped, 10MB record buffer). Only protocol JSON goes to stdout;
diagnostics go to stderr, so `1>events.jsonl 2>log` is safe.

## Drive it by hand

Paste commands into stdin, one per line:

```json
{"id": "1", "type": "get_state"}
{"id": "2", "type": "prompt", "message": "the delete button in my todo app isn't doing anything"}
{"type": "extension_ui_response", "id": "appr_1", "confirmed": true}
{"id": "3", "type": "get_messages"}
```

Every command gets exactly one `{"type":"response",...}` envelope,
echoing `id` when present. Supported: `prompt`, `steer`, `follow_up`,
`abort`, `new_session`, `get_state`, `get_messages`, `set_session_name`,
`get_session_stats`, `get_commands`, `bash`, plus the stdin side of
`extension_ui_response`. Anything else returns `success:false`.

A prompt (or steer/follow_up) that does not match the scenario's current
`waitFor` gets a small canned flow instead: `agent_start`, two
`text_delta` updates saying `[fakepi] default reply — no scripted step
matched your prompt.`, `message_end`, `turn_end`, `agent_end`,
`agent_settled`. The scenario does not advance.

## Scenario format

```json
{
  "name": "todo-app",
  "steps": [
    {"waitFor": {"command": "prompt", "messageContains": "delete button"}},
    {"emit": {"type": "agent_start"}, "delayMs": 50},
    {"waitForResponse": "appr_1"},
    {"emitIf": {"response": "confirmed", "events": [ ... ]}, "delayMs": 60},
    {"emitIf": {"response": "cancelled", "events": [ ... ]}, "delayMs": 60}
  ]
}
```

Steps execute in order, concurrently with command dispatch (so
`get_state` etc. are still answered while a step blocks). Each step is
exactly one kind:

- **`waitFor`** — block until an inbound command matches. `command`
  matches the pi command type (`steer`/`follow_up` count as `prompt`);
  `messageContains` (one substring) or `messageContainsAll` (array of
  substrings) match the command's `message` field. The matched command
  still gets its normal success response immediately, then the scenario
  resumes.
- **`emit`** — write the given event object to stdout after `delayMs`
  (default 0). Skipped if the `abort` flag is set. On `abort`, the rest
  of the in-flight flow is skipped, any pending `waitForResponse`
  resolves as `"cancelled"`, and the scenario rewinds to the aborted
  flow's `waitFor` — so re-prompting after the abort response replays
  the flow deterministically.
- **`waitForResponse`** — block until an `extension_ui_response` arrives
  with this `id`. The result is `"confirmed"` (response had
  `"confirmed": true`) or `"cancelled"` (anything else, including
  `"cancelled": true` and `confirmed: false`). An `abort` command
  resolves a pending wait as `"cancelled"`.
- **`emitIf`** — emit each event in `events` (each delayed by the step's
  `delayMs`) when the most recent `waitForResponse` result equals
  `response` (`"confirmed"` | `"cancelled"`).

fakepi assembles the streamed assistant message from
`message_start`/`message_update`/`message_end` as it emits them, and
injects the assembled message into `message_end` — so scenarios only
need deltas, and `get_messages` returns sane `AgentMessage` shapes.

## Approval wire contract

All custard edits go through the `propose_edit` tool, which blocks on
approval via pi's extension UI sub-protocol:

1. stdout: `tool_execution_start` for `propose_edit` with the full args.
2. stdout: an `extension_ui_request` event —
   `{"type":"extension_ui_request","id":"appr_N","method":"confirm","title":"custard://propose_edit","message":"<stringified JSON>"}`
   where `message` is a JSON **string** containing
   `{toolCallId, path, what, why, edits:[{oldText,newText}]}`.
3. stdin: the client answers
   `{"type":"extension_ui_response","id":"appr_N","confirmed":true}` to
   approve, or `{"...","cancelled":true}` (or `"confirmed":false`) to
   dismiss.
4. stdout: `tool_execution_end` for the tool call — a success result on
   approve, or a non-error result with text `"user declined"` on
   dismiss.

`show_content` (and `read`) complete without approval.
