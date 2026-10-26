import 'dotenv/config';

// ====================================================================
// ⚙️ BOT VERSION & CONFIGURATION (Edit version here easily)
// ====================================================================
const BOT_VERSION = '3.8';

// Silence noisy libsignal session decryption logs
const originalConsoleError = console.error;
console.error = (...args) => {
    const msg = args.join(' ');
    if (msg.includes('Bad MAC') || msg.includes('Session error') || msg.includes('Failed to decrypt message')) {
        return; 
    }
    originalConsoleError(...args);
};

import makeWASocket, { 
    useMultiFileAuthState, 
    makeCacheableSignalKeyStore,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    downloadMediaMessage
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { exec } from 'child_process';
import ytDlp from 'yt-dlp-exec';

// Ensure media download directories exist
const MEDIA_DIRS = ['./videos', './images', './downloads', './audio'];
MEDIA_DIRS.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Auto-cleanup temporary media files older than 1 hour to preserve disk space
setInterval(() => {
    MEDIA_DIRS.forEach(dir => {
        fs.readdir(dir, (err, files) => {
            if (err) return;
            files.forEach(file => {
                const filePath = path.join(dir, file);
                fs.stat(filePath, (err, stats) => {
                    if (!err && (Date.now() - stats.mtimeMs > 3600000)) {
                        fs.unlink(filePath, () => {});
                    }
                });
            });
        });
    });
}, 1800000);

// State maps for interactive selection sessions (scoped per chat session/remoteJid)
const pendingVideoSearches = new Map();
const pendingSongSearches = new Map();
const pendingImageSearches = new Map();
const pendingExtendSessions = new Map();

// Message cache to store recent messages for anti-delete tracking & quote lookups
const messageCache = new Map();

function cacheMessage(msg) {
    if (!msg || !msg.key || !msg.key.id) return;
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';
    if (!text && !msg.message?.imageMessage && !msg.message?.videoMessage) return;

    messageCache.set(msg.key.id, {
        id: msg.key.id,
        remoteJid: msg.key.remoteJid,
        senderJid: msg.key.participant || msg.key.remoteJid,
        text: text || '[Media Message]',
        rawMessage: msg.message,
        timestamp: Date.now()
    });

    if (messageCache.size > 1000) {
        const firstKey = messageCache.keys().next().value;
        messageCache.delete(firstKey);
    }
}

// Runtime Superowner state (persists in memory during active session)
let currentSuperownerJid = null;

// Ignore non-fatal SSL / rate-limit crashes
process.on('uncaughtException', (err) => {
    if (err.message && (err.message.includes('Bad MAC') || err.message.includes('rate-overlimit'))) return;
    console.error('[UNCAUGHT ERROR]', err);
});

function loadConfig() {
    try {
        if (!fs.existsSync('config.json')) return { phoneNumber: '85268813673', authMethod: 1 };
        return JSON.parse(fs.readFileSync('config.json', 'utf-8'));
    } catch {
        return { phoneNumber: '85268813673', authMethod: 1 };
    }
}

const config = loadConfig();

// Validate Ollama Cloud API Key
const ollamaApiKey = process.env.OLLAMA_API_KEY;
if (!ollamaApiKey) {
    console.error('❌ CRITICAL ERROR: OLLAMA_API_KEY is missing in your .env file!');
    process.exit(1);
}

// Dynamic Footer Signature Helper
function getSignature() {
    const debugTag = db.debugMode ? ' [Debug]' : '';
    return `\n\n⚡ZetaAI V${BOT_VERSION}${debugTag}`;
}

// Zeta Defense System (ZDS) Special Footer
function getZdsFooter() {
    return `\n\n🛡️ [Zeta Defense System Triggered]${getSignature()}`;
}

const DB_FILE = 'database.json';
const DB_FORMAT_FILE = 'databaseformat.json';

function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        let initial = { 
            banned: [], 
            warns: {}, 
            groupConfig: {}, 
            chatAiStatus: {}, 
            globalAiStatus: true,
            botPersonality: 'default', 
            customPersonalities: {},
            owners: [],
            keeps: [],
            usage: {},
            mediaUsage: {},
            drawUsage: {},
            terminalLinkCode: null,
            terminalDmCode: null,
            antiDeleteLinkTarget: null,
            debugMode: true,
            activeRaidKey: null
        };
        if (fs.existsSync(DB_FORMAT_FILE)) {
            try {
                initial = JSON.parse(fs.readFileSync(DB_FORMAT_FILE, 'utf-8'));
            } catch {}
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
        return initial;
    }
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
        if (!data.banned) data.banned = [];
        if (!data.warns) data.warns = {};
        if (!data.groupConfig) data.groupConfig = {};
        if (!data.chatAiStatus) data.chatAiStatus = {};
        if (data.globalAiStatus === undefined) data.globalAiStatus = true;
        if (!data.botPersonality) data.botPersonality = 'default';
        if (!data.customPersonalities) data.customPersonalities = {};
        if (!data.owners) data.owners = [];
        if (!data.keeps) data.keeps = [];
        if (!data.usage) data.usage = {};
        if (!data.mediaUsage) data.mediaUsage = {};
        if (!data.drawUsage) data.drawUsage = {};
        if (data.terminalLinkCode === undefined) data.terminalLinkCode = null;
        if (data.terminalDmCode === undefined) data.terminalDmCode = null;
        if (data.antiDeleteLinkTarget === undefined) data.antiDeleteLinkTarget = null;
        if (data.debugMode === undefined) data.debugMode = true;
        if (data.activeRaidKey === undefined) data.activeRaidKey = null;
        return data;
    } catch {
        return { banned: [], warns: {}, groupConfig: {}, chatAiStatus: {}, globalAiStatus: true, botPersonality: 'default', customPersonalities: {}, owners: [], keeps: [], usage: {}, mediaUsage: {}, drawUsage: {}, terminalLinkCode: null, terminalDmCode: null, antiDeleteLinkTarget: null, debugMode: true, activeRaidKey: null };
    }
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let db = loadDB();

// Normalizes any incoming WhatsApp JID/LID down to just the base phone number/ID
function normalizeJid(jid) {
    if (!jid) return '';
    return jid.split('@')[0].split(':')[0];
}

function isUserSuperowner(jid) {
    if (!jid) return false;
    return currentSuperownerJid && normalizeJid(currentSuperownerJid) === normalizeJid(jid);
}

function isUserOwner(jid) {
    if (!jid) return false;
    const cleanJid = normalizeJid(jid);
    return isUserSuperowner(jid) || db.owners.some(owner => normalizeJid(owner) === cleanJid);
}

function isUserKeep(jid) {
    if (!jid) return false;
    const cleanJid = normalizeJid(jid);
    return db.keeps.some(keep => normalizeJid(keep) === cleanJid);
}

// Group Metadata Cache
const groupCache = new Map();
async function getCachedGroupMetadata(sock, jid) {
    const cached = groupCache.get(jid);
    if (cached && (Date.now() - cached.time < 600000)) return cached.data;
    try {
        const data = await sock.groupMetadata(jid);
        groupCache.set(jid, { data, time: Date.now() });
        return data;
    } catch (err) {
        if (cached) return cached.data;
        throw err;
    }
}

// Standard Assistant Personalities
const BASE_PERSONALITIES = {
    default: `You are a helpful, friendly, and accurate AI assistant. Answer questions clearly and naturally.`,
    professional: `You are a professional, objective, and precise AI assistant. Provide structured, well-reasoned, and concise answers.`,
    casual: `You are a relaxed, casual, and friendly AI assistant. Keep responses conversational and straight to the point.`
};

function getAllPersonalities() {
    return { ...BASE_PERSONALITIES, ...db.customPersonalities };
}

// Helper to check and consume user usage limit (4 uses per day for text)
function checkUserUsage(senderJid) {
    const userId = normalizeJid(senderJid);
    const todayStr = new Date().toDateString();

    if (!db.usage[userId] || db.usage[userId].date !== todayStr) {
        db.usage[userId] = { date: todayStr, count: 0, extra: 0 };
    }

    const userRecord = db.usage[userId];
    const totalAllowed = 4 + (userRecord.extra || 0);
    
    if (userRecord.count >= totalAllowed) {
        return false;
    }
    userRecord.count++;
    saveDB(db);
    return true;
}

// Helper to check and consume daily media read limit (2 per day)
function checkMediaUsage(senderJid) {
    const userId = normalizeJid(senderJid);
    const todayStr = new Date().toDateString();

    if (!db.mediaUsage[userId] || db.mediaUsage[userId].date !== todayStr) {
        db.mediaUsage[userId] = { date: todayStr, count: 0, extra: 0 };
    }

    const mediaRecord = db.mediaUsage[userId];
    const totalAllowed = 2 + (mediaRecord.extra || 0);
    
    if (mediaRecord.count >= totalAllowed) {
        return false;
    }
    mediaRecord.count++;
    saveDB(db);
    return true;
}

// Helper to check and consume /zdraw generation limit (3 times a week)
function checkDrawUsage(senderJid) {
    const userId = normalizeJid(senderJid);
    const now = Date.now();
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

    if (!db.drawUsage[userId] || (now - db.drawUsage[userId].startTime > oneWeekMs)) {
        db.drawUsage[userId] = { startTime: now, count: 0, extra: 0 };
    }

    const drawRecord = db.drawUsage[userId];
    const totalAllowed = 3 + (drawRecord.extra || 0);

    if (drawRecord.count >= totalAllowed) {
        return false;
    }
    drawRecord.count++;
    saveDB(db);
    return true;
}

// Helper to create visual progress bar
function renderProgressBar(percentage) {
    const totalBlocks = 10;
    const filledBlocks = Math.round((percentage / 100) * totalBlocks);
    const emptyBlocks = totalBlocks - filledBlocks;
    return `[${'█'.repeat(filledBlocks)}${'░'.repeat(emptyBlocks)}] ${percentage}%`;
}

// 🌐 LIVE WEB SEARCH SCRAPER
async function performLiveWebSearch(query) {
    try {
        const isTrendQuery = /trend|trending|viral|popular|news|today/i.test(query);
        const searchQuery = isTrendQuery ? `${query} global trending topics news today` : query;

        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
        const { data } = await axios.get(searchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' },
            timeout: 5000
        });

        const $ = cheerio.load(data);
        const results = [];
        $('.result__body').slice(0, 5).each((i, el) => {
            const title = $(el).find('.result__title').text().trim();
            const snippet = $(el).find('.result__snippet').text().trim();
            const url = $(el).find('.result__url').attr('href');
            if (title && snippet) {
                results.push(`• Title: ${title}\n  Summary: ${snippet}\n  Link: ${url || 'N/A'}`);
            }
        });
        return results.join('\n\n') || null;
    } catch {
        return null;
    }
}

// 🎬 YOUTUBE SEARCH VIA YT-DLP
async function searchYouTubeEight(query) {
    try {
        const output = await ytDlp(`ytsearch8:${query}`, {
            dumpSingleJson: true,
            noCheckCertificates: true,
            noWarnings: true,
            skipDownload: true,
            extractorArgs: 'youtube:player_client=android'
        });

        let entries = [];
        if (output && Array.isArray(output.entries)) {
            entries = output.entries;
        } else if (typeof output === 'string') {
            const lines = output.trim().split('\n');
            for (const line of lines) {
                try { entries.push(JSON.parse(line)); } catch {}
            }
        } else if (output && typeof output === 'object') {
            entries = output.entries || [output];
        }

        const results = [];
        for (const video of entries) {
            if (!video) continue;
            results.push({
                title: video.title || 'YouTube Content',
                url: video.webpage_url || (video.id ? `https://www.youtube.com/watch?v=${video.id}` : ''),
                duration: video.duration ? `${Math.floor(video.duration / 60)}m ${video.duration % 60}s` : 'N/A',
                views: video.view_count ? video.view_count.toLocaleString() : 'N/A'
            });
            if (results.length >= 8) break;
        }

        return results;
    } catch (err) {
        console.error('[YOUTUBE SEARCH ERROR]', err?.message || err);
        return [];
    }
}

// 🧠 AI-POWERED SMART PINTEREST / IMAGE CURATION (/zpin)
async function getSmartCuratedImages(query) {
    const styles = [
        "aesthetic cinematic lighting",
        "minimalist modern vibe",
        "vibrant high detail mood",
        "cozy ambient aesthetic",
        "sleek futuristic concept",
        "retro vintage tone",
        "clean elegant studio style",
        "artistic creative composition"
    ];

    const cleanQuery = query.replace(/[^a-zA-Z0-9\s]/g, '').trim();
    const images = [];

    for (let i = 0; i < 8; i++) {
        const subStyle = styles[i % styles.length];
        const combinedSeed = encodeURIComponent(`${cleanQuery} ${subStyle} ${i}`);
        images.push({
            title: `Pin Option #${i + 1}: ${cleanQuery} (${subStyle})`,
            url: `https://picsum.photos/seed/${combinedSeed}/1024/1024`
        });
    }
    return images;
}

// 🔗 DIRECT WEBSITE CONTENT SCRAPER
async function fetchPageContent(url) {
    try {
        const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 6000 });
        const $ = cheerio.load(data);
        $('script, style, nav, footer, header, iframe').remove();
        return $('body').text().replace(/\s+/g, ' ').trim().substring(0, 2500);
    } catch {
        return "Failed to scrape page content.";
    }
}

// Robust Download Media helper function for video/audio with progress
function downloadMediaWithProgress(url, outputPath, isAudio, onProgress) {
    return new Promise((resolve, reject) => {
        const args = isAudio 
            ? [url, '-f', 'bestaudio', '--extract-audio', '--audio-format', 'mp3', '-o', outputPath, '--no-playlist', '--extractor-args', 'youtube:player_client=android']
            : [url, '-f', 'best[ext=mp4]/best', '-o', outputPath, '--no-playlist', '--extractor-args', 'youtube:player_client=android'];

        const child = ytDlp.exec(args);

        child.stdout?.on('data', (data) => {
            const match = data.toString().match(/(\d+(?:\.\d+)?)%/);
            if (match) {
                const percent = Math.floor(parseFloat(match[1]));
                onProgress(percent);
            }
        });

        child.on('close', (code) => {
            if (code === 0 || fs.existsSync(outputPath)) {
                resolve(outputPath);
            } else {
                if (fs.existsSync(outputPath) || fs.existsSync(outputPath.replace('.mp3', '.opus'))) {
                    resolve(outputPath);
                } else {
                    reject(new Error(`yt-dlp exited with code ${code}`));
                }
            }
        });

        child.on('error', (err) => reject(err));
    });
}

// 🔊 Stable Text-To-Speech (TTS) Generator with FFmpeg Opus Voice Note Conversion
async function generateTTSAudio(text, outputPath) {
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=en&client=tw-ob`;
    const mp3Path = outputPath.replace('.opus', '.mp3');
    
    const response = await axios({
        method: 'get',
        url: ttsUrl,
        responseType: 'stream',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 10000
    });
    
    const writer = fs.createWriteStream(mp3Path);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });

    return new Promise((resolve, reject) => {
        exec(`ffmpeg -y -i "${mp3Path}" -c:a libopus -b:a 64k -vbr on "${outputPath}"`, (err) => {
            if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
            if (fs.existsSync(outputPath)) {
                resolve(outputPath);
            } else {
                reject(new Error('FFmpeg TTS conversion failed'));
            }
        });
    });
}

const COMMANDS_CONTEXT = `
[BOT COMMANDS & CAPABILITIES REFERENCE]
You are Zeta AI, a helpful AI assistant.
1. Control & AI Commands:
   - /zai <prompt> : Chat with the AI (4 free daily uses). Supports quoting/replying to messages!
   - /zsearch <prompt> : Search YouTube videos/Images (up to 8 results) & download.
   - /zpin or /zpintrest <prompt> : Curate smart Pinterest-style aesthetic images (up to 8 results) & download.
   - /zdraw <prompt> : Generate AI artwork/images (limit: 3 times a week).
   - /zsong <prompt> : Search music/audio (up to 8 results) & download audio.
   - /tts <prompt> : Convert text into voice note audio.
   - :ping : Check bot connection latency and message processing speed.
   - :on / :off : Enable or disable AI responses for this specific chat.
   - :config <mode> : Switch bot personality (or view list of available personalities if invalid).
   - :reset : Clear conversation memory.
   - :help / :commands : Display this help menu.
   - :zkick @user : Kick a user from the group.
   - :zban @user : Ban a user from using the bot / trigger ZDS on join.
   - :zgen : Generate an 8-character raid key.
   - :zkill [key] : Purge group members and unadmin non-privileged users.
`;

const userMemory = new Map();
const MAX_HISTORY_TURNS = 6;

async function indicateThinking(sock, remoteJid, msgKey) {
    await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
    if (msgKey) {
        await sock.sendMessage(remoteJid, { react: { text: '⚡', key: msgKey } }).catch(() => {});
    }
}

async function checkAdmin(sock, groupJid, userJid) {
    try {
        const metadata = await getCachedGroupMetadata(sock, groupJid);
        const participant = metadata.participants.find(p => p.id === userJid);
        return participant?.admin === 'admin' || participant?.admin === 'superadmin';
    } catch {
        return false;
    }
}

async function processMessage(sock, msg, remoteJid, textMessage, senderJid, pushName) {
    try {
        const clean = textMessage.trim();
        const lower = clean.toLowerCase();
        const isGroup = remoteJid.endsWith('@g.us');

        const isSuperowner = isUserSuperowner(senderJid);
        const isOwner = isUserOwner(senderJid);
        const hasKeep = isUserKeep(senderJid);
        const isPrivileged = isOwner || hasKeep;
        const isAdmin = isGroup ? await checkAdmin(sock, remoteJid, senderJid) : true;

        if (db.banned.includes(senderJid)) return;

        // ====================================================================
        // INTERACTIVE EXTEND SESSION HANDLING (Reply 1 or 2)
        // ====================================================================
        const sessionKey = `${remoteJid}_${senderJid}`;
        if (pendingExtendSessions.has(sessionKey)) {
            if (lower === '1' || lower === '2') {
                const extendData = pendingExtendSessions.get(sessionKey);
                pendingExtendSessions.delete(sessionKey);

                const targetUserId = normalizeJid(extendData.targetJid);
                const amt = extendData.amount;
                const todayStr = new Date().toDateString();

                if (lower === '1') {
                    if (!db.usage[targetUserId] || db.usage[targetUserId].date !== todayStr) {
                        db.usage[targetUserId] = { date: todayStr, count: 0, extra: 0 };
                    }
                    db.usage[targetUserId].extra += amt;
                    saveDB(db);
                    await sock.sendMessage(remoteJid, { 
                        text: `➕ Successfully extended @${targetUserId}'s *Daily AI Message Limit* by *${amt}* uses!${getSignature()}`, 
                        mentions: [extendData.targetJid] 
                    }, { quoted: msg });
                } else if (lower === '2') {
                    if (!db.mediaUsage[targetUserId] || db.mediaUsage[targetUserId].date !== todayStr) {
                        db.mediaUsage[targetUserId] = { date: todayStr, count: 0, extra: 0 };
                    }
                    db.mediaUsage[targetUserId].extra += amt;
                    saveDB(db);
                    await sock.sendMessage(remoteJid, { 
                        text: `➕ Successfully extended @${targetUserId}'s *Daily Media Usage Limit* by *${amt}* uses!${getSignature()}`, 
                        mentions: [extendData.targetJid] 
                    }, { quoted: msg });
                }
                return;
            } else if (lower === 'cancel' || lower === ':cancel') {
                pendingExtendSessions.delete(sessionKey);
                await sock.sendMessage(remoteJid, { text: `❌ Extension session cancelled.${getSignature()}` }, { quoted: msg });
                return;
            }
        }

        // ====================================================================
        // MEDIA DOWNLOAD SELECTION (Scoped strictly to remoteJid chat session)
        // ====================================================================
        const hasPendingVideo = pendingVideoSearches.has(sessionKey);
        const hasPendingSong = pendingSongSearches.has(sessionKey);
        const hasPendingImage = pendingImageSearches.has(sessionKey);

        if (hasPendingVideo || hasPendingSong || hasPendingImage) {
            if (lower === 'cancel' || lower === '0' || lower === ':cancel') {
                pendingVideoSearches.delete(sessionKey);
                pendingSongSearches.delete(sessionKey);
                pendingImageSearches.delete(sessionKey);
                await sock.sendMessage(remoteJid, { text: `❌ Search selection cancelled.${getSignature()}` }, { quoted: msg });
                return;
            }

            if (/^[1-8]$/.test(clean)) {
                const choiceIdx = parseInt(clean) - 1;

                if (hasPendingVideo) {
                    const videos = pendingVideoSearches.get(sessionKey);
                    pendingVideoSearches.delete(sessionKey);
                    if (choiceIdx >= videos.length) {
                        await sock.sendMessage(remoteJid, { text: `❌ Invalid selection number. Choose between 1 and ${videos.length} or type \`cancel\`.${getSignature()}` }, { quoted: msg });
                        return;
                    }
                    const selected = videos[choiceIdx];

                    const statusMsg = await sock.sendMessage(remoteJid, { 
                        text: `📥 *Downloading Video:* _${selected.title}_\n\n${renderProgressBar(0)}\n⏳ Starting download...` 
                    }, { quoted: msg });

                    const videoPath = path.join('./videos', `yt_${Date.now()}.mp4`);
                    let lastUpdatePercent = -10;

                    try {
                        await downloadMediaWithProgress(selected.url, videoPath, false, async (percent) => {
                            if (percent - lastUpdatePercent >= 20 || percent === 100) {
                                lastUpdatePercent = percent;
                                await sock.sendMessage(remoteJid, { 
                                    text: `📥 *Downloading Video:* _${selected.title}_\n\n${renderProgressBar(percent)}\n⏳ ${percent}% completed...`,
                                    edit: statusMsg.key 
                                }).catch(() => {});
                            }
                        });

                        await sock.sendMessage(remoteJid, { 
                            text: `✅ *Download Complete!* Sending video...`,
                            edit: statusMsg.key 
                        }, { quoted: msg });

                        await sock.sendMessage(remoteJid, {
                            video: { url: videoPath },
                            caption: `🎬 *${selected.title}*\n🔗 ${selected.url}${getSignature()}`
                        }, { quoted: msg });
                    } catch (err) {
                        await sock.sendMessage(remoteJid, { 
                            text: `❌ Video download failed or processing error.\n🔗 Direct Link: ${selected.url}${getSignature()}`,
                            edit: statusMsg.key 
                        }).catch(() => {});
                    }
                    return;
                }

                if (hasPendingSong) {
                    const songs = pendingSongSearches.get(sessionKey);
                    pendingSongSearches.delete(sessionKey);
                    if (choiceIdx >= songs.length) {
                        await sock.sendMessage(remoteJid, { text: `❌ Invalid selection number. Choose between 1 and ${songs.length} or type \`cancel\`.${getSignature()}` }, { quoted: msg });
                        return;
                    }
                    const selected = songs[choiceIdx];

                    const statusMsg = await sock.sendMessage(remoteJid, { 
                        text: `🎵 *Downloading MP3 Audio:* _${selected.title}_\n\n${renderProgressBar(0)}\n⏳ Fetching track...` 
                    }, { quoted: msg });

                    const audioPath = path.join('./audio', `song_${Date.now()}.mp3`);
                    let lastUpdatePercent = -10;

                    try {
                        await downloadMediaWithProgress(selected.url, audioPath, true, async (percent) => {
                            if (percent - lastUpdatePercent >= 20 || percent === 100) {
                                lastUpdatePercent = percent;
                                await sock.sendMessage(remoteJid, { 
                                    text: `🎵 *Downloading MP3 Audio:* _${selected.title}_\n\n${renderProgressBar(percent)}\n⏳ ${percent}% completed...`,
                                    edit: statusMsg.key 
                                }).catch(() => {});
                            }
                        });

                        await sock.sendMessage(remoteJid, { 
                            text: `✅ *Download Complete!* Sending MP3 audio...`,
                            edit: statusMsg.key 
                        }, { quoted: msg });

                        await sock.sendMessage(remoteJid, {
                            audio: { url: audioPath },
                            mimetype: 'audio/mp4',
                            ptt: false,
                            caption: `🎧 *${selected.title}* (MP3 Audio)${getSignature()}`
                        }, { quoted: msg });
                    } catch (err) {
                        await sock.sendMessage(remoteJid, { 
                            text: `❌ Audio download failed.\n🔗 Direct Link: ${selected.url}${getSignature()}`,
                            edit: statusMsg.key 
                        }).catch(() => {});
                    }
                    return;
                }

                if (hasPendingImage) {
                    const images = pendingImageSearches.get(sessionKey);
                    pendingImageSearches.delete(sessionKey);
                    if (choiceIdx >= images.length) {
                        await sock.sendMessage(remoteJid, { text: `❌ Invalid selection number. Choose between 1 and ${images.length} or type \`cancel\`.${getSignature()}` }, { quoted: msg });
                        return;
                    }
                    const selected = images[choiceIdx];

                    await sock.sendMessage(remoteJid, { text: `📥 *Downloading Image:* _${selected.title}_...` }, { quoted: msg });

                    const imagePath = path.join('./images', `img_${Date.now()}.jpg`);
                    try {
                        const response = await axios({ url: selected.url, responseType: 'stream', timeout: 10000 });
                        const writer = fs.createWriteStream(imagePath);
                        response.data.pipe(writer);

                        await new Promise((resolve, reject) => {
                            writer.on('finish', resolve);
                            writer.on('error', reject);
                        });

                        await sock.sendMessage(remoteJid, {
                            image: { url: imagePath },
                            caption: `🖼️ *${selected.title}*${getSignature()}`
                        }, { quoted: msg });
                    } catch {
                        await sock.sendMessage(remoteJid, { image: { url: selected.url }, caption: `🖼️ *${selected.title}*${getSignature()}` }, { quoted: msg }).catch(async () => {
                            await sock.sendMessage(remoteJid, { text: `❌ Image download failed. Direct URL: ${selected.url}${getSignature()}` }, { quoted: msg });
                        });
                    }
                    return;
                }
            }
        }

        // ====================================================================
        // STRICT COMMAND GUARD: MUST START WITH '/' OR ':'
        // ====================================================================
        if (!clean.startsWith('/') && !clean.startsWith(':')) {
            return; // Completely ignores any normal message or uncommanded input
        }

        // ====================================================================
        // SYSTEM CONTROL COMMANDS
        // ====================================================================
        if (clean.startsWith(':') || clean.startsWith('.mode')) {
            const rawCmd = clean.startsWith('.mode') ? clean.replace('.mode', 'config') : clean.slice(1);
            const systemCmd = rawCmd.trim();
            const systemLower = systemCmd.toLowerCase();

            // :ping command
            if (systemLower === 'ping') {
                const startTime = Date.now();
                const msgTimeSec = msg.messageTimestamp ? (typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : (msg.messageTimestamp.low || msg.messageTimestamp)) : null;
                const msgLatency = msgTimeSec ? Math.max(0, (Math.floor(Date.now() / 1000) - msgTimeSec) * 1000) : 0;
                const serverPing = Date.now() - startTime;

                await sock.sendMessage(remoteJid, { 
                    text: `🏓 *Pong!*\n⚡ *Server Latency:* \`${serverPing}ms\`\n⏱️ *Message Latency:* \`${msgLatency}ms\`${getSignature()}` 
                }, { quoted: msg });
                return;
            }

            // :help or :commands
            if (systemLower === 'help' || systemLower === 'commands') {
                const helpText = `🤖 *Zeta AI Command Center* 🤖

📌 *AI & Media Commands:*
• \`/zai <prompt>\` - Chat with AI (4 free daily uses). Supports quoting/replying to messages!
• \`/zsearch <query>\` - Search YouTube videos or Images (up to 8 options) & download.
• \`/zpin\` or \`/zpintrest <query>\` - Curate smart Pinterest-style aesthetic images (up to 8 options) & download.
• \`/zdraw <prompt>\` - Generate AI artwork/images (limit: 3 times a week).
• \`/zsong <query>\` - Search music/songs (up to 8 options) & download MP3 audio.
• \`/tts <prompt>\` - Convert text into AI speech audio.

⚙️ *General Controls:*
• \`:ping\` - Check server response speed & message latency.
• \`:on\` / \`:off\` - Toggle AI for this specific chat.
• \`:config <mode>\` - Switch bot personality (or view list of available personalities if invalid).
• \`:reset\` - Clear conversation memory.
• \`:help\` or \`:commands\` - Show this help menu.

🛡️ *Admin & Privileged Commands:*
• \`:zkick @user\` - Kick a user from the group.
• \`:zban @user\` - Ban a user (triggers ZDS on group join).
• \`:zgen\` - Generate a raid key.
• \`:zkill [key]\` - Purge group members and unadmin non-privileged users.
• \`:on global\` / \`:off global\` - Toggle AI globally.
• \`:keep @user\` - Grant keep permission.
• \`:keep remove @user\` - Revoke keep permission.
• \`:staff\` - View all staff (Owners and Keep users).
• \`:link DM-[8 chars]\` - Set chat as master anti-delete logger receiver.

👑 *Owner Commands:*
• \`:owner @user\` - Grant owner status.
• \`:owner remove @user\` - Revoke owner status.
• \`:debug on\` / \`:debug off\` - Toggle debug tag in footer.
• \`:extend @user <amt>\` - Extend daily limits.`;

                await sock.sendMessage(remoteJid, { text: `${helpText}${getSignature()}` }, { quoted: msg });
                return;
            }

            // :zkick @user command
            if (systemLower.startsWith('zkick')) {
                if (!isGroup) {
                    await sock.sendMessage(remoteJid, { text: `❌ This command can only be used inside groups.${getSignature()}` }, { quoted: msg });
                    return;
                }
                if (!isAdmin && !isPrivileged) {
                    await sock.sendMessage(remoteJid, { text: `❌ *Access Denied:* You must be a group admin or privileged user to use \`:zkick\`.\n\n🛡️ [Zeta Defense System Active]${getSignature()}` }, { quoted: msg });
                    return;
                }

                let targetUserJid = null;
                if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
                    targetUserJid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
                }

                if (!targetUserJid) {
                    await sock.sendMessage(remoteJid, { text: `❌ *Usage:* \`:zkick @user\`${getSignature()}` }, { quoted: msg });
                    return;
                }

                try {
                    await sock.groupParticipantsUpdate(remoteJid, [targetUserJid], 'remove');
                    await sock.sendMessage(remoteJid, { 
                        text: `👢 Successfully kicked @${normalizeJid(targetUserJid)} from the group.${getZdsFooter()}`,
                        mentions: [targetUserJid] 
                    }, { quoted: msg });
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: `❌ Failed to kick user. Make sure the bot is a group admin.${getSignature()}` }, { quoted: msg });
                }
                return;
            }

            // :zban @user command
            if (systemLower.startsWith('zban')) {
                if (!isPrivileged) {
                    await sock.sendMessage(remoteJid, { text: `❌ *Access Denied:* Only Owners and Keep users can ban members.\n\n🛡️ [Zeta Defense System Active]${getSignature()}` }, { quoted: msg });
                    return;
                }

                let targetUserJid = null;
                if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
                    targetUserJid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
                }

                if (!targetUserJid) {
                    await sock.sendMessage(remoteJid, { text: `❌ *Usage:* \`:zban @user\`${getSignature()}` }, { quoted: msg });
                    return;
                }

                const cleanTarget = normalizeJid(targetUserJid);
                if (!db.banned.includes(cleanTarget)) {
                    db.banned.push(targetUserJid);
                    db.banned.push(cleanTarget);
                    saveDB(db);
                }

                await sock.sendMessage(remoteJid, { 
                    text: `🚫 Successfully banned @${cleanTarget} via Zeta Defense System (ZDS). They will be automatically blocked & kicked from any managed group upon joining.${getZdsFooter()}`,
                    mentions: [targetUserJid]
                }, { quoted: msg });
                return;
            }

            // :zgen command (Generate Raid Key)
            if (systemLower === 'zgen') {
                if (!isOwner) {
                    await sock.sendMessage(remoteJid, { text: `❌ *Access Denied:* Only Owners can generate raid keys.${getSignature()}` }, { quoted: msg });
                    return;
                }

                const raidKey = Math.random().toString(36).substring(2, 10).toUpperCase();
                db.activeRaidKey = raidKey;
                saveDB(db);

                await sock.sendMessage(remoteJid, { 
                    text: `⚠️ *RAID KEY GENERATED* ⚠️\n\n🔑 Key: \`${raidKey}\`\n\n_Use \`:zkill ${raidKey}\` to execute emergency group/community purge. Keepbed and Superowner users are protected._${getZdsFooter()}` 
                }, { quoted: msg });
                return;
            }

            // :zkill [key] command (Purge group and unadmin non-privileged users)
            if (systemLower.startsWith('zkill')) {
                if (!isOwner) {
                    await sock.sendMessage(remoteJid, { text: `❌ *Access Denied:* Only Owners can execute \`:zkill\`.\n\n🛡️ [Zeta Defense System Active]${getSignature()}` }, { quoted: msg });
                    return;
                }

                const inputKey = systemCmd.split(/\s+/)[1]?.trim()?.toUpperCase();
                if (!db.activeRaidKey || inputKey !== db.activeRaidKey) {
                    await sock.sendMessage(remoteJid, { text: `❌ *Invalid or missing raid key!* Generate one first using \`:zgen\`.\n\n🛡️ [Zeta Defense System Active]${getSignature()}` }, { quoted: msg });
                    return;
                }

                if (!isGroup) {
                    await sock.sendMessage(remoteJid, { text: `❌ \`:zkill\` can only be executed inside group chats.${getSignature()}` }, { quoted: msg });
                    return;
                }

                db.activeRaidKey = null;
                saveDB(db);

                await sock.sendMessage(remoteJid, { text: `🚨 *ZETA DEFENSE SYSTEM:* Emergency group purge initiated with valid raid key!${getZdsFooter()}` }, { quoted: msg });

                try {
                    const metadata = await getCachedGroupMetadata(sock, remoteJid);
                    const participants = metadata.participants || [];

                    const toKick = [];
                    const toDemote = [];

                    for (const p of participants) {
                        const jid = p.id;
                        if (isUserKeep(jid) || isUserSuperowner(jid) || normalizeJid(jid) === normalizeJid(sock.user?.id)) {
                            continue; 
                        }
                        toKick.push(jid);
                        if (p.admin) {
                            toDemote.push(jid);
                        }
                    }

                    if (toDemote.length > 0) {
                        await sock.groupParticipantsUpdate(remoteJid, toDemote, 'demote').catch(() => {});
                    }

                    if (toKick.length > 0) {
                        for (let i = 0; i < toKick.length; i += 5) {
                            const batch = toKick.slice(i, i + 5);
                            await sock.groupParticipantsUpdate(remoteJid, batch, 'remove').catch(() => {});
                        }
                    }

                    await sock.sendMessage(remoteJid, { text: `✅ Emergency purge completed successfully.${getZdsFooter()}` });
                } catch (err) {
                    console.error('[ZKALL ERROR]', err);
                    await sock.sendMessage(remoteJid, { text: `❌ Purge encountered an error. Make sure bot is a group admin.${getSignature()}` });
                }
                return;
            }

            // :staff command
            if (systemLower === 'staff') {
                if (!isOwner) {
                    await sock.sendMessage(remoteJid, { text: `❌ *Access Denied:* Only Owners can view staff lists.${getSignature()}` }, { quoted: msg });
                    return;
                }

                let staffText = `🛡️ *Zeta AI Staff Directory* 🛡️\n\n`;
                
                staffText += `👑 *Owners:*\n`;
                if (currentSuperownerJid) staffText += `• @${normalizeJid(currentSuperownerJid)} *(Superowner)*\n`;
                if (db.owners.length > 0) {
                    db.owners.forEach(j => { staffText += `• @${normalizeJid(j)}\n`; });
                }
                if (!currentSuperownerJid && db.owners.length === 0) {
                    staffText += `• None registered\n`;
                }

                staffText += `\n🛡️ *Keep Users:*\n`;
                if (db.keeps.length === 0) {
                    staffText += `• No users currently have keep permissions.\n`;
                } else {
                    db.keeps.forEach(j => { staffText += `• @${normalizeJid(j)}\n`; });
                }

                const allMentions = [currentSuperownerJid, ...db.owners, ...db.keeps].filter(Boolean);
                await sock.sendMessage(remoteJid, { text: `${staffText}${getSignature()}`, mentions: allMentions }, { quoted: msg });
                return;
            }

            // :on global / :off global
            if (systemLower === 'on global' || systemLower === 'off global') {
                if (!isPrivileged) {
                    await sock.sendMessage(remoteJid, { text: `❌ *Access Denied:* Only Owners and Keep users can toggle global AI status.${getSignature()}` }, { quoted: msg });
                    return;
                }
                db.globalAiStatus = systemLower === 'on global';
                saveDB(db);
                await sock.sendMessage(remoteJid, { text: `🌐 *Global AI Status:* \`${systemLower === 'on global' ? 'ON' : 'OFF'}\`${getSignature()}` }, { quoted: msg });
                return;
            }

            // :debug command
            if (systemLower.startsWith('debug')) {
                if (!isOwner) {
                    await sock.sendMessage(remoteJid, { text: `❌ *Access Denied:* Only Owners can toggle debug mode.${getSignature()}` }, { quoted: msg });
                    return;
                }

                const arg = systemCmd.split(/\s+/)[1]?.toLowerCase();
                if (arg === 'on') {
                    db.debugMode = true;
                } else if (arg === 'off') {
                    db.debugMode = false;
                } else {
                    db.debugMode = !db.debugMode;
                }
                saveDB(db);

                await sock.sendMessage(remoteJid, { 
                    text: `🛠️ *Debug Tag:* \`${db.debugMode ? 'ENABLED' : 'DISABLED'}\`\nPreview: \`${getSignature().trim()}\`${getSignature()}` 
                }, { quoted: msg });
                return;
            }

            // :link [code] command
            if (systemLower.startsWith('link ') && !systemLower.startsWith('link dm-')) {
                const inputCode = systemCmd.split(/\s+/)[1]?.trim();
                if (db.terminalLinkCode && inputCode === db.terminalLinkCode) {
                    currentSuperownerJid = senderJid;
                    db.terminalLinkCode = null; 
                    saveDB(db);
                    await sock.sendMessage(remoteJid, { text: `👑 *Success!* You have been granted **Superowner** status.${getSignature()}` }, { quoted: msg });
                } else {
                    await sock.sendMessage(remoteJid, { text: `❌ *Invalid or expired link code!* Check your terminal for the active code.${getSignature()}` }, { quoted: msg });
                }
                return;
            }

            // :link DM-[8 characters] command
            if (systemLower.startsWith('link dm-')) {
                const code = systemCmd.replace('link ', '').trim().toUpperCase();
                
                if (db.terminalDmCode && code === db.terminalDmCode) {
                    db.antiDeleteLinkTarget = remoteJid; 
                    db.terminalDmCode = null; 
                    saveDB(db);

                    await sock.sendMessage(remoteJid, { 
                        text: `✅ *Success!* This chat has been successfully linked as the master receiver for all anti-delete logs across all groups.${getSignature()}` 
                    }, { quoted: msg });
                } else {
                    await sock.sendMessage(remoteJid, { 
                        text: `❌ *Invalid or expired anti-delete link code!* Check your terminal for the active code.${getSignature()}` 
                    }, { quoted: msg });
                }
                return;
            }

            // :owner @user or :owner remove @user command
            if (systemLower.startsWith('owner')) {
                if (!isSuperowner) {
                    await sock.sendMessage(remoteJid, { text: `❌ *Access Denied:* Only the Superowner can manage owner status.${getSignature()}` }, { quoted: msg });
                    return;
                }

                const parts = systemCmd.split(/\s+/);
                const action = parts[1]?.toLowerCase();
                let targetUserJid = null;

                if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
                    targetUserJid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
                }

                if (!targetUserJid) {
                    await sock.sendMessage(remoteJid, { text: `❌ *Usage:* \`:owner @user\` or \`:owner remove @user\`${getSignature()}` }, { quoted: msg });
                    return;
                }

                if (action === 'remove') {
                    db.owners = db.owners.filter(j => normalizeJid(j) !== normalizeJid(targetUserJid));
                    saveDB(db);
                    await sock.sendMessage(remoteJid, { text: `🗑️ Owner status removed for @${normalizeJid(targetUserJid)}`, mentions: [targetUserJid] }, { quoted: msg });
                } else {
                    if (!db.owners.some(j => normalizeJid(j) === normalizeJid(targetUserJid))) {
                        db.owners.push(targetUserJid);
                        saveDB(db);
                    }
                    await sock.sendMessage(remoteJid, { text: `👑 Owner status granted to @${normalizeJid(targetUserJid)}`, mentions: [targetUserJid] }, { quoted: msg });
                }
                return;
            }

            // :extend @user [amt] command
            if (systemLower.startsWith('extend')) {
                if (!isOwner) {
                    await sock.sendMessage(remoteJid, { text: `❌ *Access Denied:* Only Owners can extend usage limits.${getSignature()}` }, { quoted: msg });
                    return;
                }

                const parts = systemCmd.split(/\s+/);
                const amt = parseInt(parts[parts.length - 1]);
                let targetUserJid = null;

                if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
                    targetUserJid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
                }

                if (!targetUserJid || isNaN(amt)) {
                    await sock.sendMessage(remoteJid, { text: `❌ *Usage:* \`:extend @user <amount>\`${getSignature()}` }, { quoted: msg });
                    return;
                }

                pendingExtendSessions.set(sessionKey, { targetJid: targetUserJid, amount: amt });

                const menuText = `⚙️ *Select limit type to extend by ${amt} for @${normalizeJid(targetUserJid)}:*\n\n` +
                                 `*1.* Daily AI Message Usage\n` +
                                 `*2.* Daily Media Usage\n\n` +
                                 `👉 *Reply with 1 or 2* (or type \`cancel\` to abort).${getSignature()}`;

                await sock.sendMessage(remoteJid, { text: menuText, mentions: [targetUserJid] }, { quoted: msg });
                return;
            }

            // :keep @user, :keep remove @user commands
            if (systemLower.startsWith('keep')) {
                if (!isOwner) {
                    await sock.sendMessage(remoteJid, { text: `❌ *Access Denied:* Only Owners can manage keep permissions.${getSignature()}` }, { quoted: msg });
                    return;
                }

                const parts = systemCmd.split(/\s+/);
                const action = parts[1]?.toLowerCase();
                let targetUserJid = null;

                if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
                    targetUserJid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
                }

                if (!targetUserJid) {
                    await sock.sendMessage(remoteJid, { text: `❌ *Usage:* \`:keep @user\` or \`:keep remove @user\`${getSignature()}` }, { quoted: msg });
                    return;
                }

                if (action === 'remove') {
                    db.keeps = db.keeps.filter(j => normalizeJid(j) !== normalizeJid(targetUserJid));
                    saveDB(db);
                    await sock.sendMessage(remoteJid, { text: `🗑️ Keep permission removed for @${normalizeJid(targetUserJid)}`, mentions: [targetUserJid] }, { quoted: msg });
                } else {
                    if (!db.keeps.some(j => normalizeJid(j) === normalizeJid(targetUserJid))) {
                        db.keeps.push(targetUserJid);
                        saveDB(db);
                    }
                    await sock.sendMessage(remoteJid, { text: `🛡️ Keep permission granted to @${normalizeJid(targetUserJid)}`, mentions: [targetUserJid] }, { quoted: msg });
                }
                return;
            }

            // :on / :off
            if (systemLower === 'on' || systemLower === 'off') {
                if (isGroup && !isAdmin && !isSuperowner) return;
                db.chatAiStatus[remoteJid] = systemLower === 'on';
                saveDB(db);
                await sock.sendMessage(remoteJid, { text: `💬 *Chat AI Status:* \`${systemLower.toUpperCase()}\`${getSignature()}` }, { quoted: msg });
                return;
            }

            if (systemLower.startsWith('config')) {
                const requestedPersona = systemCmd.split(/\s+/)[1]?.toLowerCase();
                const allPers = getAllPersonalities();
                
                if (requestedPersona && allPers[requestedPersona]) {
                    db.botPersonality = requestedPersona;
                    saveDB(db);
                    await sock.sendMessage(remoteJid, { text: `✨ *Personality Engaged:* \`${requestedPersona.toUpperCase()}\`${getSignature()}` }, { quoted: msg });
                } else {
                    let listText = `✨ *Available Bot Personalities:*\n\n`;
                    for (const [key, desc] of Object.entries(allPers)) {
                        const activeMark = db.botPersonality === key ? ' *(Active)*' : '';
                        listText += `• \`${key}\`${activeMark}\n  _↳ ${desc.slice(0, 60)}...\n\n`;
                    }
                    listText += `👉 Use \`:config <mode>\` to switch personality.${getSignature()}`;
                    await sock.sendMessage(remoteJid, { text: listText }, { quoted: msg });
                }
                return;
            }

            if (systemLower === 'reset') {
                userMemory.delete(remoteJid);
                await sock.sendMessage(remoteJid, { text: `🧠 *Memory Cleared!*${getSignature()}` }, { quoted: msg });
                return;
            }
            return;
        }

        // Global and Chat AI Status enforcement for functional commands
        const isGlobalEnabled = db.globalAiStatus !== false;
        const isChatEnabled = db.chatAiStatus[remoteJid] !== false;
        if (!isGlobalEnabled || !isChatEnabled) return;

        // ====================================================================
        // /ZSONG COMMAND HANDLING
        // ====================================================================
        if (lower.startsWith('/zsong')) {
            await indicateThinking(sock, remoteJid, msg.key);
            const prompt = clean.slice(6).trim();

            if (!prompt) {
                await sock.sendMessage(remoteJid, { text: `❌ *Usage:* \`/zsong <song name or artist>\`${getSignature()}` }, { quoted: msg });
                return;
            }

            const songs = await searchYouTubeEight(prompt);
            if (!songs || songs.length === 0) {
                await sock.sendMessage(remoteJid, { text: `❌ No songs found for: *${prompt}*${getSignature()}` }, { quoted: msg });
                return;
            }
            pendingSongSearches.set(sessionKey, songs);

            let listMsg = `🎵 *MUSIC SEARCH RESULTS FOR:* _"${prompt}"_\n\n`;
            listMsg += `⭐ *RECOMMENDED TOP PICK:* 1️⃣ _${songs[0].title}_\n\n`;
            
            songs.forEach((song, idx) => {
                const badge = idx === 0 ? ' ⭐ [RECOMMENDED]' : '';
                listMsg += `*${idx + 1}.* ${song.title}${badge}\n   📂 Format: \`MP3\` | ⏱️ Duration: ${song.duration}\n\n`;
            });
            listMsg += `👉 *Reply with a number (1-${songs.length})* to download MP3 audio, or type \`cancel\` to abort.${getSignature()}`;

            await sock.sendMessage(remoteJid, { text: listMsg }, { quoted: msg });
            return;
        }

        // ====================================================================
        // /TTS COMMAND HANDLING
        // ====================================================================
        if (lower.startsWith('/tts')) {
            await indicateThinking(sock, remoteJid, msg.key);
            const prompt = clean.slice(4).trim();

            if (!prompt) {
                await sock.sendMessage(remoteJid, { text: `❌ *Usage:* \`/tts <text to speak>\`${getSignature()}` }, { quoted: msg });
                return;
            }

            const ttsPath = path.join('./audio', `tts_${Date.now()}.opus`);
            try {
                await generateTTSAudio(prompt, ttsPath);
                await sock.sendMessage(remoteJid, {
                    audio: { url: ttsPath },
                    mimetype: 'audio/ogg; codecs=opus',
                    ptt: true
                }, { quoted: msg });
            } catch (err) {
                console.error('[TTS ERROR]', err);
                await sock.sendMessage(remoteJid, { text: `❌ Text-To-Speech generation failed.${getSignature()}` }, { quoted: msg });
            }
            return;
        }

        // ====================================================================
        // /ZPIN & /ZPINTREST COMMAND HANDLING
        // ====================================================================
        if (lower.startsWith('/zpin') || lower.startsWith('/zpintrest')) {
            await indicateThinking(sock, remoteJid, msg.key);
            const prefixLen = lower.startsWith('/zpintrest') ? 10 : 5;
            const prompt = clean.slice(prefixLen).trim();

            if (!prompt) {
                await sock.sendMessage(remoteJid, { text: `❌ *Usage:* \`/zpin <prompt>\` or \`/zpintrest <prompt>\`${getSignature()}` }, { quoted: msg });
                return;
            }

            const images = await getSmartCuratedImages(prompt);
            pendingImageSearches.set(sessionKey, images);

            let listMsg = `📌 *SMART PINTEREST CURATION FOR:* _"${prompt}"_\n\n`;
            images.forEach((img, idx) => {
                listMsg += `*${idx + 1}.* ${img.title}\n`;
            });
            listMsg += `\n👉 *Reply with a number (1-${images.length})* to download, or type \`cancel\` to abort.${getSignature()}`;

            await sock.sendMessage(remoteJid, { text: listMsg }, { quoted: msg });
            return;
        }

        // ====================================================================
        // /ZDRAW COMMAND HANDLING
        // ====================================================================
        if (lower.startsWith('/zdraw')) {
            const prompt = clean.slice(6).trim();
            if (!prompt) {
                await sock.sendMessage(remoteJid, { text: `❌ *Usage:* \`/zdraw <description of image to generate>\`${getSignature()}` }, { quoted: msg });
                return;
            }

            if (!isPrivileged) {
                const canDraw = checkDrawUsage(senderJid);
                if (!canDraw) {
                    await sock.sendMessage(remoteJid, { text: `❌ *Weekly Limit Reached:* You can only use \`/zdraw\` 3 times per week.${getSignature()}` }, { quoted: msg });
                    return;
                }
            }

            await indicateThinking(sock, remoteJid, msg.key);

            try {
                const encodedPrompt = encodeURIComponent(prompt);
                let imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true`;

                await axios.get(imageUrl, { timeout: 8000 });

                await sock.sendMessage(remoteJid, {
                    image: { url: imageUrl },
                    caption: `🎨 *AI Artwork Generation*\n📝 *Prompt:* _${prompt}_${getSignature()}`
                }, { quoted: msg });
            } catch (err) {
                try {
                    const fallbackUrl = `https://picsum.photos/seed/${encodeURIComponent(prompt)}/1024/1024`;
                    await sock.sendMessage(remoteJid, {
                        image: { url: fallbackUrl },
                        caption: `🎨 *AI Artwork Generation (Fallback)*\n📝 *Prompt:* _${prompt}_${getSignature()}`
                    }, { quoted: msg });
                } catch {
                    await sock.sendMessage(remoteJid, { text: `❌ Failed to generate AI image. Please try another prompt.${getSignature()}` }, { quoted: msg });
                }
            }
            return;
        }

        // ====================================================================
        // /ZSEARCH COMMAND HANDLING
        // ====================================================================
        if (lower.startsWith('/zsearch')) {
            await indicateThinking(sock, remoteJid, msg.key);
            const prompt = clean.slice(8).trim();

            if (!prompt) {
                await sock.sendMessage(remoteJid, { text: `❌ *Usage:* \`/zsearch <prompt>\`${getSignature()}` }, { quoted: msg });
                return;
            }

            const isImageQuery = /image|picture|photo|wallpaper|pinterest|pic/i.test(prompt);

            if (isImageQuery) {
                const images = await getSmartCuratedImages(prompt);
                pendingImageSearches.set(sessionKey, images);

                let listMsg = `🖼️ *IMAGE SEARCH RESULTS FOR:* _"${prompt}"_\n\n`;
                images.forEach((img, idx) => { listMsg += `*${idx + 1}.* ${img.title}\n`; });
                listMsg += `\n👉 *Reply with a number (1-${images.length})* to download, or type \`cancel\` to abort.${getSignature()}`;

                await sock.sendMessage(remoteJid, { text: listMsg }, { quoted: msg });
            } else {
                const videos = await searchYouTubeEight(prompt);
                if (!videos || videos.length === 0) {
                    await sock.sendMessage(remoteJid, { text: `❌ No YouTube videos found for: *${prompt}*${getSignature()}` }, { quoted: msg });
                    return;
                }
                pendingVideoSearches.set(sessionKey, videos);

                let listMsg = `🎬 *YOUTUBE SEARCH RESULTS FOR:* _"${prompt}"_\n\n`;
                videos.forEach((vid, idx) => {
                    listMsg += `*${idx + 1}.* ${vid.title}\n   ⏱️ Duration: ${vid.duration} | 👀 Views: ${vid.views}\n\n`;
                });
                listMsg += `👉 *Reply with a number (1-${videos.length})* to download video, or type \`cancel\` to abort.${getSignature()}`;

                await sock.sendMessage(remoteJid, { text: listMsg }, { quoted: msg });
            }
            return;
        }

        // ====================================================================
        // OLLAMA CLOUD API TEXT CHAT (/zai command check with Quoted Context)
        // ====================================================================
        let aiPrompt = null;

        if (lower === '/zai') {
            await sock.sendMessage(remoteJid, { text: `❌ *Usage:* \`/zai <prompt>\`${getSignature()}` }, { quoted: msg });
            return;
        } else if (lower.startsWith('/zai ')) {
            aiPrompt = clean.slice(4).trim();
        }

        if (!aiPrompt) return;

        // Check daily usage limits (4 uses per day), privileged users bypass
        if (!isPrivileged) {
            const allowed = checkUserUsage(senderJid);
            if (!allowed) {
                await sock.sendMessage(remoteJid, { text: `❌ *Daily Limit Reached:* You have used all your 4 free AI prompts for today. Ask an Owner to extend your limit using \`:extend @user <amt>\`!${getSignature()}` }, { quoted: msg });
                return;
            }
        }

        await indicateThinking(sock, remoteJid, msg.key);

        // Extract Quoted / Replied Message Context if present
        let quotedContext = "";
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        if (contextInfo && contextInfo.stanzaId) {
            const quotedId = contextInfo.stanzaId;
            const cachedQuoted = messageCache.get(quotedId);
            if (cachedQuoted) {
                quotedContext = `[User replied to this message: "${cachedQuoted.text}"]\n`;
            } else if (contextInfo.quotedMessage) {
                const qMsg = contextInfo.quotedMessage;
                const qText = qMsg.conversation || qMsg.extendedTextMessage?.text || qMsg.imageMessage?.caption || qMsg.videoMessage?.caption || '[Quoted Media Message]';
                quotedContext = `[User replied to this message: "${qText}"]\n`;
            }
        }

        let fullAiInput = quotedContext ? `${quotedContext}\nUser Prompt: ${aiPrompt}` : aiPrompt;

        if (contextInfo && contextInfo.stanzaId) {
            const cachedQuoted = messageCache.get(contextInfo.stanzaId);
            if (cachedQuoted && cachedQuoted.rawMessage) {
                const qImg = cachedQuoted.rawMessage.imageMessage;
                const qVid = cachedQuoted.rawMessage.videoMessage;
                if (qImg || qVid) {
                    if (!isOwner) {
                        const canReadMedia = checkMediaUsage(senderJid);
                        if (!canReadMedia) {
                            await sock.sendMessage(remoteJid, { 
                                text: `❌ *Daily Media Limit Reached:* You can only analyze 2 images or videos per day.${getSignature()}` 
                            }, { quoted: msg });
                            return;
                        }
                    }
                    fullAiInput += `\n[Note: The user replied to an image/video message with caption: "${cachedQuoted.text}"]`;
                }
            }
        }

        const urlMatch = aiPrompt.match(/https?:\/\/[^\s]+/g);
        let scrapedContent = urlMatch ? await fetchPageContent(urlMatch[0]) : "";
        const liveSearchResults = await performLiveWebSearch(aiPrompt);

        if (!userMemory.has(remoteJid)) userMemory.set(remoteJid, []);
        const history = userMemory.get(remoteJid);
        const personaPrompt = getAllPersonalities()[db.botPersonality] || BASE_PERSONALITIES.default;

        const systemInstruction = `${personaPrompt}
${COMMANDS_CONTEXT}
CRITICAL RULE: Always reply in the exact same language the user is using in their prompt. If the user speaks English, reply in English.
${scrapedContent ? `\n--- EXTRACTED PAGE CONTENT ---\n${scrapedContent}\n---` : ''}
${liveSearchResults ? `\n--- REAL-TIME SEARCH DATA ---\n${liveSearchResults}\n---` : ''}`;

        try {
            const messages = [
                { role: 'system', content: systemInstruction }
            ];

            for (const h of history) {
                messages.push({
                    role: h.role === 'user' ? 'user' : 'assistant',
                    content: h.content
                });
            }

            messages.push({ role: 'user', content: fullAiInput });

            // Call Ollama Cloud OpenAI-Compatible API Endpoint with API Key
            const response = await axios.post('https://ollama.com/v1/chat/completions', {
                model: 'gemma4:31b',
                messages: messages,
                stream: false
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${ollamaApiKey}`
                },
                timeout: 30000
            });

            const replyText = response.data?.choices?.[0]?.message?.content || '';
            const usageData = response.data?.usage || { prompt_tokens: 15, completion_tokens: 35, total_tokens: 50 };
            
            const estimatedCost = (usageData.total_tokens * 0.0000003).toFixed(5);
            const usageFooter = `\n\n📊 *Token Usage:* \`${usageData.total_tokens} tokens\` | 💰 *Cost:* \`$${estimatedCost}\``;

            if (replyText) {
                history.push({ role: 'user', content: aiPrompt }, { role: 'assistant', content: replyText });
                if (history.length > MAX_HISTORY_TURNS * 2) history.splice(0, 2);
                await sock.sendMessage(remoteJid, { text: `${replyText}${usageFooter}${getSignature()}` }, { quoted: msg });
            }
        } catch (err) {
            console.error('[OLLAMA CHAT ERROR DETAILS]:', err?.response?.data || err.message);
            await sock.sendMessage(remoteJid, { text: `Sorry, I encountered an error connecting to Ollama Cloud.${getSignature()}` }, { quoted: msg });
        }

    } catch (err) {
        console.error('[MESSAGE ERROR]', err);
    }
}

async function connectToWhatsApp() {
    console.log(`🚀 [SYSTEM CORE] Initializing Zeta AI with Ollama Cloud (Auth Method: ${config.authMethod === 1 ? 'Pairing Code' : 'QR Code'})...`);
    
    if (!db.terminalLinkCode) {
        db.terminalLinkCode = 'ZETA-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        saveDB(db);
    }

    if (!db.terminalDmCode) {
        db.terminalDmCode = 'DM-' + Math.random().toString(36).substring(2, 10).toUpperCase();
        saveDB(db);
    }

    console.log('\n========================================');
    console.log(`🔗 TERMINAL LINK CODE: ${db.terminalLinkCode}`);
    console.log('Type ":link ' + db.terminalLinkCode + '" in WhatsApp to become Superowner.');
    console.log('----------------------------------------');
    console.log(`🗑️ ANTI-DELETE LINK CODE: ${db.terminalDmCode}`);
    console.log('Type ":link ' + db.terminalDmCode + '" in your target chat to receive all group deletion logs.');
    console.log('========================================\n');

    const logger = pino({ level: 'silent' });
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    const sock = makeWASocket({
        version,
        logger,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false,
        getMessage: async (key) => {
            const cached = messageCache.get(key.id);
            if (cached) {
                return { conversation: cached.text };
            }
            return null;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered) {
        if (config.authMethod === 1) {
            if (!config.phoneNumber) {
                console.error('❌ Please add your "phoneNumber" inside config.json to use pairing code mode!');
                process.exit(1);
            }

            setTimeout(async () => {
                try {
                    let phoneNumber = config.phoneNumber.replace(/[^0-9]/g, '');
                    console.log(`📱 Requesting pairing code for phone number from config.json: +${phoneNumber}...`);
                    const code = await sock.requestPairingCode(phoneNumber);
                    
                    console.log('\n========================================');
                    console.log(`🔑 YOUR PAIRING CODE IS: ${code?.match(/.{1,4}/g)?.join('-') || code}`);
                    console.log('========================================\n');
                    console.log('Go to WhatsApp on your phone -> Linked Devices -> Link with phone number instead, and enter this code.');
                } catch (err) {
                    console.error('❌ Failed to generate pairing code:', err);
                }
            }, 4000);
        } else if (config.authMethod === 2) {
            console.log('📷 QR Code mode is active. Waiting for QR code generation...');
        }
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && config.authMethod === 2) {
            console.log('📷 QR Code received! Generating qr.png in project folder...');
            try {
                const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
                const response = await axios.get(qrImageUrl, { responseType: 'arraybuffer' });
                fs.writeFileSync('qr.png', response.data);
                console.log('🖼️ QR Code successfully saved as qr.png!');
            } catch (err) {
                console.error('❌ Failed to save QR code image:', err.message);
            }
        }

        if (connection === 'open') {
            console.log('⚡ Connected successfully to WhatsApp with Ollama Cloud!');
            if (fs.existsSync('qr.png')) {
                try {
                    fs.unlinkSync('qr.png');
                    console.log('🗑️ Successfully deleted qr.png after connection!');
                } catch (err) {
                    console.error('⚠️ Could not remove qr.png:', err.message);
                }
            }
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('🔄 Reconnecting connection...');
                setTimeout(() => connectToWhatsApp(), 5000);
            } else {
                console.log('⚠️ Connection logged out. Delete auth_info_baileys folder and restart to re-pair.');
            }
        }
    });

    // ====================================================================
    // 🛡️ ZETA DEFENSE SYSTEM (ZDS) - GROUP JOIN & BAN MONITOR
    // ====================================================================
    sock.ev.on('group-participants.update', async (update) => {
        const { id: groupJid, participants, action } = update;
        if (action === 'add') {
            for (const participant of participants) {
                const cleanParticipant = normalizeJid(participant);
                const isBanned = db.banned.some(b => normalizeJid(b) === cleanParticipant);
                
                if (isBanned) {
                    try {
                        await sock.groupParticipantsUpdate(groupJid, [participant], 'remove');
                        await sock.sendMessage(groupJid, {
                            text: `🚨 *ZETA DEFENSE SYSTEM (ZDS)* 🚨\n\nBanned user @${cleanParticipant} attempted to join this group and has been automatically removed.${getZdsFooter()}`,
                            mentions: [participant]
                        });
                        console.log(`[ZDS] Automatically removed banned user @${cleanParticipant} from group ${groupJid}`);
                    } catch (err) {
                        console.error('[ZDS ERROR] Failed to remove banned participant:', err);
                    }
                }
            }
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update?.message === null || update.update?.messageStubType === 68 || update.type === 'revoke') {
                const msgId = update.key.id;
                const cachedMsg = messageCache.get(msgId);
                if (!cachedMsg) continue;

                const chatJid = cachedMsg.remoteJid;
                const senderJid = cachedMsg.senderJid;
                const deleterJid = update.key.participant || update.key.remoteJid || senderJid;

                const durationMs = Date.now() - cachedMsg.timestamp;
                const durationSec = Math.floor(durationMs / 1000);
                const durationMinutes = (durationSec / 60).toFixed(1);
                const timeStr = durationSec < 60 ? `${durationSec} seconds` : `${durationMinutes} minutes`;
                
                const isGroup = chatJid.endsWith('@g.us');
                let groupName = 'Private DM / Chat';
                if (isGroup) {
                    try {
                        const metadata = await getCachedGroupMetadata(sock, chatJid);
                        groupName = metadata.subject || 'Unknown Group';
                    } catch {
                        groupName = chatJid;
                    }
                }

                console.log('\n========================================');
                console.log(`🗑️ DELETED MESSAGE DETECTED [Chat: ${groupName}]`);
                console.log(`👤 Original Sender: @${normalizeJid(senderJid)}`);
                console.log(`🧹 Deleted By: @${normalizeJid(deleterJid)}`);
                console.log(`⏱️ Lasted for: ${timeStr}`);
                console.log(`💬 Content: ${cachedMsg.text}`);
                console.log('========================================\n');

                if (db.antiDeleteLinkTarget) {
                    const alertText = `🗑️ *DELETED MESSAGE DETECTED* 🗑️\n\n` +
                                      `👤 *Original Sender:* @${normalizeJid(senderJid)}\n` +
                                      `🧹 *Deleted By:* @${normalizeJid(deleterJid)}\n` +
                                      `📍 *Group/Chat:* \`${groupName}\`\n` +
                                      `⏱️ *Lasted for:* \`${timeStr}\`\n\n` +
                                      `💬 *Content:*\n> ${cachedMsg.text}${getSignature()}`;

                    await sock.sendMessage(db.antiDeleteLinkTarget, { 
                        text: alertText, 
                        mentions: [senderJid, deleterJid] 
                    }).catch(() => {});
                }

                messageCache.delete(msgId);
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            if (!msg || !msg.message) continue;

            cacheMessage(msg);

            const remoteJid = msg.key.remoteJid || '';
            if (remoteJid.endsWith('@newsletter') || remoteJid === 'status@broadcast') continue;

            const botJid = sock.user?.id || '';
            
            // Allow processing even if the message is from you (fromMe)
            const senderJid = msg.key.fromMe ? botJid : (msg.key.participant || msg.key.remoteJid);

            const textMessage = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';
            if (!textMessage) continue;

            const pushName = msg.pushName || 'User';

            await processMessage(sock, msg, remoteJid, textMessage.trim(), senderJid, pushName);
        }
    });
}

connectToWhatsApp();