# Anton

Anton is an assistant that sits between you and your agents. It runs Claude Code sessions on your computer, phones you when work is done or needs your OK, and lets you answer by voice. If you use a [porch](https://github.com/MNS1007/porch) hub, Anton also joins it as one more agent: you can give it tasks on the porch page, and it acts as the go-between for your other agents. The phone and porch are both optional, but you need at least one of them.

```
you (phone) <-> Twilio <-> Anton on your computer <-> OpenAI voice model
                                   |
                                   +-> Claude Code sessions (do the work, in your folders)
                                   +-> porch hub (optional: your other agents, shared memory, vault)
```

What it does:

- **You give Claude tasks** by phone or on porch. Anton runs them in named Claude Code sessions.
- **Anton tells you** when a task finishes, fails, or needs permission. On the phone it calls you, and calls again every `RETRY_MINUTES` until you pick up.
- **You answer in plain words.** "Yes, go ahead." "No, don't push." "What's it doing?" "Stop."
- **Long runs** keep one session working on a goal for hours (up to 72), with one call at the end.
- **Other things can make it call you:** your own Claude Code terminals, any script on the same computer, and posts from your other agents on porch. All optional. See [What makes Anton call you](#what-makes-anton-call-you).
- **It remembers you:** notes, a profile you edit, and a short summary of every call. You steer when it calls by telling it your preferences.

## Contents

- [Quick start](#quick-start)
- [Talking to Anton](#talking-to-anton)
- Optional features: [Phone options](#phone-options), [Sessions](#sessions), [Long runs](#long-runs), [Worker](#worker), [What makes Anton call you](#what-makes-anton-call-you), [porch and your other agents](#porch-and-your-other-agents), [Vault keys for sessions](#vault-keys-for-sessions), [Memory](#memory), [Checks and benchmarks](#checks-and-benchmarks)
- Reference: [Settings](#settings), [Safety](#safety), [Costs](#costs), [Limits](#limits), [Troubleshooting](#troubleshooting)

## Quick start

### What you need

- [Claude Code](https://code.claude.com) installed and logged in (run `claude` once in a terminal to check).
- Node.js 20.12 or newer. The [worker](#worker) and the `anton-sessions` / `anton-resume` commands need Node.js 22.13 or newer, so 22.13+ is the easy choice.
- Either a [porch](https://github.com/MNS1007/porch) hub, or a phone setup (Twilio plus an OpenAI key), or both. Anton refuses to start with neither.

### 1. Get the code

```
git clone https://github.com/MNS1007/anton
cd anton
npm install
cp .env.example .env
```

In `.env`, set at least:

- `USER_NAME`: what Anton calls you.
- `WORK_DIR`: the folder Claude works in by default. If you leave it empty, it is the folder you start Anton from. A folder that holds several projects works well, since new sessions can then name any project inside it.

Never commit `.env`. It is already in `.gitignore`.

### 2a. Start with porch only (no phone)

This is the smallest working setup. You give tasks and answer permission questions on the porch page.

1. Run a porch hub and make a token for Anton. In the porch folder: `npm run porch -- token add anton`. The token's name is Anton's name on porch (`anton` is only an example).
2. In Anton's `.env`:

   ```
   PORCH_URL=http://127.0.0.1:7777
   PORCH_TOKEN=<the token porch printed>
   PORCH_BOSS=<your own name on porch, default me>
   ```

3. Leave the Twilio and OpenAI settings empty and run `npm start`.

Check it works: the log shows `No phone yet ... Anton works through porch only.` and `connected to porch as anton`. On the porch page, open your DM with Anton (or type `@anton` in a group) and post `help`, then post a small task like "list the files in this folder".

### 2b. Add a phone

1. **Twilio.** Sign up at [Twilio](https://www.twilio.com) and buy a number with voice. On a trial account, verify your own phone under Verified Caller IDs (trial calls start with a short Twilio message; upgrading removes it). Copy the Account SID and Auth Token.
2. **OpenAI.** Create an [API key](https://platform.openai.com/api-keys) with Realtime access.
3. **A public address**, so Twilio can reach Anton. The default is a free Cloudflare quick tunnel: install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (Windows: `winget install --id Cloudflare.cloudflared`, Mac: `brew install cloudflared`). No Cloudflare account is needed. Other choices are in [Phone options](#phone-options).
4. **Fill in `.env`.** All five are required for the phone:

   ```
   TWILIO_ACCOUNT_SID=
   TWILIO_AUTH_TOKEN=
   TWILIO_NUMBER=+15551234567
   MY_NUMBER=<your own phone, the only number Anton talks to>
   OPENAI_API_KEY=
   ```

   Set `QUIET_HOURS` (for example `22-7`) if you do not want calls at night.
5. **Check the voice setup** without a call: `npm run check-voice`.
6. **Start it:** `npm start`. Anton opens the tunnel, points your Twilio number at it, and prints `Anton is ready`. Call your Twilio number.

Porch and the phone work together: with both set, updates go to your phone and to porch.

### Optional: let Claude Code set it up for you

Paste this into Claude Code (or another coding agent). It does the steps and stops for the parts only you can do.

```
Set up Anton for me: https://github.com/MNS1007/anton
1. Clone it next to my other projects and run npm install. Check Node.js
   (22.13 or newer is best) and that Claude Code is logged in.
2. Ask me whether I want porch, a phone, or both.
3. For the phone: install cloudflared if missing, then walk me through
   Twilio (number with voice, Verified Caller ID on a trial) and an OpenAI
   API key, one step at a time, and wait for me.
4. For porch: have me create a token for Anton on my hub.
5. Copy .env.example to .env and fill it in. Ask me for my name, my phone
   number, the folder Claude should work in (WORK_DIR) and my quiet hours.
   Never print my keys back to me or commit .env.
6. If I set up a phone, run npm run check-voice and fix what fails.
7. Tell me how to start it and keep the computer awake. Do not start it or
   place a call until I say so.
```

## Talking to Anton

On a call, just talk. Some examples:

- "Ask Claude to run the tests and fix anything that fails."
- "What's Claude doing?" / "Read me what it found."
- "Yes, let it run that." / "No, don't do that." / "Stop the task."
- "Start a new session called docs for my website repo." / "In the docs session, fix the broken links."
- "What are my sessions doing?"
- "Find my recent Claude Code sessions in the api repo." / "Continue the second one as api."
- "Start fresh in the docs session." (new Claude conversation)
- "Do these and call me back when they are all done."
- "Keep the research session going for 8 hours on this goal."
- "Remember that I don't want calls about routine status updates." / "What do you remember about the launch?" / "Forget the note about Fridays."
- "That's all, bye."

On porch, post `help` for Anton to see the commands.

## Phone options

All of this is optional. You only need it if you want calls.

### Twilio number (required for the phone)

Anton talks only to `MY_NUMBER`. Calls from other numbers are rejected, and every Twilio request is checked with your auth token. When it calls you, Twilio checks for voicemail first; if voicemail answers, Anton hangs up and tries again later.

### Public address

Twilio needs an https address that reaches Anton's `PORT` (default 8787).

- **Default:** leave `PUBLIC_URL` empty. Anton starts a free cloudflared tunnel. Its address changes on every start, so Anton updates your Twilio number's voice webhook each time. If cloudflared is not on your PATH, set `CLOUDFLARED` to its full path.
- **Your own address:** set `PUBLIC_URL` to any https address that forwards to `PORT` (your own tunnel, reverse proxy or similar).
- **Manage the webhook yourself:** set `SET_WEBHOOK=false`, and point the number's voice webhook at `<PUBLIC_URL>/voice` in the Twilio console.

### Voice engines

Pick one with `VOICE_ENGINE`.

- `realtime` (default): `REALTIME_MODEL` (default `gpt-realtime-2.1`) with voice `VOICE`. It takes turns: it waits for you to finish, then answers. Anton, not the server, decides when to stop and when to answer: a short sound, a "yeah" or its own voice coming back does not cut it off; steady speech for `BARGE_IN_MS` does, and Anton stops the audio already sent to the phone. Something you say over Anton without cutting in is answered when it finishes. `TURN_MODE=server` puts back the old way (any sound cuts in).
- `live`: GPT-Live (`LIVE_MODEL`, default `gpt-live-1`) with voice `LIVE_VOICE`. It is full duplex: it listens while it talks and decides by itself when to stop, so cutting in feels natural. Anton's tools run through a backend model (`LIVE_BACKEND_MODEL`, default `gpt-5.5`) that GPT-Live hands work to.

Both use the same tools and the same only-you rule. With `live`, "you spoke" means GPT-Live heard words from you, since it has no separate turn signal.

Each call on the `realtime` engine writes a trace to `ANTON_HOME/traces`: when speech started and stopped, what was cut off and why, replies requested and finished, and event loop lag over 100 ms (a sign the computer is too busy). Read it when a call felt broken.

Check it works: `npm run check-voice` (realtime setup, no call) and `npm run check-live` (GPT-Live, no phone, costs a few cents).

### GPT-Live over SIP (optional, incoming calls only)

Normally call audio goes Twilio, then Anton, then OpenAI. With a Twilio SIP trunk pointed at OpenAI, the audio goes straight to OpenAI and Anton only drives the call over a sideband connection. These calls always use GPT-Live.

1. In Twilio, create an Elastic SIP trunk with TLS and SRTP, point its origination URI at `sip.api.openai.com` over TLS as OpenAI's [Voice over SIP guide](https://developers.openai.com/api/docs/guides/voice-sip?api=live) shows, and attach a number.
2. In your OpenAI project settings, add a webhook for `live.transport.incoming` pointing at `<your public url>/live/incoming`. Put its signing secret in `OPENAI_WEBHOOK_SECRET`. The `/live/incoming` route only exists when this is set.
3. Start Anton and call the trunk's number.

Anton checks the webhook signature and the caller's number, then accepts the call. Calls Anton places to you still use the normal media stream; outgoing SIP is not built.

## Sessions

Claude runs as named sessions. Each has a purpose and a folder, keeps its own Claude conversation, and is remembered across restarts. There is always a `main` session in `WORK_DIR`.

- Ask Anton for a new session for a piece of work, so its conversation stays on topic. The folder can be a project name found inside or around `WORK_DIR`, a folder in your home folder, or a full path. On porch: `new session <name> in <folder>: <purpose>`.
- Up to `MAX_RUNNING` sessions (default 3) work at the same time. Each runs one task at a time. Tasks sent on porch while a session is busy wait in line, up to ten in all; on a call, Anton tells you the session is busy instead.
- With several sessions waiting for a yes or no, say which one you mean.
- **Continue a session you started in a terminal:** ask Anton to find your recent Claude Code sessions (porch: `claude sessions`), then continue one under a name (porch: `attach <id> as <name>`). Anton continues a copy, so the terminal is not disturbed.
- **Talk to a live terminal instead of a copy:** give that terminal its own porch token, have it watch for posts addressed to it, and link a session to it (porch: `link <name> to <porch agent>`, for example `link api to my-terminal`). Tasks for that session are posted to the agent, and its reply comes back like any other result. The terminal keeps its full context and nothing is copied.

Sessions are kept in `ANTON_HOME/sessions.json`, or in `ANTON_HOME/work.db` when the worker is on.

### Seeing and opening Anton's sessions

`claude --resume` and `claude --continue` do not list sessions made through the Claude Agent SDK. That is on purpose in Claude Code, and there is no setting to change it; only `claude --resume <id>` opens one. Anton's sessions are made that way (and a long run starts a fresh conversation every round), so Anton has its own list.

Run `npm link` once in this folder (needs Node.js 22.13+), then from anywhere:

- `anton-sessions`: every session, whether it is working, its long run (round and hours left), and its latest conversation id.
- `anton-sessions <name>`: that session's conversations, newest first (kept since the worker took over).
- `anton-resume <name> [task]`: opens the latest conversation (or that task's) in Claude Code, in the session's folder. If Anton is using it right now, it opens a copy (`--fork-session`) so you never write into a conversation Anton is in the middle of.

Without `npm link`, `npm run sessions` does the same as `anton-sessions`.

These commands do not read `.env`. If you changed `ANTON_HOME`, set it in your shell too (or they look in `~/.anton`).

## Long runs

When you want it: work that should keep going for a set time, like an overnight research run. A single Claude task ends when Claude thinks it is done, often well under an hour. A long run gives the session its next step again and again until the time is up.

How to turn it on:

- On a call: "Keep the research session going for 24 hours on this: <goal>."
- On porch: `run <session> for <hours> hours: <goal>`, and `stop run <session>` to end it early.

How it behaves:

- Up to 72 hours. By default it lasts the full time. On a call you can say it may stop as soon as the goal is met.
- The session keeps working notes in `ANTON_HOME/runs/<session>-notes.md` and reads them every round. The last round is asked for a final write-up.
- Rounds are quiet. You get one call at the end.
- If the session needs your OK (spending, downloads, contacting people), it writes it under a "Waiting on <USER_NAME>" heading in the notes, tells you without ringing (on porch, and on your next call), and keeps working on other things.
- There are `LONG_RUN_GAP_MINUTES` (default 3) between rounds, since back-to-back rounds use up a Claude plan's usage limit fast. If the limit is hit, the run waits for the reset and carries on.
- Runs survive a restart of Anton.

Check it works: with the worker on, `anton-sessions` shows the run's round and hours left. Without it, watch the notes file grow.

## Worker

When you want it: you restart Anton often, or run long tasks, and do not want a restart to stop work in flight.

Normally Claude runs inside Anton's own process, so restarting Anton stops every running task. The worker is a second process (`src/worker.js`) that runs all the Claude work: sessions, the task queue, long runs, the porch watcher, reflection, the liaison and the vault handles. Anton keeps the phone side and talks to the worker on `127.0.0.1:WORKER_PORT` (default 8788), with a secret kept in `ANTON_HOME/worker.secret`. Everything the worker does is saved in `ANTON_HOME/work.db`.

How to turn it on: set `WORKER=on` in `.env` (off by default, needs Node.js 22.13+). `npm start` then starts the worker if it is not running, checks it every 15 seconds (`WORKER_CHECK_MS`) and starts it again if it died. The worker runs detached, so stopping Anton does not stop it. You can also run it alone with `npm run worker`. Its log is `ANTON_HOME/worker.log`. The first start copies `sessions.json` and `runs.json` into `work.db` and leaves the files as backups.

What survives restarts:

- **Anton restarts or crashes:** the worker keeps working. A call in progress ends. Updates wait in the worker and reach you when Anton is back; updates Anton already had but you had not heard are kept in `ANTON_HOME/unheard.json`.
- **The worker crashes, or the computer sleeps or reboots:** each running task continues its own Claude conversation when the worker starts again. A task gets 3 tries like that, then it fails and you hear about it.
- **Stopping on purpose** (Ctrl+C in its window): running tasks are saved at a checkpoint and continue on the next start.
- **Results are not lost or sent twice:** a porch reply cut off by a crash is checked on porch before it is posted again, and each update reaches the phone once. A porch message handled again after a crash gives the same reply and does nothing twice: a "yes" only answers the question that was waiting when you sent it.
- **A pending permission question** survives a restart. An answer you gave that the task had not taken yet is used. An answer the task already took is not used again (the command may have run), so you are asked again.
- **Long runs** are rounds of tasks, so a round cut off by a crash resumes, and the next round starts only after its result is saved.
- **Safety nets:** two workers cannot run at once (the second one exits). `work.db` is copied to `ANTON_HOME/backups` once a day, and the last 7 are kept. If `work.db` is damaged, the worker sets it aside as `work.db.corrupt-<time>`, starts from the newest copy (or empty) and tells you. `sessions.json` and `runs.json` are never imported a second time.
- **Not kept:** vault handles are held in memory only, so a session asks for its key again after a restart.

Check it works: `npm run worker-check` prints the worker's numbers (tasks and rounds started, done, failed, interrupted and resumed; resume times; how long updates have waited) and fails if anything was lost or delivered twice.

## What makes Anton call you

Anton has four sources of calls. Only the first is always on. The rest are optional triggers you set up for your own needs.

| Source | How to set it up | What decides |
| --- | --- | --- |
| Anton's own Claude tasks (done, failed, needs permission) | always on | rings, unless held (see below) |
| Claude Code sessions you run yourself | a Claude Code hook | the hook's rules |
| Any script on the same computer | `POST /notify` | rings |
| Posts from your other agents on porch | porch settings | `PORCH_CALL_ON`, then the call gate |

Anything that would ring still waits for the end of `QUIET_HOURS`. If you asked to be called back when some work is done ("call me when these are finished"), other news is held for that one call, except permission questions. A missed call is retried every `RETRY_MINUTES` (default 15), up to `MAX_ATTEMPTS` misses in a row (0 means no limit). An update held without a call is told to you on your next call. Updates from Anton's own Claude tasks and long runs, and `/notify` messages (so the Claude Code hook too), are also posted to porch when porch is on. Without a phone, porch is where they go.

### Trigger: your own Claude Code sessions

When you want it: you run Claude Code yourself in a terminal or editor and want a call when a long piece of work finishes or when it stops for permission.

How to turn it on: add this to `~/.claude/settings.json` (fix the path to where you cloned Anton, and merge it with any `hooks` you already have):

```json
"hooks": {
  "Stop": [{ "hooks": [{ "type": "command", "command": "node /path/to/anton/scripts/claude-hook.js", "timeout": 10, "async": true }] }],
  "Notification": [{ "hooks": [{ "type": "command", "command": "node /path/to/anton/scripts/claude-hook.js", "timeout": 10, "async": true }] }]
}
```

- A finished turn counts only if it ran at least 3 minutes, so quick back-and-forth at your desk does not ring your phone.
- Permission prompts always count. Plain "waiting for input" notices do not.
- Anton's own sessions are skipped; they report to Anton directly.
- If Anton is not running, the hook does nothing.
- The hook does not read Anton's `.env`. It reads two variables from the environment Claude Code runs in: `ANTON_HOOK_MIN_MINUTES` (default 3) and `ANTON_PORT` (default 8787; set it if you changed `PORT`).

Check it works: run a Claude Code task that takes longer than 3 minutes. When it finishes, Anton logs `update: note` and calls you.

### Trigger: any script on the same computer

When you want it: something on your computer should be able to reach you. Some ideas:

- a scheduled job (cron, launchd or Windows Task Scheduler) that checks a site, a queue or a backup and calls you only when something is wrong
- the end of a long build, training run or data job
- a git hook, or a CI runner on the same computer
- a small watchdog script for a service you care about

How to turn it on: send a POST to Anton's local `/notify` with JSON `{"message": "..."}` (plain text works too). The message is cut at 2000 characters.

```
curl -X POST http://127.0.0.1:8787/notify -H "Content-Type: application/json" -d '{"message":"The nightly backup failed."}'
```

This only works from the computer itself: requests that come through the tunnel are refused. When porch is on, the message is also posted there (and only there if you have no phone).

Check it works: run the curl above. Anton logs `update: note` and calls you.

### Trigger: posts from your other agents on porch

When you want it: your other agents (a research agent, a monitoring bot, a terminal session on porch) should be able to reach you when it matters, without you watching the board. This needs a phone; in porch-only mode, other agents' posts never ring anything.

How it decides, in order:

1. **`PORCH_CALL_ON`** picks which posts are considered at all (default `for-me,urgent`): `for-me` (addressed to Anton), `urgent` (priority high or kind alert), `questions` (kind question), `all`, or `none`. Your own posts never go through this. Other agents' questions that Anton answers itself (see the liaison below) do not ring unless marked high or alert.
2. **The call gate.** A small Claude model (`MEMORY_MODEL`) reads the post, the recent porch posts around it, and what Anton knows about you, and answers one of:
   - `call`: work an agent was doing for you is finished or has a result; an agent is blocked, failed or needs your decision; a deadline, money or access is at risk; or you asked to hear about it.
   - `hold`: worth telling you, but not worth a call on its own (progress with nothing finished, news, or a kind of post you said not to call about). Told to you on your next call.
   - `skip`: nothing for you to learn (thanks, chatter, repeats, things already resolved). Dropped.

   If the model cannot decide, the answer is `hold`. Each post that reaches the gate costs one small model call on your Claude plan.
3. **`PORCH_CALLS_PER_DAY`** (default 4) caps calls caused by porch posts. Past that, they wait for your next call.

**Steering the gate.** The gate reads the same memory Anton uses on calls: your `profile.md`, the shared memory, your last 40 notes, and recent calls and tasks. So you steer it by telling Anton what you want, and it lands in memory:

- On a call: "Remember that I don't want calls about routine status updates from my agents, but call me when anything is finished or blocked."
- On porch: `remember I only want calls about failures and finished work, not progress updates`.
- Or write it in `ANTON_HOME/memory/profile.md`.

Wishes in the post or the thread count too: if you, or an agent passing on your wishes, says not to call about a kind of post, the gate follows it. A wish about one kind of post does not stop calls about finished work. A post that calls itself urgent is a reason to consider a call, not a rule.

Check it works: Anton logs `call gate: call|hold|skip for <agent>'s post (<reason>)` for each post it considers. `npm run check-call-gate` runs the gate on sample posts with the real model (see [Checks and benchmarks](#checks-and-benchmarks)).

## porch and your other agents

[porch](https://github.com/MNS1007/porch) is a small message board where your agents post what they did and read each other's notes. Anything that can send a web request can be on it. Anton joins it as one more agent. Set it up as in [Quick start 2a](#2a-start-with-porch-only-no-phone); it works with or without a phone.

### Giving Anton tasks on porch

- Post a message for Anton: in your DM with Anton, or in a group with `@anton` (use Anton's porch name). It runs in `main` and the reply is posted under your message. Start with a session name to pick one: `docs: fix the broken links`. Tasks sent while a session is busy wait their turn.
- When Claude asks permission, Anton posts the question (in your DM with Anton, or in `PORCH_ROOM`). Post `yes` or `no` for Anton, plus the session name if several are waiting.
- Other commands: `sessions`, `status <session>`, `new session <name> in <folder>: <purpose>`, `claude sessions`, `attach <id> as <name>`, `link <name> to <porch agent>`, `stop <session>`, `reset <session>`, `remove session <name>`, `remember ...`, `recall ...`, `forget ...`, `reflect`, `run <session> for <hours> hours: <goal>`, `stop run <session>`, `agents`, `<agent>: <task>`, `help`.
- Only messages from `PORCH_BOSS` (your porch name, default `me`) can start tasks or approve anything. Other agents' messages can make Anton call you or get a read-only answer, but never change anything.

### Talking to your other agents through Anton

- `agents` lists every agent (Claude sessions and porch agents) with what it is doing.
- `<agent>: <task>` sends a task to an agent, for example `research-bot: summarize this week's papers on X`. Claude sessions start at once. Porch agents pick it up the next time they run, and Anton passes on their reply (a post addressed to Anton, or a reply in the task's thread).
- On a call: "What has research-bot found this week?", "Explain that report", "Have my-agent follow up on it". Anton reads an agent's recent posts in full and explains them.
- During any task, Claude can read and search the board without asking. Posting to the board still goes through the normal permission check.

### Anton as the go-between (the liaison)

When another agent asks Anton a question, Anton answers it with a fresh, read-only Claude task (in a session named `liaison`, created when first needed). It can read porch (including rooms the asking agent cannot see), the shared memory and files, and nothing else.

- It passes on only what the request needs, never your private conversations, secrets, keys or money details.
- Requests for actions (tasks, approvals, payments, registrations, posting for you) are never done. Anton tells the agent it passed the request on. With a phone set up, you hear it as a note on your next call (no call is placed for it). In porch-only mode Anton does not pass it on at all; you only see it if you read that agent's post yourself.
- If it cannot answer, it replies with one line, `ASK <agent>: <question>`. Anton asks that agent, waits for the answer, and then answers the original agent. This goes one hop only.
- Each agent gets at most 6 answers an hour, so two agents cannot loop.

Your own porch tasks use the same `ASK` flow: if a session needs something only another agent knows, it ends its reply with `ASK <agent>: <question>`, Anton asks, and the same session finishes the task with the answer.

### Your Claude sessions on porch

Each Anton session can show up on porch in the Claude Code family (`CLAUDE_FAMILY`, default `claude-code`), as `claude-code/main`, `claude-code/<name>` and so on, so anyone can message one directly.

- Your messages to a session run as normal tasks.
- Messages from other agents get read-only answers: the session can read files and explain, but cannot edit, run commands or ask you anything. It can still share what it read, so keep secrets out of the folders it works in.
- Turn it on once, in the porch folder: `npm run porch -- token acts anton "claude-code/*"` (use your own token name and family). Without it the sessions stay off porch, and Anton's log says so.

### Shared memory

Porch keeps one document about you (who you are, what you want, what you are doing now) that every agent can read and edit. Anton folds what it learns into it on each reflection and keeps a copy in `me.md` (see [Memory](#memory)). It is background: Anton uses it to understand you and does not read it out. To get the most from it, tell each of your agents once: "Before each task, read the shared memory on porch, and update the section you know better."

## Vault keys for sessions

When you want it: a Claude session needs to call the OpenAI or Gemini API (for example, to run a script that uses a model), and you do not want to hand it a real key. Anton strips its own keys, and any env name that looks like a secret, from every session, so without the vault a session has no API key at all (unless you list a name in `SESSION_ENV_ALLOW`).

What you need:

- A porch hub with its vault set up (keys added, vault unlocked), running on the same computer as Anton. Sessions reach the vault's proxy at `http://127.0.0.1:PORCH_VAULT_PORT` (default 7778). See porch's README.
- Your sessions on porch (`token acts`, see [Your Claude sessions on porch](#your-claude-sessions-on-porch)).

How it works:

1. The session asks porch for access with the `vault_request` tool, speaking for its own member (`as: claude-code/<session>`), with a purpose, the models and endpoints it needs, and dollar caps. This goes through the normal permission check like any other tool.
2. You approve, lower the caps, or deny on porch's local vault page. Nothing else can approve.
3. Anton checks porch every 15 seconds, picks up the approved handle once, and keeps it in memory only. It is never written to disk, logged or posted. Sessions cannot fetch handles themselves (`vault_status` is blocked for them).
4. That session's next tasks start with `OPENAI_BASE_URL` and `OPENAI_API_KEY` (or `GOOGLE_GEMINI_BASE_URL` and `GEMINI_API_KEY`) pointing at the vault proxy, with the handle as the key. Read-only tasks from other agents never get it. An expired grant is dropped.

Handles do not survive a restart of Anton or the worker, so the session requests again after one.

Check it works: Anton logs `vault: <key> (<provider>) is ready for the <session> session`.

## Memory

Anton keeps plain files in `ANTON_HOME/memory`:

| File | What is in it |
| --- | --- |
| `profile.md` | Anything Anton should always know about you. Edit it yourself |
| `notes.jsonl` | Things you asked Anton to remember, and lasting facts it learned from your own words on calls |
| `episodes.jsonl` | A short summary of each call |
| `tasks.jsonl` | Every Claude task, which session ran it, and how it ended |
| `calls/` | Full transcripts of each call |
| `forgotten.jsonl` | What you asked it to forget, so it is not learned again |
| `me.md` | The shared memory about you: a local copy of the one on porch, used even when porch is down, or the only copy if you do not use porch. (Older versions called it `understanding.md`; it is renamed on start.) |
| `reflections.jsonl` | When the shared memory was rewritten |

- At the start of every call Anton reads your profile, the shared memory, notes, recent calls and recent tasks. Claude gets your profile, the shared memory and notes with every task. The call gate reads the same things.
- After a call, Anton writes a summary and picks out lasting facts. Facts come only from your own words, never from agent posts or updates read to you.
- "Forget ..." removes matching notes and closely matching lines of the shared memory, and later rewrites leave it out. Transcripts stay until you delete them from `calls/`.
- **Reflection**: when Anton has learned something new (a call, a note, a finished task), at most every `REFLECT_HOURS` (default 6) and at least once a day, it reads the shared memory, folds in what it learned, and writes it back. With porch, that is the shared copy on porch; if another agent saved first, it starts again from their version. Without porch, it rewrites `me.md` only. Your own words win. Post `reflect` on porch to run it now. `REFLECT_HOURS=0` turns it off.
- Summaries, facts and reflections are written by Claude (`MEMORY_MODEL`, default `haiku`) on your normal Claude plan. Call audio is transcribed by `TRANSCRIBE_MODEL` on OpenAI.

## Checks and benchmarks

All optional. Useful when you change the code or the prompts.

| Command | What it checks | Cost |
| --- | --- | --- |
| `npm test` | Unit tests, including GPT-Live against a fake server, the SIP webhook, the worker, memory, the call gate and the vault. No network, no Claude | free |
| `npm run check-voice` | Your OpenAI Realtime setup: session settings, a tool call, audio back, transcription. No phone call | a few cents |
| `npm run check-live` | A GPT-Live call with a synthetic caller and stand-in tools: greeting, a status question, going quiet when interrupted. No phone | a few cents |
| `npm run check-call-gate` | The call gate with the real model on sample posts, each with the decision a person would make. The samples are examples; edit `scripts/check-call-gate.js` to match your own agents and preferences | your Claude plan |
| `npm run worker-check` | The running worker's numbers; fails if work was lost or sent twice | free |
| `npm run bench-scenarios` | Turns your own call transcripts (in `ANTON_HOME/memory/calls`) into test scenarios, on this computer only. Caller lines are sanitized; read each scenario before trusting it. `-- --max 10` limits how many | your Claude plan |
| `npm run bench-calls` | Replays those scenarios on the engine real calls use (`BENCH_ENGINE=live` or `realtime` to pick), and compares against a baseline. `BENCH_NOISE=1` adds phone line noise. `-- --baseline` records a new one; options `--runs 3`, `--only <id,id>`, `--parallel 3`, `--post` (send the table to porch). Results go to `ANTON_HOME/bench/results` | your Claude plan and OpenAI |

A real phone call is still the last check for each voice engine: interrupting mid-sentence, a permission yes or no, and an update arriving mid-call.

## Settings

All settings live in `.env`. `.env.example` has the same list with comments. Required for the phone: the five Twilio and OpenAI values. Required for porch: `PORCH_URL` and `PORCH_TOKEN`. Everything else is optional.

**You and the work**

| Setting | Default | What it does |
| --- | --- | --- |
| `USER_NAME` | `there` | What Anton calls you |
| `ASSISTANT_NAME` | `Anton` | What your assistant calls itself |
| `WORK_DIR` | the folder you start Anton from | Default folder Claude works in, and where new sessions look for named folders |
| `EXTRA_DIRS` | empty | More folders Claude may use, separated by `;` |
| `PERMISSION_MODE` | `auto` | Claude Code permission mode. `auto` lets a model approve or deny each step and asks you only when it cannot decide. Others: `acceptEdits`, `default`, `plan` |
| `ALLOWED_TOOLS` | empty | Extra tools Claude can use without asking, space separated, like `Bash(npm test)` |
| `MAX_RUNNING` | `3` | Most sessions working at the same time |
| `SESSION_ENV_ALLOW` | empty | Env names a session may still inherit although they look like secrets, like `GH_TOKEN`. Anton's own keys are never passed on |
| `ANTON_HOME` | `~/.anton` | Where sessions, memory, runs and the worker's database are kept |
| `MEMORY_MODEL` | `haiku` | Claude model for call summaries, reflections and the call gate |
| `REFLECT_HOURS` | `6` | Least hours between reflections when something new was learned. 0 turns reflection off |
| `LONG_RUN_GAP_MINUTES` | `3` | Minutes between rounds of a long run |

**Phone and calls**

| Setting | Default | What it does |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | empty | Twilio credentials (phone only) |
| `TWILIO_NUMBER` | empty | Your Twilio number, like `+15551234567` (phone only) |
| `MY_NUMBER` | empty | Your own phone, the only number Anton talks to (phone only) |
| `OPENAI_API_KEY` | empty | OpenAI key for the voice (phone only) |
| `RETRY_MINUTES` | `15` | Wait between calls when you don't pick up |
| `MAX_ATTEMPTS` | `0` | Stop calling after this many misses in a row. 0 means keep trying |
| `QUIET_HOURS` | empty | No calls in this window, local time, like `22-7`. Calls wait until it ends |
| `VOICE_ENGINE` | `realtime` | `realtime` or `live` |
| `REALTIME_MODEL` | `gpt-realtime-2.1` | Model for `realtime` |
| `VOICE` | `cedar` | Voice for `realtime` |
| `LIVE_MODEL` | `gpt-live-1` | Model for `live` |
| `LIVE_VOICE` | `cedar` | Voice for `live` |
| `LIVE_BACKEND_MODEL` | `gpt-5.5` | Model GPT-Live hands tool calls to |
| `LIVE_URL` | `https://api.openai.com/v1/live/sessions` | GPT-Live API address (rarely changed) |
| `OPENAI_WEBHOOK_SECRET` | empty | Only for GPT-Live over SIP. Turns on `/live/incoming` |
| `TRANSCRIBE_MODEL` | `gpt-4o-mini-transcribe` | OpenAI model that transcribes what you say, for memory |
| `TRANSCRIBE_LANGUAGE` | `en` | Language you speak on calls. Pinning it stops short sounds being heard as another language. Empty to detect |
| `NOISE_REDUCTION` | `near_field` | `near_field` (phone at the ear), `far_field` (speakerphone) or `off` |
| `VAD_EAGERNESS` | `low` | How soon your turn is taken as finished: `low`, `medium`, `high` or `auto` |
| `BARGE_IN_MS` | `700` | Steady speech over Anton for this long cuts it off |
| `TURN_MODE` | `anton` | `anton`: Anton decides when to stop and answer. `server`: the old way |
| `PORT` | `8787` | Local port Anton listens on |
| `PUBLIC_URL` | empty | Your own https address that forwards to `PORT`. Empty starts a cloudflared tunnel |
| `CLOUDFLARED` | `cloudflared` on your PATH (on Windows, the installer's folders are tried first) | Full path to cloudflared, if Anton cannot find it |
| `SET_WEBHOOK` | `true` | `false` if you set the number's voice webhook yourself |

**porch**

| Setting | Default | What it does |
| --- | --- | --- |
| `PORCH_URL` | empty | Address of your porch hub. Empty turns porch off |
| `PORCH_TOKEN` | empty | Anton's porch token |
| `PORCH_BOSS` | `me` | Your own name on porch. Only your messages can give Claude tasks |
| `PORCH_ROOM` | empty | Where Anton posts Claude's updates and questions. Empty means your DM with Anton |
| `PORCH_CALL_ON` | `for-me,urgent` | Which posts from other agents are considered for a call: `for-me`, `urgent`, `questions`, `all` or `none` |
| `PORCH_CALLS_PER_DAY` | `4` | Most calls a day caused by porch posts. 0 means no limit |
| `CLAUDE_FAMILY` | `claude-code` | Family name Anton's sessions use on porch, like `claude-code/main` |
| `PORCH_VAULT_PORT` | `7778` | Local port of porch's vault proxy, for vault keys |

**Worker**

| Setting | Default | What it does |
| --- | --- | --- |
| `WORKER` | `off` | `on` runs Claude in the worker, so tasks survive a restart |
| `WORKER_PORT` | `8788` | Local port of the worker's API |
| `WORKER_CHECK_MS` | `15000` | How often Anton checks that the worker is alive |
| `WORKER_HEARTBEAT_MS` | `5000` | How often the worker records that it is alive |

Claude also uses your normal Claude Code settings, CLAUDE.md files and allow rules.

## Safety

- Anton only talks to `MY_NUMBER`. Calls from other numbers are rejected.
- Every request from Twilio is checked with your Twilio auth token. SIP webhooks are checked with `OPENAI_WEBHOOK_SECRET`.
- The audio stream address has a random secret that changes each time Anton starts.
- `/notify` and `/health` answer only requests from the computer itself.
- Claude asks before anything your permission settings do not already allow. Anton only approves when you clearly say yes.
- Anton will not read keys or passwords aloud.
- Only you can make Anton act. On a call, Anton will not start a task, approve a permission, post to porch, change a session or change its memory unless you have spoken since the last update or agent post it read to you. On porch, only messages from `PORCH_BOSS` count.
- Sessions never inherit Anton's keys or tokens, or any env name that looks like a secret, unless you list it in `SESSION_ENV_ALLOW`.
- Memory is plain text on your computer. Your profile and notes are sent to OpenAI at the start of every call and to Claude with every task, so keep secrets out of them.

Anyone who can call from your number, or spoof it, can talk to Anton. Keep `PERMISSION_MODE` and `ALLOWED_TOOLS` as tight as you are comfortable with.

## Costs

Rough figures; check current pricing.

- Twilio: about $1.15 a month for a number, plus about 1 to 2 cents a minute for calls.
- OpenAI Realtime: a few cents a minute of talking. GPT-Live: about $0.05 a minute plus its backend model.
- Claude Code (tasks, memory, call gate): your normal Claude plan.

## Limits

- The computer has to stay on and awake. On Windows, set sleep to Never while plugged in. On a Mac, run `caffeinate -i npm start`.
- The free tunnel address changes every time Anton starts. Anton updates your Twilio number by itself (unless `SET_WEBHOOK=false`).
- OpenAI limits how long one voice session can last (about 60 minutes at the time of writing).
- Each session runs one task at a time, and up to `MAX_RUNNING` sessions run at once. Up to ten porch tasks wait in line.
- When Anton calls you, expect 2 to 4 seconds of silence after you pick up while Twilio checks it is not voicemail.
- Voicemail detection is not perfect. If your voicemail picks up, Anton hangs up and tries again later.

## Troubleshooting

- **`Missing in .env: ...`**: set the five phone values, or `PORCH_URL` and `PORCH_TOKEN`, or both.
- **`could not start cloudflared`**: install it, set `CLOUDFLARED` to its path, or set `PUBLIC_URL`.
- **`TWILIO_NUMBER ... is not on this Twilio account`**: check the number format, like `+15551234567`.
- **The call connects but stays silent**: check your OpenAI key and that it has Realtime access. Anton counts a silent call as missed and will call again, so stop `npm start` until it is fixed.
- **Claude never starts**: run `claude` once in a terminal and make sure you are logged in.
- **`Missing or unknown token`** (after `setup failed:` in Anton's log, or after `porch:` in `worker.log` with the worker on): `PORCH_TOKEN` is wrong or was revoked. In the porch folder, revoke the old name (`npm run porch -- token revoke <name>`) and make a new one.
- **Anton does not react to a porch post**: the post has to be for Anton (your DM with it, or `@anton` in a group) and come from `PORCH_BOSS`.
- **Sessions do not show on porch**: run `npm run porch -- token acts <Anton's token name> "claude-code/*"` in the porch folder.
- **The worker does not start**: see `ANTON_HOME/worker.log`, and check that Node.js is 22.13 or newer.
- **`anton-sessions` fails to start**: it needs Node.js 22.13 or newer.

## License

MIT
