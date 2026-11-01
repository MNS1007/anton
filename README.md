# Anton

Talk to Claude Code over the phone.

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
   my name, the folder Claude should work in (WORK_DIR), and my quiet hours
   (no calls at night). Use my laptop's time zone. Never print my keys back
   to me or commit .env.
5. Run npm run check-voice and fix anything that fails.
6. Tell me how to start it with npm start and how to keep my laptop from
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

   Fill in the Twilio values, your phone number, your OpenAI key and your name. Set `WORK_DIR` to the project you want Claude to work in.

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
- "Start fresh." (new Claude conversation)
- "That's all, bye."

Claude remembers the conversation between tasks until you say start fresh.

## Settings

All settings live in `.env`. See `.env.example` for the full list.

| Setting | Default | What it does |
| --- | --- | --- |
| `WORK_DIR` | where you start Anton | Folder Claude works in |
| `PERMISSION_MODE` | `acceptEdits` | Claude Code permission mode. Anything it would normally ask about is asked on the phone |
| `ALLOWED_TOOLS` | empty | Extra tools Claude can use without asking, like `Bash(npm test)` |
| `RETRY_MINUTES` | `15` | Wait between calls when you don't pick up |
| `MAX_ATTEMPTS` | `0` | Stop calling after this many misses in a row. 0 means keep trying |
| `QUIET_HOURS` | empty | No calls in this window, like `22-7`. Calls wait until it ends |
| `VOICE` | `cedar` | OpenAI voice |
| `ASSISTANT_NAME` | `Anton` | Rename your assistant |

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
- Claude runs one task at a time.
- When Anton calls you, expect 2 to 4 seconds of silence after you pick up while Twilio checks it is not voicemail.
- Voicemail detection is not perfect. If your voicemail picks up, Anton hangs up and tries again later.

## Troubleshooting

- **`could not start cloudflared`**: install it (step 2), or set `PUBLIC_URL`.
- **`TWILIO_NUMBER ... is not on this Twilio account`**: check the number format, like `+15551234567`.
- **The call connects but stays silent**: check your OpenAI key and that it has Realtime access. Anton counts a silent call as missed and will call again, so stop `npm start` until it is fixed.
- **Claude never starts**: run `claude` once in a terminal and make sure you are logged in.

## License

MIT
