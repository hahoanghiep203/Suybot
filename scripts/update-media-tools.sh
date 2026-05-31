#!/usr/bin/env sh
set -eu

echo "Rebuilding Docker image with the latest yt-dlp from the official GitHub source..."
docker compose build --pull --no-cache
docker compose up -d

echo "Current yt-dlp version in container:"
docker compose exec discord-agent-bot yt-dlp --version
