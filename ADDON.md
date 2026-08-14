# 🧩 Adding DarkNight Theater to an existing bot

Short answer: **yes — if your existing bot is a Node.js + discord.js v14 bot, you
can add this as a plugin without overwriting anything.** For bots in other
languages (e.g. discord.py) or other libraries, you run it as a **companion
service** instead. Here's the honest breakdown.

---

## The one hard rule about "same Discord + Activities"

A Discord **Activity belongs to one Discord Application**, and an Application has
exactly **one bot token / gateway connection**. So:

- To use the **same bot** and the **same Activity**, the Theater must run
  **in the same process as that bot** (Mode A below). You can't have two
  programs both logged in with the same bot token.
- If you want zero changes to another bot (or it's not Node/discord.js), run the
  Theater as its **own Application + bot** in the same server (Mode B). It adds
  the feature to the server; it just isn't literally the same bot user.

---

## Mode A — Plugin into an existing Node + discord.js v14 bot ✅ (true add-on)

Your bot keeps all its own commands and handlers. This only **adds** an
interaction listener (which ignores anything it doesn't own) and the Theater's
web routes.

**Prerequisites**
- Node 18+, **discord.js v14**.
- Your `Client` includes the **`GuildVoiceStates`** intent.
- A public **HTTPS** host with a web server (Express) — the Activity needs it.
- The **same Discord Application** as your bot, with **Activities enabled** and a
  URL mapping (`/` → your host). Env vars from this repo's `.env.example`
  (`DISCORD_CLIENT_ID/SECRET`, `PUBLIC_BASE_URL`, `SESSION_SECRET`, `MEDIA_DIR`…).
- Install this package's deps in your project (`discord.js`, `express`, `ws`,
  `@napi-rs/canvas`, `gifenc`, `hls.js`, `@discord/embedded-app-sdk`, `vite`) and
  build the Activity once (`npm run build` → `dist/public`).

**Wire it up**

```js
import express from 'express';
import http from 'node:http';
import { Client, GatewayIntentBits } from 'discord.js';
import {
  attachTheater, mountTheaterWeb, theaterCommands, THEATER_INTENTS,
} from 'darknight-home-theater/src/plugin.js'; // path to this repo

// 1) your client — just make sure voice states are included
const client = new Client({
  intents: [GatewayIntentBits.Guilds, ...THEATER_INTENTS, /* ...your intents */],
});

// 2) attach the Theater's interactions to YOUR client (non-destructive)
attachTheater(client);

// 3) mount the Theater web onto YOUR express app + http server
const app = express();
const server = http.createServer(app);
// your own routes here FIRST if you own "/", then:
mountTheaterWeb(app, server);        // serves the Activity at "/"
server.listen(process.env.PORT || 3000);

// 4) register commands: append theaterCommands to your own registration body
//    (REST.put(Routes.applicationCommands(clientId), { body: [...yours, ...theaterCommands] }))

client.login(process.env.DISCORD_BOT_TOKEN);
// keep your own client.on('interactionCreate', ...) — both listeners coexist.
```

**Non-destructive by design**
- `attachTheater` adds a *second* `interactionCreate` listener. It only handles
  the commands/prefixes it owns and **returns silently** on everything else, so
  your handlers keep running.
- Check for collisions — the feature owns these:
  - Commands: `watch`, `join`, `theater`, `library`, `theater-settings`
  - Button/menu id prefixes: `w:`, `ps:`, `t:ctl:`, `set:`, `join:`
  Rename yours (or ask me to namespace these) if any clash.
- If **your app already owns `/`**, mount with `mountTheaterWeb(app, server, { serveActivity: false })`
  and serve the built Activity (`dist/public`) yourself or on a dedicated
  subdomain; point the Discord URL mapping there.

> The `/host` "start party" endpoint uses your bot client to post the control
> panel + Activity invite, so the web routes and the bot must be in the **same
> process** (which this setup is).

---

## Mode B — Companion service (any existing bot, incl. discord.py) ✅

Leave the other bot completely untouched. Run **this repo as-is** as its own
service with its **own Discord Application + bot token**, invited to the same
server.

1. Deploy this repo (Replit/Railway) — see `SETUP.md`.
2. Create a **separate** Discord Application for the Theater (its own bot token +
   client id/secret), enable Activities, add the `/` URL mapping.
3. Invite that bot to your server. Members use `/watch` and `/join` from the
   Theater bot; your existing bot does its own thing side by side.

Pros: zero code changes, works with *any* existing bot. Con: it's a second bot
presence in the server.

---

## What won't "just drop in"

- **discord.py / non-Node bots** — can't embed in-process; use **Mode B**.
- **discord.js v13 or older** — the handlers target v14 builders/enums; upgrade
  the host bot to v14, or use **Mode B**.
- **A bot with no web server / no public HTTPS** — the Activity requires one; add
  Express (Mode A) or use **Mode B**.

---

## TL;DR

| Your situation | Path |
| --- | --- |
| Node + discord.js **v14** bot, want the **same** bot/Activity | **Mode A** (`attachTheater` + `mountTheaterWeb`) |
| Any other bot, or don't want to touch its code | **Mode B** (companion app + bot) |

Want me to publish the plugin as a proper npm package, or namespace the command
names / id prefixes so they can't collide with your existing bot? Just say so.
