import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';
import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType
} from '@discordjs/voice';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

const PROVIDER = 'yt';
const BUTTON_PREFIX = `${PROVIDER}:`;
const DEFAULT_PLAYLIST_LIMIT = Number.parseInt(process.env.YT_PLAYLIST_LIMIT || '26', 10);
const DEFAULT_SPOTIFY_LIMIT = Number.parseInt(process.env.SPOTIFY_PLAYLIST_LIMIT || process.env.YT_PLAYLIST_LIMIT || '26', 10);
const QUEUE_PAGE_SIZE = Number.parseInt(process.env.YT_QUEUE_PAGE_SIZE || '10', 10);
const DEFAULT_VOLUME = Number.parseFloat(process.env.YT_DEFAULT_VOLUME || '0.2');
const STOP_DISCONNECT_MS = Number.parseInt(process.env.YT_STOP_DISCONNECT_MS || '10000', 10);
const IDLE_DISCONNECT_MS = Number.parseInt(process.env.YT_IDLE_DISCONNECT_MS || '60000', 10);
const PRIVATE_PREFIX_MESSAGES = ['1', 'true', 'yes', 'on'].includes(
  (process.env.YT_PRIVATE_COMMAND_MESSAGES || 'true').toLowerCase()
);
const PREFIX_DELETE_MS = Number.parseInt(process.env.YT_PREFIX_DELETE_MS || '20000', 10);
const YTDLP_COMMAND = process.env.YT_DLP_COMMAND || 'yt-dlp';
const FFMPEG_COMMAND = process.env.FFMPEG_COMMAND || 'ffmpeg';
const YTDLP_FORMAT = process.env.YT_DLP_FORMAT || 'bestaudio[ext=webm][acodec=opus]/bestaudio[ext=m4a]/bestaudio/best';
const OPUS_BITRATE = process.env.YT_OPUS_BITRATE || '160k';
const MEDIA_TOOL_LOG_LINES = Number.parseInt(process.env.YT_MEDIA_TOOL_LOG_LINES || '5', 10);
const VERBOSE_MEDIA_TOOL_LOGS = ['1', 'true', 'yes', 'on'].includes(
  (process.env.YT_VERBOSE_MEDIA_TOOL_LOGS || 'false').toLowerCase()
);
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';

const states = new Map();
let spotifyTokenCache = null;

function createState(guildId) {
  const state = {
    guildId,
    queue: [],
    history: [],
    loopQueue: [],
    current: null,
    forcedNext: null,
    volume: DEFAULT_VOLUME,
    loop: false,
    textChannelId: null,
    playerMessageId: null,
    ytdlpProcess: null,
    connection: null,
    disconnectTimer: null,
    ffmpegProcess: null,
    player: createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    }),
    client: null
  };

  state.player.on(AudioPlayerStatus.Idle, () => {
    killFfmpeg(state);
    playNext(state.client, guildId).catch((error) => {
      console.error('ytPlay failed to continue playback:', error);
    });
  });

  state.player.on('error', (error) => {
    killFfmpeg(state);
    console.error('ytPlay audio player error:', error);
    playNext(state.client, guildId).catch((nextError) => {
      console.error('ytPlay failed after player error:', nextError);
    });
  });

  states.set(guildId, state);
  return state;
}

function stateFor(guildId) {
  return states.get(guildId) || createState(guildId);
}

function cancelVoiceDisconnect(state) {
  if (state.disconnectTimer) {
    clearTimeout(state.disconnectTimer);
    state.disconnectTimer = null;
  }
}

function scheduleVoiceDisconnect(guildId, delayMs) {
  const state = stateFor(guildId);
  cancelVoiceDisconnect(state);

  state.disconnectTimer = setTimeout(() => {
    state.disconnectTimer = null;
    const latestState = states.get(guildId);
    if (!latestState || latestState.current || latestState.queue.length || latestState.forcedNext) return;

    killFfmpeg(latestState);
    latestState.player.stop(true);

    const connection = getVoiceConnection(guildId) || latestState.connection;
    if (connection) {
      connection.destroy();
    }
    latestState.connection = null;
  }, Math.max(0, delayMs));
}

function requireGuild(source) {
  if (!source.guild) {
    throw new Error('YouTube playback only works inside a server.');
  }
  return source.guild;
}

function sourceClient(source) {
  return source.client;
}

function compactToolOutput(output, maxLines = MEDIA_TOOL_LOG_LINES) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-Math.max(1, maxLines))
    .join('\n');
}

function appendToolOutput(buffer, chunk) {
  const lines = chunk.toString()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  buffer.push(...lines);
  const maxBufferedLines = Math.max(10, MEDIA_TOOL_LOG_LINES * 3);
  if (buffer.length > maxBufferedLines) {
    buffer.splice(0, buffer.length - maxBufferedLines);
  }
}

function logToolExit(toolName, code, signal, outputLines) {
  const detail = compactToolOutput(outputLines.join('\n'));
  const suffix = signal ? `, signal ${signal}` : '';
  console.error(`${toolName} exited with code ${code}${suffix}${detail ? `:\n${detail}` : ''}`);
}

function displayName(source) {
  return source.member?.displayName || source.user?.username || source.author?.username || 'Unknown';
}

async function replyToSource(source, payload, { privateReply = false } = {}) {
  const data = typeof payload === 'string' ? { content: payload } : payload;
  const interactionData = privateReply ? { ...data, flags: MessageFlags.Ephemeral } : data;

  if (typeof source.isRepliable === 'function' && source.isRepliable()) {
    if (!privateReply && typeof source.isButton === 'function' && source.isButton()) {
      if (!source.deferred && !source.replied) {
        await source.deferUpdate();
      }
      return;
    }

    if (source.deferred) {
      await source.editReply(data);
    } else if (source.replied) {
      await source.followUp(interactionData);
    } else {
      await source.reply(interactionData);
    }
    return;
  }

  if (!privateReply || !PRIVATE_PREFIX_MESSAGES) {
    await source.reply(data);
    return;
  }

  try {
    await source.delete();
  } catch {
    // Missing Manage Messages should not block the command.
  }

  const sent = await source.channel.send(data);
  if (PREFIX_DELETE_MS > 0) {
    setTimeout(() => {
      sent.delete().catch(() => {});
    }, PREFIX_DELETE_MS);
  }
}

async function replyPublic(source, payload) {
  await replyToSource(source, payload, { privateReply: false });
}

async function replyPrivate(source, payload) {
  await replyToSource(source, payload, { privateReply: true });
}

async function acknowledgeSilently(source) {
  if (typeof source.isRepliable !== 'function' || !source.isRepliable()) return;

  if (typeof source.isButton === 'function' && source.isButton()) {
    if (!source.deferred && !source.replied) {
      await source.deferUpdate();
    }
    return;
  }

  if (!source.deferred && !source.replied) {
    await source.deferReply({ flags: MessageFlags.Ephemeral });
  }

  await source.deleteReply().catch(() => {});
}

function parseFullQuery(query, full = false) {
  const trimmed = query.trim();
  const parts = trimmed.split(/\s+/, 2);
  if (parts[0]?.toLowerCase() === 'full') {
    return {
      query: trimmed.slice(parts[0].length).trim(),
      full: true
    };
  }
  return { query: trimmed, full };
}

function parseSpotifyInput(input) {
  const uriMatch = input.match(/^spotify:(track|album|playlist):([A-Za-z0-9]+)$/i);
  if (uriMatch) {
    return {
      type: uriMatch[1].toLowerCase(),
      id: uriMatch[2],
      url: `https://open.spotify.com/${uriMatch[1].toLowerCase()}/${uriMatch[2]}`
    };
  }

  const urlMatch = input.match(/https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist)\/([A-Za-z0-9]+)/i);
  if (!urlMatch) return null;

  return {
    type: urlMatch[1].toLowerCase(),
    id: urlMatch[2],
    url: urlMatch[0]
  };
}

function spotifyCredentialsConfigured() {
  return Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET);
}

function normalizeMatchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(official|audio|video|lyrics?|visualizer|remaster(?:ed)?|hd|hq|mv|music)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function meaningfulTokens(value) {
  return normalizeMatchText(value)
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

async function getSpotifyToken() {
  if (!spotifyCredentialsConfigured()) {
    throw new Error('Spotify API credentials are not configured.');
  }

  if (spotifyTokenCache && spotifyTokenCache.expiresAt > Date.now() + 30_000) {
    return spotifyTokenCache.accessToken;
  }

  const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' })
  });

  if (!response.ok) {
    throw new Error(`Spotify token request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  spotifyTokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) * 1000)
  };
  return spotifyTokenCache.accessToken;
}

async function spotifyApi(pathOrUrl) {
  const token = await getSpotifyToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `https://api.spotify.com/v1${pathOrUrl}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Spotify API request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function searchFromSpotifyTrack(track) {
  const artists = (track.artists || []).map((artist) => artist.name).filter(Boolean).join(' ');
  const title = track.name || '';
  const query = `ytsearch8:${artists} ${title} official audio`.trim();
  return {
    query,
    spotify: {
      title,
      artists,
      duration: Number.isFinite(track.duration_ms) ? Math.round(track.duration_ms / 1000) : null
    }
  };
}

async function resolveSpotifyWithOembed(spotify) {
  const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(spotify.url)}`);
  if (!response.ok) {
    throw new Error(`Spotify oEmbed request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return {
    queries: [`ytsearch8:${data.title || spotify.url} official audio`],
    notice: 'Spotify API credentials are not set, so I matched this Spotify track from embed metadata only. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET for better track/playlist matching.'
  };
}

async function resolveSpotifyTrack(id) {
  const track = await spotifyApi(`/tracks/${id}`);
  return {
    queries: [searchFromSpotifyTrack(track)],
    notice: null
  };
}

async function resolveSpotifyAlbum(id, full) {
  const limit = full ? Number.POSITIVE_INFINITY : DEFAULT_SPOTIFY_LIMIT;
  const queries = [];
  let next = `/albums/${id}/tracks?limit=50`;
  let total = 0;

  while (next && queries.length < limit) {
    const page = await spotifyApi(next);
    total = page.total || total;
    for (const track of page.items || []) {
      if (queries.length >= limit) break;
      queries.push(searchFromSpotifyTrack(track));
    }
    next = page.next;
  }

  return {
    queries,
    notice: total > queries.length
      ? `Spotify album input is limited to ${DEFAULT_SPOTIFY_LIMIT}. Use \`!play full <album_URL>\` or \`/suy play full:true\` for the full album.`
      : null
  };
}

async function resolveSpotifyPlaylist(id, full) {
  const limit = full ? Number.POSITIVE_INFINITY : DEFAULT_SPOTIFY_LIMIT;
  const queries = [];
  let next = `/playlists/${id}/tracks?limit=50&fields=items(track(type,name,duration_ms,artists(name),is_local)),next,total`;
  let total = 0;

  while (next && queries.length < limit) {
    const page = await spotifyApi(next);
    total = page.total || total;
    for (const item of page.items || []) {
      const track = item.track;
      if (queries.length >= limit) break;
      if (!track || track.type !== 'track' || track.is_local) continue;
      queries.push(searchFromSpotifyTrack(track));
    }
    next = page.next;
  }

  return {
    queries,
    notice: total > queries.length
      ? `Spotify playlist input is limited to ${DEFAULT_SPOTIFY_LIMIT}. Use \`!play full <playlist_URL>\` or \`/suy play full:true\` for the full playlist.`
      : null
  };
}

async function resolveSpotifyToYoutubeQueries(query, full = false) {
  const spotify = parseSpotifyInput(query);
  if (!spotify) {
    return {
      queries: [`${query} official audio`],
      notice: null
    };
  }

  if (!spotifyCredentialsConfigured()) {
    if (spotify.type !== 'track') {
      throw new Error('Spotify album/playlist links require SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET so the bot can expand the track list.');
    }
    return resolveSpotifyWithOembed(spotify);
  }

  if (spotify.type === 'track') {
    return resolveSpotifyTrack(spotify.id);
  }
  if (spotify.type === 'album') {
    return resolveSpotifyAlbum(spotify.id, full);
  }
  if (spotify.type === 'playlist') {
    return resolveSpotifyPlaylist(spotify.id, full);
  }

  return resolveSpotifyWithOembed(spotify);
}

function isPlaylistQuery(query) {
  const lowered = query.toLowerCase();
  return lowered.includes('list=') || lowered.includes('/playlist?') || lowered.includes('start_radio=1');
}

function ytdlpArgs(query, { playlist = false, fullPlaylist = false } = {}) {
  const args = [
    '--no-warnings',
    '--source-address',
    '0.0.0.0',
    '--default-search',
    'ytsearch',
    '--format',
    YTDLP_FORMAT
  ];

  if (process.env.YT_DLP_COOKIES) {
    args.push('--cookies', process.env.YT_DLP_COOKIES);
  }

  args.push('--dump-single-json');
  if (playlist) {
    args.push('--flat-playlist');
    if (!fullPlaylist) {
      args.push('--playlist-end', String(DEFAULT_PLAYLIST_LIMIT));
    }
  } else {
    args.push('--no-playlist');
  }

  args.push(query);
  return args;
}

function ytdlpPipeArgs(query) {
  const args = [
    '--no-warnings',
    '--source-address',
    '0.0.0.0',
    '--default-search',
    'ytsearch',
    '--format',
    YTDLP_FORMAT,
    '--no-playlist',
    '--retries',
    '10',
    '--fragment-retries',
    '10',
    '--output',
    '-'
  ];

  if (process.env.YT_DLP_COOKIES) {
    args.push('--cookies', process.env.YT_DLP_COOKIES);
  }

  args.push(query);
  return args;
}

async function runYtdlpJson(query, options) {
  try {
    const { stdout } = await execFileAsync(YTDLP_COMMAND, ytdlpArgs(query, options), {
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true
    });
    return JSON.parse(stdout);
  } catch (error) {
    const detail = compactToolOutput(error.stderr || error.message || String(error));
    throw new Error(`yt-dlp failed: ${detail.trim()}`);
  }
}

function webpageUrlFromEntry(entry, fallback) {
  if (entry.webpage_url) return entry.webpage_url;
  if (entry.original_url) return entry.original_url;
  if (entry.url?.startsWith('http')) return entry.url;
  if (entry.id) return `https://www.youtube.com/watch?v=${entry.id}`;
  if (entry.url) return `https://www.youtube.com/watch?v=${entry.url}`;
  return fallback;
}

function trackFromInfo(info, requestedBy, fallbackUrl) {
  return {
    title: info.title || 'Unknown title',
    webpageUrl: webpageUrlFromEntry(info, fallbackUrl),
    requestedBy,
    uploader: info.uploader || info.channel || null,
    thumbnailUrl: info.thumbnail || null,
    duration: Number.isFinite(info.duration) ? info.duration : null
  };
}

function scoreSpotifyCandidate(entry, spotify) {
  const candidateTitle = normalizeMatchText(entry.title);
  const candidateText = normalizeMatchText(`${entry.title || ''} ${entry.uploader || ''} ${entry.channel || ''}`);
  const targetTitleTokens = meaningfulTokens(spotify.title);
  const artistTokens = meaningfulTokens(spotify.artists);
  let score = 0;

  for (const token of targetTitleTokens) {
    if (candidateTitle.includes(token)) score += 4;
  }

  for (const token of artistTokens) {
    if (candidateText.includes(token)) score += 5;
  }

  const titleText = normalizeMatchText(spotify.title);
  if (titleText && candidateTitle.includes(titleText)) score += 20;

  if (spotify.duration && Number.isFinite(entry.duration)) {
    const diff = Math.abs(entry.duration - spotify.duration);
    if (diff <= 2) score += 25;
    else if (diff <= 5) score += 15;
    else if (diff <= 10) score += 5;
    else if (diff >= 30) score -= 20;
  }

  const penaltyWords = ['cover', 'karaoke', 'instrumental', 'nightcore', 'sped up', 'slowed', 'reaction'];
  const targetText = normalizeMatchText(`${spotify.title} ${spotify.artists}`);
  for (const word of penaltyWords) {
    if (candidateText.includes(word) && !targetText.includes(word)) score -= 15;
  }

  if (candidateText.includes('topic') || candidateText.includes('official')) score += 3;
  return score;
}

function chooseSpotifyCandidate(entries, spotify) {
  const candidates = entries.filter(Boolean);
  if (!spotify || !candidates.length) return candidates[0] || null;
  return candidates
    .map((entry) => ({ entry, score: scoreSpotifyCandidate(entry, spotify) }))
    .sort((a, b) => b.score - a.score)[0]?.entry || candidates[0];
}

async function extractTracks(query, requestedBy, fullPlaylist = false, match = null) {
  const playlist = isPlaylistQuery(query);
  const info = await runYtdlpJson(query, { playlist, fullPlaylist });

  if (Array.isArray(info.entries)) {
    if (match && !playlist) {
      const selected = chooseSpotifyCandidate(info.entries, match);
      return {
        tracks: selected ? [trackFromInfo(selected, requestedBy, query)] : [],
        limited: false
      };
    }

    const entries = playlist ? info.entries : info.entries.slice(0, 1);
    const tracks = entries
      .filter(Boolean)
      .map((entry) => trackFromInfo(entry, requestedBy, query))
      .filter((track) => track.webpageUrl);

    return {
      tracks,
      limited: playlist && !fullPlaylist && tracks.length >= DEFAULT_PLAYLIST_LIMIT
    };
  }

  return {
    tracks: [trackFromInfo(info, requestedBy, query)],
    limited: false
  };
}

async function refreshTrackInfo(track) {
  const info = await runYtdlpJson(track.webpageUrl, { playlist: false });

  track.title = info.title || track.title;
  track.webpageUrl = info.webpage_url || track.webpageUrl;
  track.uploader = info.uploader || info.channel || track.uploader;
  track.thumbnailUrl = info.thumbnail || track.thumbnailUrl;
  track.duration = Number.isFinite(info.duration) ? info.duration : track.duration;

  return track;
}

async function ensureVoice(source) {
  const guild = requireGuild(source);
  const member = source.member;
  const voiceChannel = member?.voice?.channel;

  if (!voiceChannel) {
    throw new Error('Join a voice channel first.');
  }

  const state = stateFor(guild.id);
  state.client = sourceClient(source);
  cancelVoiceDisconnect(state);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true
  });

  state.connection = connection;
  connection.subscribe(state.player);
  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  return connection;
}

function killFfmpeg(state) {
  if (state.ytdlpProcess && !state.ytdlpProcess.killed) {
    state.ytdlpProcess.kill('SIGKILL');
  }
  state.ytdlpProcess = null;

  if (state.ffmpegProcess && !state.ffmpegProcess.killed) {
    state.ffmpegProcess.kill('SIGKILL');
  }
  state.ffmpegProcess = null;
}

function createFfmpegResource(state, track) {
  killFfmpeg(state);

  const ytdlp = spawn(
    YTDLP_COMMAND,
    ytdlpPipeArgs(track.webpageUrl),
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  const ffmpeg = spawn(
    FFMPEG_COMMAND,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-vn',
      '-acodec',
      'libopus',
      '-application',
      'audio',
      '-b:a',
      OPUS_BITRATE,
      '-vbr',
      'on',
      '-compression_level',
      '10',
      '-frame_duration',
      '20',
      '-f',
      'ogg',
      '-ar',
      '48000',
      '-ac',
      '2',
      'pipe:1'
    ],
    {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    }
  );

  ytdlp.stdout.pipe(ffmpeg.stdin);

  ytdlp.stdout.on('error', () => {});
  ffmpeg.stdin.on('error', () => {});

  const ytdlpOutput = [];
  const ffmpegOutput = [];

  ytdlp.stderr.on('data', (chunk) => {
    appendToolOutput(ytdlpOutput, chunk);
    if (VERBOSE_MEDIA_TOOL_LOGS) {
      const text = compactToolOutput(chunk.toString());
      if (text) console.error(`yt-dlp: ${text}`);
    }
  });

  ytdlp.on('error', (error) => {
    console.error('Failed to start yt-dlp:', error);
    state.player.stop(true);
  });

  ytdlp.on('close', (code, signal) => {
    if (code && state.ytdlpProcess === ytdlp) {
      logToolExit('yt-dlp', code, signal, ytdlpOutput);
    }
  });

  ffmpeg.stderr.on('data', (chunk) => {
    appendToolOutput(ffmpegOutput, chunk);
    if (VERBOSE_MEDIA_TOOL_LOGS) {
      const text = compactToolOutput(chunk.toString());
      if (text) console.error(`ffmpeg: ${text}`);
    }
  });

  ffmpeg.on('error', (error) => {
    console.error('Failed to start ffmpeg:', error);
    state.player.stop(true);
  });

  ffmpeg.on('close', (code, signal) => {
    if (code && state.ffmpegProcess === ffmpeg) {
      logToolExit('ffmpeg', code, signal, ffmpegOutput);
    }
    if (state.ytdlpProcess === ytdlp && !ytdlp.killed) {
      ytdlp.kill('SIGKILL');
    }
  });

  state.ytdlpProcess = ytdlp;
  state.ffmpegProcess = ffmpeg;

  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.OggOpus,
    inlineVolume: true,
    metadata: track
  });
  resource.volume?.setVolume(state.volume);
  return resource;
}

async function playNext(client, guildId) {
  const state = stateFor(guildId);
  if (!client || !state.connection) return;

  const previousTrack = state.current;
  let track = null;
  let recycledLoopQueue = false;

  if (state.forcedNext) {
    track = state.forcedNext;
    state.forcedNext = null;
    state.loopQueue = state.loopQueue.filter((queuedTrack) => queuedTrack !== track);
  } else if (state.queue.length) {
    track = state.queue.shift();
  } else if (state.loop && previousTrack) {
    const loopTracks = [...state.loopQueue, previousTrack];
    state.loopQueue = [];
    state.queue = loopTracks;
    track = state.queue.shift();
    recycledLoopQueue = true;
  }

  if (!track) {
    if (!state.loop) {
      state.loopQueue = [];
    }
    if (previousTrack) {
      await closePlayerPanel(client, guildId, {
        title: 'Queue Ended',
        description: 'Playback ended.'
      });
    }
    state.current = null;
    killFfmpeg(state);
    scheduleVoiceDisconnect(guildId, IDLE_DISCONNECT_MS);
    return;
  }

  if (previousTrack && previousTrack !== track) {
    state.history.push(previousTrack);
    state.history = state.history.slice(-50);
    if (!recycledLoopQueue) {
      state.loopQueue.push(previousTrack);
    }
  }

  state.current = track;
  cancelVoiceDisconnect(state);

  try {
    await refreshTrackInfo(track);
    const resource = createFfmpegResource(state, track);
    state.connection.subscribe(state.player);
    state.player.play(resource);
    await sendPlayerPanel(client, guildId, track);
  } catch (error) {
    await sendPlaybackError(client, state, track, error);
    await playNext(client, guildId);
  }
}

async function sendPlaybackError(client, state, track, error) {
  if (!state.textChannelId) return;
  try {
    const channel = await client.channels.fetch(state.textChannelId);
    const message = await channel.send(`Could not play **${track.title}**: ${error.message}`);
    setTimeout(() => message.delete().catch(() => {}), PREFIX_DELETE_MS);
  } catch {
    // The player can continue even if the status message cannot be sent.
  }
}

function buildClosedPlayerEmbed({ title, description }) {
  return new EmbedBuilder()
    .setColor(0x808080)
    .setTitle(title)
    .setDescription(description);
}

function formatDuration(seconds) {
  if (!seconds) return 'Unknown';
  const total = Math.floor(seconds);
  const sec = total % 60;
  const minTotal = Math.floor(total / 60);
  const min = minTotal % 60;
  const hours = Math.floor(minTotal / 60);
  return hours ? `${hours}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${min}:${String(sec).padStart(2, '0')}`;
}

function playbackStatus(state) {
  if (
    state.player.state.status === AudioPlayerStatus.Paused
    || state.player.state.status === AudioPlayerStatus.AutoPaused
  ) {
    return '⏸️ Paused';
  }
  if (
    state.player.state.status === AudioPlayerStatus.Playing
    || state.player.state.status === AudioPlayerStatus.Buffering
    || state.current
  ) {
    return '▶️ Playing';
  }
  return '⏹️ Stopped';
}

function buildPlayerEmbed(state, track) {
  const embed = new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle('Now Playing')
    .setDescription(`[${track.title}](${track.webpageUrl})\n\nUse the buttons below to control playback.`)
    .addFields(
      { name: 'Requested by', value: track.requestedBy, inline: true },
      { name: 'Status', value: playbackStatus(state), inline: true },
      { name: 'Volume', value: `${Math.round(state.volume * 100)}%`, inline: true },
      { name: 'Loop', value: state.loop ? 'Playlist' : 'Off', inline: true },
      { name: 'Duration', value: formatDuration(track.duration), inline: true },
      { name: 'Queued', value: String(state.queue.length), inline: true },
      { name: 'Channel', value: (track.uploader || 'Unknown').slice(0, 1024), inline: true }
    );

  return embed;
}

function playerControls(guildId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}player:previous:${guildId}`).setEmoji('⏮️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}player:toggle:${guildId}`).setEmoji('⏯️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}player:next:${guildId}`).setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}player:stop:${guildId}`).setEmoji('⏹️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}player:loop:${guildId}`).setEmoji('🔁').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}player:shuffle:${guildId}`).setEmoji('🔀').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}queue:show:${guildId}:1`).setEmoji('🎶').setStyle(ButtonStyle.Success)
    )
  ];
}

async function sendPlayerPanel(client, guildId, track) {
  const state = stateFor(guildId);
  if (!state.textChannelId) return;

  const channel = await client.channels.fetch(state.textChannelId);
  const payload = {
    embeds: [buildPlayerEmbed(state, track)],
    components: playerControls(guildId)
  };

  if (state.playerMessageId) {
    try {
      const message = await channel.messages.fetch(state.playerMessageId);
      await message.edit(payload);
      return;
    } catch {
      state.playerMessageId = null;
    }
  }

  const message = await channel.send(payload);
  state.playerMessageId = message.id;
}

async function refreshPlayerPanel(client, guildId) {
  const state = stateFor(guildId);
  if (!client || !state.current || !state.playerMessageId) return;
  await sendPlayerPanel(client, guildId, state.current);
}

async function closePlayerPanel(client, guildId, { title, description }) {
  const state = stateFor(guildId);
  if (!state.textChannelId || !state.playerMessageId) return;

  try {
    const channel = await client.channels.fetch(state.textChannelId);
    const message = await channel.messages.fetch(state.playerMessageId);
    await message.edit({
      embeds: [buildClosedPlayerEmbed({ title, description })],
      components: []
    });
  } catch {
    // A missing or deleted panel should not block playback cleanup.
  } finally {
    state.playerMessageId = null;
  }
}

function formatQueue(state, page = 1) {
  const totalPages = Math.max(1, Math.ceil(state.queue.length / QUEUE_PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const start = (currentPage - 1) * QUEUE_PAGE_SIZE;
  const visible = state.queue.slice(start, start + QUEUE_PAGE_SIZE);

  const lines = ['**YouTube Queue**'];
  lines.push(state.current ? `Now: **${state.current.title}**` : 'Now: Nothing playing');

  if (visible.length) {
    visible.forEach((track, index) => {
      lines.push(`${start + index + 1}. ${track.title} - ${track.requestedBy}`);
    });
  } else {
    lines.push('No queued tracks.');
  }

  lines.push(`Page ${currentPage}/${totalPages}`);
  return {
    content: lines.join('\n'),
    page: currentPage,
    totalPages
  };
}

function queueControls(guildId, page, totalPages) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}queue:page:${guildId}:${page - 1}`)
        .setEmoji('⬅️')
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 1),
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}queue:page:${guildId}:${page}`)
        .setEmoji('🔄')
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}queue:page:${guildId}:${page + 1}`)
        .setEmoji('➡️')
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages)
    )
  ];
}

export async function queueYoutubeQueries(source, queries, options = {}) {
  const {
    fullPlaylist = false,
    serviceName = 'YouTube',
    extraNotice = null
  } = options;
  const guild = requireGuild(source);
  const state = stateFor(guild.id);
  state.client = sourceClient(source);
  state.textChannelId = source.channelId || source.channel?.id;

  await ensureVoice(source);

  const parsedQueries = queries
    .map((item) => {
      if (typeof item === 'object' && item?.query) {
        return {
          query: item.query,
          full: fullPlaylist,
          match: item.spotify || null
        };
      }
      return {
        ...parseFullQuery(String(item), fullPlaylist),
        match: null
      };
    })
    .filter((parsed) => parsed.query);

  if (!parsedQueries.length) {
    await replyPublic(source, 'Give me a YouTube URL or search text.');
    return;
  }

  const allTracks = [];
  let limited = false;

  for (const parsed of parsedQueries) {
    const extracted = await extractTracks(parsed.query, displayName(source), parsed.full, parsed.match);
    allTracks.push(...extracted.tracks);
    limited = limited || extracted.limited;
  }

  if (!allTracks.length) {
    await replyPublic(source, 'No playable YouTube tracks found.');
    return;
  }

  state.queue.push(...allTracks);

  const lines = allTracks.length === 1
    ? [`Queued: **${allTracks[0].title}**`]
    : [`Queued ${allTracks.length} ${serviceName} tracks.`];

  if (limited) {
    lines.push(`Playlist/radio input is limited to ${DEFAULT_PLAYLIST_LIMIT}. Use \`!play full <playlist_URL>\` or \`/suy play full:true\` for the full list.`);
  }

  if (extraNotice) {
    lines.push(extraNotice);
  }

  await replyPublic(source, lines.join('\n'));

  if (state.player.state.status === AudioPlayerStatus.Playing || state.player.state.status === AudioPlayerStatus.Paused) {
    await refreshPlayerPanel(sourceClient(source), guild.id);
  } else {
    await playNext(sourceClient(source), guild.id);
  }
}

async function handlePlay(source, query, fullPlaylist = false) {
  const parsed = parseFullQuery(query, fullPlaylist);

  if (parseSpotifyInput(parsed.query)) {
    const resolved = await resolveSpotifyToYoutubeQueries(parsed.query, parsed.full);
    return queueYoutubeQueries(source, resolved.queries, {
      serviceName: 'Spotify',
      extraNotice: resolved.notice
    });
  }

  return queueYoutubeQueries(source, [query], { fullPlaylist, serviceName: 'YouTube' });
}

async function handleJoin(source) {
  const guild = requireGuild(source);
  const connection = await ensureVoice(source);
  const state = stateFor(guild.id);
  if (!state.current && !state.queue.length) {
    scheduleVoiceDisconnect(guild.id, IDLE_DISCONNECT_MS);
  }
  await replyPublic(source, `Joined <#${connection.joinConfig.channelId}>.`);
}

async function handleLeave(source) {
  const guild = requireGuild(source);
  const state = stateFor(guild.id);
  cancelVoiceDisconnect(state);
  state.queue = [];
  state.loopQueue = [];
  state.current = null;
  state.forcedNext = null;
  killFfmpeg(state);
  state.player.stop(true);

  const connection = getVoiceConnection(guild.id) || state.connection;
  if (connection) {
    connection.destroy();
  }
  states.delete(guild.id);
  await replyPublic(source, 'Disconnected and cleared the queue.');
}

async function handleTogglePause(source) {
  const state = stateFor(requireGuild(source).id);
  if (state.player.state.status === AudioPlayerStatus.Paused) {
    state.player.unpause();
    await refreshPlayerPanel(sourceClient(source), requireGuild(source).id);
    await acknowledgeSilently(source);
  } else if (state.player.state.status === AudioPlayerStatus.Playing) {
    state.player.pause();
    await refreshPlayerPanel(sourceClient(source), requireGuild(source).id);
    await acknowledgeSilently(source);
  } else {
    await replyPublic(source, '🔇 Nothing playing.');
  }
}

async function handleNext(source) {
  const state = stateFor(requireGuild(source).id);
  if (state.player.state.status === AudioPlayerStatus.Playing || state.player.state.status === AudioPlayerStatus.Paused) {
    state.player.stop(true);
    await acknowledgeSilently(source);
  } else {
    await replyPublic(source, '🔇 Nothing playing.');
  }
}

async function handlePrevious(source) {
  const state = stateFor(requireGuild(source).id);
  if (!state.history.length || !state.current) {
    await replyPublic(source, '⏮️ No previous track.');
    return;
  }

  state.queue.unshift(state.current);
  state.forcedNext = state.history.pop();
  state.loopQueue = state.loopQueue.filter((track) => track !== state.forcedNext);
  state.player.stop(true);
  await acknowledgeSilently(source);
}

async function handleStop(source) {
  const guild = requireGuild(source);
  const state = stateFor(guild.id);
  state.client = sourceClient(source);

  await closePlayerPanel(sourceClient(source), guild.id, {
    title: 'Stopped',
    description: `Stopped by **${displayName(source)}**.`
  });

  state.queue = [];
  state.loopQueue = [];
  state.current = null;
  state.forcedNext = null;
  killFfmpeg(state);
  state.player.stop(true);
  scheduleVoiceDisconnect(guild.id, STOP_DISCONNECT_MS);
  await replyPrivate(source, '⏹️ Queue cleared.');
}

async function handleClear(source) {
  const guild = requireGuild(source);
  const state = stateFor(guild.id);
  state.queue = [];
  state.loopQueue = [];
  await refreshPlayerPanel(sourceClient(source), guild.id);
  await replyPublic(source, '🧹 Queue cleared.');
}

async function handleShuffle(source) {
  const guild = requireGuild(source);
  const state = stateFor(guild.id);
  const tracks = state.loop ? [...state.loopQueue, ...state.queue] : state.queue;
  if (tracks.length < 2) {
    await replyPublic(source, '🔀 Not enough tracks.');
    return;
  }

  for (let index = tracks.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [tracks[index], tracks[swapIndex]] = [tracks[swapIndex], tracks[index]];
  }

  state.loopQueue = [];
  state.queue = tracks;
  await refreshPlayerPanel(sourceClient(source), guild.id);
  await replyPublic(source, `🔀 ${tracks.length}`);
}

async function handleLoop(source) {
  const guild = requireGuild(source);
  const state = stateFor(guild.id);
  state.loop = !state.loop;
  await refreshPlayerPanel(sourceClient(source), guild.id);
  await replyPublic(source, `🔁 Playlist ${state.loop ? 'On' : 'Off'}`);
}

async function handleVolume(source, value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 200) {
    await replyPublic(source, 'Volume must be between 0 and 200.');
    return;
  }

  const state = stateFor(requireGuild(source).id);
  state.volume = parsed / 100;
  if (state.player.state.resource?.volume) {
    state.player.state.resource.volume.setVolume(state.volume);
  }
  await refreshPlayerPanel(sourceClient(source), requireGuild(source).id);
  await replyPublic(source, `🔊 ${parsed}%`);
}

async function handleNow(source) {
  const guild = requireGuild(source);
  const state = stateFor(guild.id);
  state.client = sourceClient(source);
  state.textChannelId = source.channelId || source.channel?.id || state.textChannelId;
  if (!state.current) {
    await replyPublic(source, 'Nothing is playing.');
    return;
  }
  await sendPlayerPanel(sourceClient(source), guild.id, state.current);
  await replyPublic(source, '▶️');
}

async function handleQueue(source, page = 1) {
  const state = stateFor(requireGuild(source).id);
  const queue = formatQueue(state, Number.parseInt(page, 10) || 1);
  await replyPrivate(source, {
    content: queue.content,
    components: queueControls(state.guildId, queue.page, queue.totalPages)
  });
}

async function handleHelp(source) {
  await replyPublic(source, [
    '**YouTube commands**',
    'Buttons: ⏮️ ⏯️ ⏭️ ⏹️ 🔁 🔀 🎶',
    'Queue replies are private. Other command replies are public.',
    '`/suy loop` loops the playlist, not only the current song. `/suy shuffle` shuffles the current playlist.',
    '`/suy play query:<url or search>` or `!play <url or search>`',
    `\`!play full <playlist_URL>\` queues a full playlist/radio list. Normal playlist/radio input is limited to ${DEFAULT_PLAYLIST_LIMIT}.`,
    '`/suy queue` or `!queue` opens a paged queue menu.',
    '`/suy previous`, `/suy next`, `/suy pause`, `/suy stop`, `/suy volume value:<0-200>`'
  ].join('\n'));
}

export const youtubeControls = {
  join: handleJoin,
  leave: handleLeave,
  pause: handleTogglePause,
  resume: handleTogglePause,
  previous: handlePrevious,
  next: handleNext,
  stop: handleStop,
  clear: handleClear,
  shuffle: handleShuffle,
  loop: handleLoop,
  volume: handleVolume,
  now: handleNow,
  queue: handleQueue,
  help: handleHelp
};

async function executeSubcommand(source, subcommand, args = []) {
  switch (subcommand) {
    case 'join':
      return handleJoin(source);
    case 'leave':
      return handleLeave(source);
    case 'play':
      return handlePlay(source, args.join(' '));
    case 'pause':
      return handleTogglePause(source);
    case 'resume':
      return handleTogglePause(source);
    case 'next':
    case 'skip':
      return handleNext(source);
    case 'previous':
      return handlePrevious(source);
    case 'stop':
      return handleStop(source);
    case 'clear':
      return handleClear(source);
    case 'shuffle':
      return handleShuffle(source);
    case 'loop':
      return handleLoop(source);
    case 'volume':
      return handleVolume(source, args[0]);
    case 'now':
      return handleNow(source);
    case 'queue':
      return handleQueue(source, args[0] || 1);
    case 'help':
    default:
      return handleHelp(source);
  }
}

export const feature = {
  data: new SlashCommandBuilder()
    .setName('suy')
    .setDescription('Play YouTube audio in a voice channel.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('play')
        .setDescription('Queue a YouTube URL, playlist, radio, or search.')
        .addStringOption((option) =>
          option
            .setName('query')
            .setDescription('YouTube URL or search text.')
            .setRequired(true)
        )
        .addBooleanOption((option) =>
          option
            .setName('full')
            .setDescription('Queue a full playlist/radio list instead of limiting it.')
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) => subcommand.setName('join').setDescription('Join your voice channel.'))
    .addSubcommand((subcommand) => subcommand.setName('leave').setDescription('Leave voice and clear queue.'))
    .addSubcommand((subcommand) => subcommand.setName('pause').setDescription('Pause or resume playback.'))
    .addSubcommand((subcommand) => subcommand.setName('resume').setDescription('Pause or resume playback.'))
    .addSubcommand((subcommand) => subcommand.setName('previous').setDescription('Play the previous track.'))
    .addSubcommand((subcommand) => subcommand.setName('next').setDescription('Play the next track.'))
    .addSubcommand((subcommand) => subcommand.setName('stop').setDescription('Stop playback and clear queue.'))
    .addSubcommand((subcommand) => subcommand.setName('clear').setDescription('Clear queued tracks.'))
    .addSubcommand((subcommand) => subcommand.setName('shuffle').setDescription('Shuffle the current playlist.'))
    .addSubcommand((subcommand) => subcommand.setName('loop').setDescription('Toggle playlist loop.'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('volume')
        .setDescription('Set YouTube playback volume.')
        .addIntegerOption((option) =>
          option
            .setName('value')
            .setDescription('Volume from 0 to 200.')
            .setMinValue(0)
            .setMaxValue(200)
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) => subcommand.setName('now').setDescription('Refresh the shared now-playing panel.'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('queue')
        .setDescription('Show the YouTube queue.')
        .addIntegerOption((option) =>
          option
            .setName('page')
            .setDescription('Queue page number.')
            .setMinValue(1)
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) => subcommand.setName('help').setDescription('Show YouTube music help.')),

  prefixCommands: [
    'suy',
    'yt',
    'join',
    'leave',
    'play',
    'pause',
    'resume',
    'previous',
    'next',
    'skip',
    'stop',
    'clear',
    'shuffle',
    'loop',
    'volume',
    'now',
    'queue'
  ],

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'play') {
      await interaction.deferReply();
      return handlePlay(
        interaction,
        interaction.options.getString('query', true),
        interaction.options.getBoolean('full') || false
      );
    }

    if (subcommand === 'volume') {
      return handleVolume(interaction, interaction.options.getInteger('value', true));
    }

    if (subcommand === 'queue') {
      return handleQueue(interaction, interaction.options.getInteger('page') || 1);
    }

    return executeSubcommand(interaction, subcommand);
  },

  async executePrefix(message, args, commandName) {
    const subcommand = commandName === 'suy' || commandName === 'yt' ? (args.shift()?.toLowerCase() || 'help') : commandName;
    await executeSubcommand(message, subcommand, args);
  },

  handlesButton(customId) {
    return customId.startsWith(BUTTON_PREFIX);
  },

  async handleButton(interaction) {
    const [, group, action, guildId, rawPage] = interaction.customId.split(':');
    if (guildId !== interaction.guildId) {
      await interaction.reply({ content: 'This control belongs to another server.', flags: MessageFlags.Ephemeral });
      return;
    }

    const state = stateFor(guildId);
    state.client = interaction.client;

    if (group === 'queue') {
      const page = Number.parseInt(rawPage, 10) || 1;
      const queue = formatQueue(state, page);
      if (action === 'show') {
        await interaction.reply({
          content: queue.content,
          components: queueControls(guildId, queue.page, queue.totalPages),
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await interaction.update({
        content: queue.content,
        components: queueControls(guildId, queue.page, queue.totalPages)
      });
      return;
    }

    if (group !== 'player') return;

    switch (action) {
      case 'previous':
        return handlePrevious(interaction);
      case 'toggle':
        return handleTogglePause(interaction);
      case 'next':
        return handleNext(interaction);
      case 'stop':
        return handleStop(interaction);
      case 'loop':
        return handleLoop(interaction);
      case 'shuffle':
        return handleShuffle(interaction);
      default:
        return interaction.reply({ content: 'Unknown control.', flags: MessageFlags.Ephemeral });
    }
  },

  help: {
    name: '/suy',
    aliases: ['!suy', '!yt', '!play', '!queue', '!now', '!next', '!previous', '!skip'],
    usage: '/suy play query:<url or search> [full:true] | !play [full] <url or search>',
    description: 'Play YouTube audio with a shared now-playing button menu and a private queue view.',
    examples: [
      '/suy play query:lofi hip hop',
      '/suy play query:https://www.youtube.com/playlist?list=... full:true',
      '!play full https://www.youtube.com/playlist?list=...',
      '!queue'
    ]
  }
};
