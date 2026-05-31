# Discord Agent Bot

This project turns a Discord bot into the client for an AI agent. It supports normal chat, slash commands, per-channel memory, and bounded local tools for reading/writing files in `agent_workspace`.

## Features

- Discord client via `discord.js`
- Responds in DMs, when mentioned, with `!agent`, or in configured channel IDs
- Google GenAI provider using `@google/genai`
- Default core model: `gemma-4-31b-it`
- Optional Google Search and URL Context tools for web-style prompts
- Tool calling for local workspace files
- Optional allowlisted shell command tool
- Per-channel conversation history in `data/`
- Slash commands: `/agent`, `/download-images`, `/reset`, `/agent-help`
- Prefix help search: `!help [search]`
- YouTube voice playback through `/suy` and `!play` with button controls
- Spotify link detection in `/suy play` and `!play` by matching tracks to YouTube audio

## Setup

1. Install Node.js 20 or newer.
2. Install the local audio tools:

   ```bash
   # Ubuntu/Debian
   sudo apt-get install ffmpeg pipx
   pipx install yt-dlp
   ```

   On Windows, install `ffmpeg` and `yt-dlp`, or set `FFMPEG_COMMAND` and `YT_DLP_COMMAND` in `.env`.
3. Install dependencies:

   ```bash
   npm install
   ```

4. Copy `.env.example` to `.env` and fill in:

   ```bash
   DISCORD_TOKEN=...
   DISCORD_CLIENT_ID=...
   AI_API_KEY=...
   AI_MODEL=gemma-4-31b-it
   ```

5. In the Discord Developer Portal, enable the `Message Content Intent` for your bot.
6. Register slash commands:

   ```bash
   npm run register
   ```

   For universal multi-server use, leave `DISCORD_GUILD_IDS` empty so commands register globally.
   For fast updates on selected test servers, set `DISCORD_GUILD_IDS` to comma-separated server IDs.

7. Start the bot:

   ```bash
   npm start
   ```

## Ubuntu Docker Deployment

1. Install Docker Engine and the Docker Compose plugin on the Ubuntu server.
2. Copy this project folder to the server.
3. Create `.env` from `.env.example` and fill in real credentials:

   ```bash
   cp .env.example .env
   nano .env
   ```

4. Build the container:

   ```bash
   docker compose build
   ```

5. Register slash commands:

   ```bash
   docker compose run --rm discord-agent-bot npm run register
   ```

6. Start the bot:

   ```bash
   docker compose up -d
   ```

Useful server commands:

```bash
docker compose logs -f
docker compose restart
docker compose down
```

The Compose setup stores conversation history in `./data` and agent-created files in `./agent_workspace` on the host.

## Media Tool Updates

YouTube extraction changes often, so keep `yt-dlp` fresh. The Docker image installs `yt-dlp` directly from the official GitHub source through `pipx` instead of the older Debian or PyPI package.

To refresh the deployed media tools on Ubuntu:

```bash
git pull
docker compose build --pull --no-cache
docker compose up -d
docker compose exec discord-agent-bot yt-dlp --version
```

Or run:

```bash
sh scripts/update-media-tools.sh
```

For non-Docker local runs:

```bash
pipx reinstall yt-dlp --spec "git+https://github.com/yt-dlp/yt-dlp.git"
yt-dlp --version
```

## Discord Usage

- DM the bot directly.
- Mention the bot in a server channel.
- Use `!agent your request`.
- Use `!help` to list commands.
- Use `!help reset` or `!help agent` to search command usage.
- Use `/agent prompt: your request`.
- Use `/agent-help query: reset` to search help from slash commands.
- Use `/suy play query:<url or search>` for YouTube playback.
- Use `!play <url or search>` for quick prefix playback.
- Use `!play <spotify_URL>` or `/suy play query:<spotify_URL>` to queue Spotify links through YouTube audio matches.
- Use `!play full <playlist_URL>` or `/suy play full:true` to queue a full playlist/radio list. Normal playlist/radio input is limited to 26 tracks.
- Set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` to expand Spotify albums/playlists into individual tracks.
- Use the now-playing buttons: previous, pause/play, next, stop, loop, shuffle, and queue.
- Use `/download-images` to save image attachments from the current channel.
- Use `/download-images channel:#gallery limit:500` to scan a specific channel.
- Use `/reset` to clear conversation history for the channel.

If slash commands do not appear, run:

```bash
npm run diagnose:discord
```

Make sure the bot was invited with both `bot` and `applications.commands` scopes. The diagnostic output includes an invite URL with those scopes.

## Multi-Server Setup

Leave these values empty for the most universal setup:

```bash
DISCORD_GUILD_IDS=
ALLOWED_CHANNEL_IDS=
```

With that setup, `npm run register` publishes global slash commands, and the bot can work in any server where it has been invited. Use `ALLOWED_CHANNEL_IDS` only when you want to restrict agent responses to specific channels across one or more servers. Use `ADMIN_USER_IDS` for admin users by Discord user ID; those IDs work across servers.

## Safety Notes

Do not put real credentials in `.env.example`. Keep secrets only in `.env`, which is ignored by git.

The file tools are restricted to `AGENT_WORKSPACE`. The shell tool is disabled unless `ALLOW_SHELL_TOOLS=true`, and even then it only runs commands whose first token is listed in `ALLOWED_COMMANDS`.

For a public server, keep shell execution disabled and use `ALLOWED_CHANNEL_IDS` so the bot only responds where you expect.

Google Search and URL Context are enabled by default with:

```bash
GOOGLE_ENABLE_SEARCH=true
GOOGLE_ENABLE_URL_CONTEXT=true
```

If Google rejects a tool combination for your account or model, the bot retries without URL Context first, then without built-in web tools.

The bot does not combine Google built-in web tools with local function tools in the same model request, because Google currently does not support that combination. Web-style prompts use Google Search/URL Context; local agent prompts use the workspace function tools.
