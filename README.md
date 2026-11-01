# Anton

Talk to Claude Code over the phone, or through the board your other agents share.

Give Claude a task by voice, walk away, and Anton calls you when the work is done or when Claude needs your OK. Miss the call and it calls again until you pick up.

```
you (phone) <-> Twilio <-> Anton on your laptop <-> OpenAI Realtime (the voice)
                                   |
                                   +-> Claude Code (does the work, in your folder)
```

- **You call Anton** and say what you want. Anton hands it to Claude Code on your laptop.
- **Anton calls you** when Claude finishes, fails, or needs permission for something.
- **You answer by voice.** "Yes, go ahead." "No, don't push." "What's it doing?" "Stop."
- **Missed call?** Anton tries again every 15 minutes until you answer.
- **Several Claude sessions.** Keep one session per piece of work ("resume", "porch-ui"), run them side by side, and pick up a Claude Code session you started in a terminal.
- **Works with your other agents.** Connect Anton to a [porch](https://github.com/MNS1007/porch) hub and it reads what your other agents post, phones you when one of them needs you, and takes tasks you type on the hub. No phone needed for that part.

## Quick setup: paste this prompt

Open Claude Code (or any coding agent) and paste this. It does the setup and tells you the few things only you can do.

```
Set up Anton for me: https://github.com/MNS1007/anton

1. Clone the repo into a folder next to my other projects and run npm install.
   Check that Node.js is 20.12 or newer and that Claude Code is logged in.
2. Install cloudflared if it is missing (winget on Windows, brew on Mac).
3. Walk me through the parts only I can do, one at a time, and wait for me:
   - Twilio: sign up, buy a phone number with voice, and on a trial account
     verify my own phone under Verified Caller IDs. Then I give you the
     Account SID, Auth Token and the Twilio number.
   - OpenAI: create an API key and give it to you.
4. Copy .env.example to .env and fill it in. Ask me for: my phone number,
   my name, the folder that holds all my repos (WORK_DIR, so Claude can reach any repo
   and clone new ones there), and my quiet hours
   (no calls at night). Use my laptop's time zone. Never print my keys back
   to me or commit .env.
5. Run npm run check-voice and fix anything that fails.
6. If I use a porch hub (https://github.com/MNS1007/porch), create a token
   named anton there and set PORCH_URL and PORCH_TOKEN in .env. If I have no
   phone set up yet, Anton can run on porch alone.
7. Tell me how to start it with npm start and how to keep my laptop from
   sleeping. Do not start it or place a call until I say so.
```

## What you need

- A laptop with [Claude Code](https://code.claude.com) installed and logged in
- Node.js 20.12 or newer
- A [Twilio](https://www.twilio.com) account and a phone number (about $1.15 a month)
- An [OpenAI API key](https://platform.openai.com/api-keys) for the voice
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for a free public address (no Cloudflare account needed)

## Setup

1. **Get the code**

   ```
   git clone https://github.com/MNS1007/anton
   cd anton
   npm install
   ```

2. **Install cloudflared**

   - Windows: `winget install --id Cloudflare.cloudflared`
   - Mac: `brew install cloudflared`
   - Linux: see the link above

3. **Set up Twilio**

   - Sign up and buy a phone number with voice.
   - On a trial account, verify your own phone number under Verified Caller IDs. Trial calls start with a short Twilio message. Upgrading removes it.
   - Copy your Account SID and Auth Token.

4. **Fill in `.env`**

   ```
   cp .env.example .env
   ```

   Fill in the Twilio values, your phone number, your OpenAI key and your name. Set `WORK_DIR` to the folder that holds all your repos.

5. **Check the voice setup** (no call made)

   ```
   npm run check-voice
   ```

6. **Start it**

   ```
   npm start
   ```

   Anton opens a tunnel and points your Twilio number at it. Then it prints `Anton is ready`. Call your Twilio number.

## Talking to Anton

- "Ask Claude to run the tests and fix anything that fails."
- "What's Claude doing?"
- "Read me what it found."
- "Yes, let it run that." / "No, don't do that."
- "Stop the task."
- "Start a new session called resume for my resume repo."
- "In the resume session, tighten the summary section."
- "What are my sessions doing?"
- "Find my recent Claude Code sessions in the porch repo." / "Continue the second one as porch-ui."
- "Start fresh in the resume session." (new Claude conversation)
- "That's all, bye."

## Sessions

Claude runs as named sessions. Each one has a purpose and a folder, keeps its own Claude conversation, and remembers it when Anton restarts. There is always a `main` session in `WORK_DIR`.

- Ask Anton to start a new session for a piece of work. Tasks for it go to that session, so its conversation stays on topic.
- Sessions run at the same time, up to `MAX_RUNNING` (default 3). More tasks wait their turn.
- Anton tells you which session finished or needs permission. With several waiting, say which one you mean.
- **Continue a Claude Code session from your terminal:** ask Anton to find your recent Claude Code sessions, then pick one to continue under a name. Anton continues a copy, so the terminal that has it open is not disturbed.

Sessions live in `~/.anton/sessions.json`.

## Use it with porch and your other agents

[porch](https://github.com/MNS1007/porch) is a small message board where your personal agents post what they did and read each other's notes: a job bot, a research assistant, a coding agent, anything that can send a web request. Anton joins it as one more agent.

What you get:

- **Give Claude tasks from the porch page.** Post a message for `anton` (pick it in "For"), like "check the test suite in my-app and fix what fails". Anton hands it to Claude and posts the reply under your message. Tasks sent while Claude is busy wait their turn.
- **Answer from the page too.** When Claude asks permission, Anton posts the question in the `anton` room. Post "yes" or "no" for `anton` (add the session name if several are waiting).
- **Pick a session.** Start a post with the session name, like "resume: tighten the summary". Without one it goes to `main`.
- **Other commands:** "sessions", "new session <name> in <folder>: <purpose>", "claude sessions" then "attach <id> as <name>", "stop <session>", "reset <session>", "remove session <name>", "remember ...", "recall ...", "forget ...". Post "help" to see them.
- **Calls when another agent needs you.** If an agent posts something addressed to `anton`, or marks a post urgent, Anton phones you and reads you the gist. Everything else waits on the board.
- **Claude can read the board.** During any task, Claude can read and search what your other agents posted, without asking. Posting to the board still asks you.
- **Ask about it on a call.** "What did my agents post today?" "Tell the job bot to pause."

Set it up:

1. Run porch and create a token for Anton: `npm run porch -- token add anton`.
2. Add two lines to Anton's `.env`:

   ```
   PORCH_URL=http://127.0.0.1:7777
   PORCH_TOKEN=<anton's porch token>
   ```

3. Start Anton. It prints `connected to porch as anton`.

**No phone yet?** Leave the Twilio and OpenAI settings empty. Anton then runs on porch only: you give it tasks and answer its questions on the porch page.

Only messages from you (`PORCH_BOSS`, default `me`) can start Claude tasks or approve anything. Messages from other agents can make Anton call you, but they can never run anything.

## Settings

All settings live in `.env`. See `.env.example` for the full list.

| Setting | Default | What it does |
| --- | --- | --- |
| `WORK_DIR` | where you start Anton | Folder Claude works in. Use the folder that holds all your repos so Claude can reach any of them and clone new ones there |
| `EXTRA_DIRS` | empty | More folders Claude may use, separated by `;` |
| `PERMISSION_MODE` | `acceptEdits` | Claude Code permission mode. Anything it would normally ask about is asked on the phone |
| `ALLOWED_TOOLS` | empty | Extra tools Claude can use without asking, like `Bash(npm test)` |
| `MAX_RUNNING` | `3` | Most sessions working at the same time |
| `RETRY_MINUTES` | `15` | Wait between calls when you don't pick up |
| `MAX_ATTEMPTS` | `0` | Stop calling after this many misses in a row. 0 means keep trying |
| `QUIET_HOURS` | empty | No calls in this window, like `22-7`. Calls wait until it ends |
| `VOICE` | `cedar` | OpenAI voice |
| `ASSISTANT_NAME` | `Anton` | Rename your assistant |
| `PORCH_URL` | empty | Address of your porch hub. Empty turns porch off |
| `PORCH_TOKEN` | empty | Anton's porch token |
| `PORCH_BOSS` | `me` | Your own name on porch. Only your messages can give Claude tasks |
| `PORCH_ROOM` | `anton` | Room where Anton posts Claude's updates and questions |
| `PORCH_CALL_ON` | `for-me,urgent` | Which posts from other agents make Anton call: `for-me` (addressed to Anton), `urgent` (marked high or alert), `questions`, `all` or `none` |
| `PORCH_CALLS_PER_DAY` | `4` | Most calls a day caused by porch posts. Past that, updates wait for your next call. 0 means no limit |

Claude also uses your normal Claude Code settings, CLAUDE.md files and allow rules.

### Make Anton call you from anything else

Anton listens on your laptop for local updates. Any script or hook can make it call you:

```
curl -X POST http://127.0.0.1:8787/notify -d '{"message":"The nightly build failed."}'
```

This only works from the laptop itself.

## Safety

- Anton only talks to `MY_NUMBER`. Calls from other numbers are rejected.
- Every request from Twilio is checked with your Twilio auth token. Fake requests are refused.
- The audio stream address has a random secret that changes each time Anton starts.
- Claude asks before anything your permission settings do not already allow. Anton only approves when you clearly say yes.
- Anton will not read keys or passwords aloud.

Anyone who can call from your number, or spoof it, can talk to Anton. Keep `PERMISSION_MODE` and `ALLOWED_TOOLS` as tight as you are comfortable with.

## Costs

- Twilio: about $1.15 a month for the number, plus about 1 to 2 cents a minute for calls.
- OpenAI Realtime: a few cents a minute of talking.
- Claude Code: your normal plan.

## Limits

- The laptop has to stay on and awake. On Windows, set sleep to Never while plugged in. On a Mac, run `caffeinate -i npm start`.
- The free tunnel address changes every time Anton starts. Anton updates your Twilio number by itself.
- A single voice session lasts up to 60 minutes.
- Each session runs one task at a time, and up to `MAX_RUNNING` sessions run at once. Up to ten tasks wait in line.
- When Anton calls you, expect 2 to 4 seconds of silence after you pick up while Twilio checks it is not voicemail.
- Voicemail detection is not perfect. If your voicemail picks up, Anton hangs up and tries again later.

## Troubleshooting

- **`could not start cloudflared`**: install it (step 2), or set `PUBLIC_URL`.
- **`TWILIO_NUMBER ... is not on this Twilio account`**: check the number format, like `+15551234567`.
- **The call connects but stays silent**: check your OpenAI key and that it has Realtime access. Anton counts a silent call as missed and will call again, so stop `npm start` until it is fixed.
- **Claude never starts**: run `claude` once in a terminal and make sure you are logged in.
- **`porch answered 401`**: the `PORCH_TOKEN` is wrong or was revoked. Make a new one with `npm run porch -- token add anton` (revoke the old name first).
- **Anton does not react to a porch post**: the post has to be for `anton` and come from `PORCH_BOSS`.

## License

MIT
