# Anton worker: work that survives restarts

## Problem

Anton runs Claude tasks inside its own process (src/agent.js calls the Agent SDK's
`query()` and keeps state and callbacks in memory). Any restart or crash of Anton
kills every task in flight, including long-run rounds (vision-24h lost rounds this
way on 2026-11-02), and loses pending permission questions and queued work.

## Design

Two processes, one database.

- **anton-worker** (new, `src/worker.js`, `npm run worker`): the only process that runs
  Claude. It owns sessions, the task queue, long runs, the porch watcher (hub.js),
  reflection, the liaison and the vault handles. It serves a local API on
  127.0.0.1:`WORKER_PORT` (default 8788) with a per-install secret read from
  `ANTON_HOME/worker.secret` (created on first start, never logged).
- **anton** (the existing process, `npm start`): the phone and voice side (Twilio,
  tunnel, GPT-Live, SIP). It no longer runs Claude. Its tools (src/tools.js) call the
  worker API through a thin client with the same function names agent.js exports today,
  so tools.js, agents.js and caller.js change as little as possible.
- **work.db** (`ANTON_HOME/work.db`, node:sqlite): the source of truth. sessions.json and
  runs.json are imported once and then left as backups.

### Tables

- `sessions(name, purpose, dir, claude_session_id, fork_from, porch_agent, created, last_used, last_result)`
- `tasks(id, session, prompt, label, read_only, fresh, status, claude_session_id, attempts, created, started, heartbeat, finished, result, error, deliver_json, delivered)`
  - status: `queued | running | done | failed | interrupted | stopped`
  - `deliver_json` replaces in-memory `onDone` closures: what to do with the result,
    e.g. `{type: 'porch-reply', room, reply_to, to, prefix}`, `{type: 'notify', kind}`,
    `{type: 'longrun', run}`, `{type: 'liaison', message}`, `{type: 'ask-chain', ...}`.
    Delivery runs in the worker after the task ends and is retried until `delivered = 1`.
- `permissions(id, task, tool, input_summary, input_json, status, created, decided, note, used, start)`:
  pending tool approvals, one row per tool call (parallel calls each get one); the worker's
  `canUseTool` waits on a row, Anton (phone or porch) answers by API, the worker polls the
  row. A yes or no answers the session's oldest waiting row. `used` marks an answer a turn
  has taken; `start` is the task start that asked.
- `runs(session, goal, until, rounds, started, notes, last, max_rounds, stop_early, idle, stamp, asks, asks_at, status)`
- `outbox(id, kind, text, ring, created, sent)`: notices for the owner (calls, porch notes).
  The worker hands them to Anton's local `/notify`; if Anton is down they wait and are
  sent when it is back. Porch relays go out directly from the worker.
- `events(ts, kind, task, detail)`: started, heartbeat gaps, interrupted, resumed, done,
  failed, delivered; the basis for the metrics.
- `memo(key, value, n, at)`: the outcome of each step taken while handling a porch message
  (`porch:<id>:<n>`), so a message handled again after a crash gives the same answers and
  replies and changes nothing twice (see Failure modes).

### Execution and checkpoints

- The worker runs up to `MAX_RUNNING` tasks. When a task starts it records the Claude
  session id from the first SDK message, so a task can always be resumed.
- Every 5 s it writes `heartbeat` on running tasks.
- On start (and on a crash restart), any `running` task with a stale heartbeat is marked
  `interrupted` and resumed: the same Claude conversation is continued with
  "Your previous turn was interrupted by a restart. Continue from where you stopped and
  finish: <original label>". Up to 3 attempts, then `failed` with a notice.
- Long runs live entirely in the worker; a round is a task with `deliver: longrun`, so an
  interrupted round resumes instead of being lost, and the next round is scheduled only
  after the round's result is recorded.

### Supervisor

- anton (front) starts the worker detached if its API does not answer, so a front restart
  never stops it, and checks its health every 15 s; a dead worker is restarted, which
  triggers the resume logic.
- The worker can be started on its own (its own minimized window, or at login through a
  Windows scheduled task: that needs the owner's OK).
- Stopping on purpose (`POST /shutdown`, or Ctrl+C) lets running tasks reach a checkpoint
  (marks them `interrupted` cleanly) so they resume on the next start.

## Failure modes

| Failure | What happens |
| --- | --- |
| Front restarts or crashes | Nothing in flight is touched. Calls in progress end; notices wait in the outbox. Notices the front already took but the user has not heard are kept in `ANTON_HOME/unheard.json` and read back on start. |
| Worker crashes mid-task | Claude child process dies; on restart the task is `interrupted` and resumed from its saved conversation. |
| Worker killed during delivery | Result is in the db with `delivered = 0`; delivery is retried on start. Deliveries are idempotent (porch reply keyed by task id). |
| Laptop sleeps or reboots | Same as a crash; resumes on start. |
| Resume keeps failing | 3 attempts, then `failed` and a notice. |
| Permission question pending at restart | The row survives; the resumed task asks again and waits on the same row. An answer that came but was never taken by a turn is used. An answer a turn already took is not reused (that turn may have run the tool), so the owner is asked again, after a kill or a clean stop alike. |
| Worker killed while handling a porch message | The porch cursor moves on only after a message is handled, so it is handled again. Each step's outcome is in `memo`, so it gives the same reply (posted once, keyed) and does nothing twice; a yes or no is bound to the questions waiting when the message came, never to a newer one. |
| A stopped long run's timer fires | Nothing: a round only runs for the current run. A round queued but not started when the run is stopped is dropped. |
| Stop while a task waits to resume | The queued task is stopped before it starts again. |
| Two workers start | The second sees the port or a lock row taken and exits. The lock row counts only if it is recent (not in the future), its pid is alive and that worker answers on its port. |
| db corruption | WAL mode; daily copy of work.db in ANTON_HOME/backups, written under a .tmp name and renamed when complete. A work.db that fails to open or its check is set aside as `work.db.corrupt-<ts>` and the newest backup that opens takes its place (or an empty db); work in flight in the copy is dropped, and the owner gets a notice. The legacy import is marked in `ANTON_HOME/work.imported` too, so a new db never imports sessions.json and runs.json again. |
| worker.secret empty or broken | It is made under a temp name and linked into place, so it only appears complete; an invalid file is replaced. The API refuses everything while the key is not valid, and POSTs that are not JSON. |

## Metrics (worker `/metrics` and `npm run worker-check`)

- rounds and tasks started, done, failed, interrupted, resumed
- lost = interrupted and never resumed or finished (must be 0)
- duplicate deliveries (must be 0)
- resume latency (interruption to resumed)
- outbox age (notices waiting for the front)

Acceptance test (`test/worker-kill.test.js`, with a stub Agent SDK): start the worker,
queue tasks and a long run, kill the front 5 times and the worker 3 times at random
points (mid-task, mid-delivery, mid-permission), then check: every task ends `done`,
no result delivered twice, every long-run round completes once, lost = 0.

## Migration

1. Build the worker behind `WORKER=on` (default off), import sessions.json and runs.json.
2. Run the kill test and a real check: a short real long run survives a front restart
   and a worker kill.
3. Switch on when vision-24h has finished (so its current run is not interrupted by the
   switch itself), then make it the default.
4. Remove the in-process path after a week without issues.
