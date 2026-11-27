import express from "express";
import rateLimit from "express-rate-limit";
import { MongoClient } from "mongodb";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  delay,
} from "@whiskeysockets/baileys";
import pino from "pino";
import fs from "fs";
import path from "path";
import { getMongoUri, getMongoDb, redactSensitive } from "./security.js";
import { restoreCredsToFile } from "./mongodb.js";

const router = express.Router();

const WPRH_API_URL = "https://wp-react-hub.vercel.app/api/premium-submit";
const CACHED_WPRH_KEY = process.env.WPRH_API_KEY || "";
// Read from WATCHER_SESSION_ID (which is whitelisted by security.js) as well as WATCHER_SESSION_IDS
const CACHED_WATCHER_SIDS = [
  process.env.WATCHER_SESSION_ID || "",
  process.env.WATCHER_SESSION_IDS || "",
]
  .filter(Boolean)
  .join(",");

const WEEKLY_COLLECTION = "weekly_react_subs";
const BOOSTED_POSTS_COLLECTION = "boosted_channel_posts";

const CHANNEL_POST_RE = /^https?:\/\/(www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]{10,45})\/(\d{1,12})\/?$/;
const CHANNEL_ONLY_RE = /^https?:\/\/(www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]{10,45})\/?$/;

const inFlightPosts = new Set();
let isCycleRunning = false;
let currentlyOnlineSlot = null; // Strictly 1 bot online at any moment
let watcherTurnIndex = 0;
const initializedWatchers = new Set();
const deadWatchers = new Set();

function getApiKey() {
  return CACHED_WPRH_KEY || process.env.WPRH_API_KEY || "";
}

function getWatcherSessionIds() {
  const combined = [
    CACHED_WATCHER_SIDS,
    process.env.WATCHER_SESSION_ID || "",
    process.env.WATCHER_SESSION_IDS || "",
  ]
    .filter(Boolean)
    .join(",");

  // Deduplicate while preserving exact order
  const unique = [];
  for (const part of combined.split(/[\s,]+/)) {
    const clean = part.trim();
    if (clean && !unique.includes(clean)) {
      unique.push(clean);
    }
  }
  return unique;
}

function getAliveWatcherCount() {
  const all = getWatcherSessionIds();
  const alive = all.filter((_, idx) => !deadWatchers.has(idx));
  return Math.max(1, alive.length || all.length);
}

// ── Proportional Sleep Delay Based on Added Sessions Count ───────
// 1 bot   -> 2.0m – 6.5m
// 2 bots  -> 1.0m – 3.25m
// 5 bots  -> 24s  – 78s
// 10 bots -> 12s  – 39s
function getScaledSleepMs() {
  const n = getAliveWatcherCount();
  const BASE_MIN_MS = 2 * 60 * 1000;
  const BASE_MAX_MS = 6.5 * 60 * 1000;

  const scaledMin = Math.max(10 * 1000, Math.floor(BASE_MIN_MS / n));
  const scaledMax = Math.max(25 * 1000, Math.floor(BASE_MAX_MS / n));
  return Math.floor(scaledMin + Math.random() * (scaledMax - scaledMin));
}

function decodeHtmlEntities(str) {
  if (!str) return "";
  return String(str)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ""; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ""; }
    })
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

let _db = null;
async function getReactDb() {
  if (_db) return _db;
  const uri = getMongoUri();
  if (!uri) throw new Error("Database not configured");
  const client = new MongoClient(uri, { maxPoolSize: 5, family: 4 });
  await client.connect();
  _db = client.db(getMongoDb());

  await _db.collection(WEEKLY_COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await _db.collection(BOOSTED_POSTS_COLLECTION).createIndex(
    { inviteCode: 1, postId: 1 },
    { unique: true }
  );
  await _db.collection(BOOSTED_POSTS_COLLECTION).createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 30 * 24 * 60 * 60 }
  );

  return _db;
}

function getIP(req) {
  const fwd = req.headers["x-forwarded-for"];
  return fwd ? fwd.split(",")[0].trim() : req.socket.remoteAddress;
}

const singleReactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: getIP,
  message: { ok: false, error: "Hourly react limit reached. Try again later." },
});

const weeklySubLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  keyGenerator: getIP,
  message: { ok: false, error: "Daily weekly-pack limit reached (max 5 channels/day)." },
});

function validateEmojis(emojis) {
  if (!Array.isArray(emojis) || emojis.length === 0 || emojis.length > 10) {
    return null;
  }
  const clean = emojis
    .map((e) => String(e || "").trim())
    .filter((e) => e.length > 0 && e.length <= 12 && !/[<>{}"'`;\\]/.test(e));
  return clean.length > 0 ? clean.slice(0, 10) : null;
}

function validateCount(count) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > 3500) return null;
  return n;
}

async function dispatchPremiumReact(postUrl, count, emojis) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("WPRH_API_KEY is not configured on Railway server.");
  }
  const res = await fetch(WPRH_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ url: postUrl, count, emojis }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.message || `Upstream API error (${res.status})`);
  }
  return data;
}

async function boostDetectedPost(sub, postId) {
  const numericId = Number(postId);
  if (!Number.isInteger(numericId) || numericId <= 0) return false;

  const lockKey = `${sub.inviteCode}:${numericId}`;
  if (inFlightPosts.has(lockKey)) return false;
  inFlightPosts.add(lockKey);

  try {
    const db = await getReactDb();
    const boostedCol = db.collection(BOOSTED_POSTS_COLLECTION);
    const subsCol = db.collection(WEEKLY_COLLECTION);

    try {
      await boostedCol.insertOne({
        inviteCode: sub.inviteCode,
        postId: numericId,
        postUrl: `https://whatsapp.com/channel/${sub.inviteCode}/${numericId}`,
        count: sub.count,
        createdAt: new Date(),
      });
    } catch (dupErr) {
      if (dupErr?.code === 11000) {
        return false; // Already boosted once — strictly skip!
      }
      throw dupErr;
    }

    const postUrl = `https://whatsapp.com/channel/${sub.inviteCode}/${numericId}`;
    try {
      await dispatchPremiumReact(postUrl, sub.count, sub.emojis);

      await subsCol.updateOne(
        { _id: sub._id },
        {
          $max: { lastReactedPostId: numericId },
          $inc: { reactedPostsCount: 1 },
        }
      );

      console.log(`⚡ [Weekly Auto-React] Boosted ONCE (${sub.count} reacts) -> ${postUrl}`);
      return true;
    } catch (apiErr) {
      console.error(`❌ [Weekly Auto-React] API error for ${postUrl}:`, apiErr.message);
      await boostedCol.deleteOne({ inviteCode: sub.inviteCode, postId: numericId }).catch(() => {});
      return false;
    }
  } finally {
    inFlightPosts.delete(lockKey);
  }
}

async function fetchChannelTitle(inviteCode) {
  let title = "WhatsApp Channel";
  try {
    const res = await fetch(`https://www.whatsapp.com/channel/${inviteCode}`, {
      headers: {
        "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const html = await res.text();
    const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
    if (titleMatch?.[1]) {
      title = decodeHtmlEntities(titleMatch[1]);
    }
  } catch (_) {}
  return title;
}

function extractPostIdsFromBaileysResponse(rawMsgs) {
  const ids = new Set();

  const list = Array.isArray(rawMsgs)
    ? rawMsgs
    : Array.isArray(rawMsgs?.messages)
      ? rawMsgs.messages
      : Array.isArray(rawMsgs?.content)
        ? rawMsgs.content
        : [];

  for (const m of list) {
    const candidates = [
      m?.server_id,
      m?.attrs?.server_id,
      m?.key?.serverId,
      m?.key?.id,
      m?.messageStubParameters?.[0],
    ];
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isInteger(n) && n > 0 && n < 100000000) {
        ids.add(n);
      }
    }
  }

  if (rawMsgs && typeof rawMsgs === "object") {
    const str = JSON.stringify(rawMsgs);
    const re = /"server_id"\s*:\s*"?(\d{1,10})"?/g;
    let match;
    while ((match = re.exec(str)) !== null) {
      const n = Number(match[1]);
      if (n > 0 && n < 100000000) ids.add(n);
    }
  }

  return Array.from(ids).sort((a, b) => b - a);
}

async function openWatcherSocket(watcherDir, detectedByJid, botLabel, slotIndex, maxAttempts = 2) {
  const { state, saveCreds } = await useMultiFileAuthState(watcherDir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1043857760] }));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "fatal" }),
      browser: Browsers.macOS("Safari"),
      markOnlineOnConnect: true, // Required so WhatsApp flushes offline @newsletter push stanzas!
      syncFullHistory: false,
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 30000,
    });

    sock.ev.on("creds.update", saveCreds);

    // Capture incoming @newsletter push stanzas (server_id)
    sock.ws.on("CB:message", (node) => {
      try {
        const from = node?.attrs?.from || "";
        const serverId = Number(node?.attrs?.server_id || 0);
        if (from.endsWith("@newsletter") && serverId > 0) {
          console.log(`📡 [${botLabel} Live Push] ${from} -> post #${serverId}`);
          if (!detectedByJid.has(from)) detectedByJid.set(from, new Set());
          detectedByJid.get(from).add(serverId);
        }
      } catch (_) {}
    });

    sock.ev.on("messages.upsert", ({ messages }) => {
      try {
        for (const msg of messages || []) {
          const jid = msg?.key?.remoteJid || "";
          const serverId = Number(msg?.key?.serverId || msg?.messageStubParameters?.[0] || 0);
          if (jid.endsWith("@newsletter") && serverId > 0) {
            if (!detectedByJid.has(jid)) detectedByJid.set(jid, new Set());
            detectedByJid.get(jid).add(serverId);
          }
        }
      } catch (_) {}
    });

    const outcome = await new Promise((resolve) => {
      let settled = false;
      const done = (val) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(val);
        }
      };
      const timer = setTimeout(() => done("timeout"), 30000);

      sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          done("open");
        } else if (connection === "close") {
          const code = lastDisconnect?.error?.output?.statusCode;
          done(code === 401 ? "logged_out" : "retry");
        }
      });
    });

    if (outcome === "open") {
      return { sock, saveCreds };
    }

    try {
      sock.ev.removeAllListeners();
      sock.end(new Error("cleanup"));
    } catch (_) {}

    if (outcome === "logged_out") {
      deadWatchers.add(slotIndex);
      console.warn(`🛑 [${botLabel}] Logged out (401) — marked inactive and auto-skipped.`);
      return { sock: null, saveCreds: null };
    }

    if (attempt < maxAttempts) {
      await delay(2500);
    }
  }

  return { sock: null, saveCreds: null };
}

// ═════════════════════════════════════════════════════════════════
//  STRICT SINGLE-ACTIVE-BOT TURN CYCLE (Never 2 Bots Online Together)
// ═════════════════════════════════════════════════════════════════
async function runWakeCheckSleepCycle() {
  if (isCycleRunning || currentlyOnlineSlot !== null) return;
  isCycleRunning = true;

  let activeSock = null;
  let botLabel = "Watcher";
  try {
    const db = await getReactDb();
    const subsCol = db.collection(WEEKLY_COLLECTION);

    const activeSubs = await subsCol
      .find({ active: true, expiresAt: { $gt: new Date() } })
      .toArray();

    if (activeSubs.length === 0) {
      return;
    }

    const sids = getWatcherSessionIds();
    if (sids.length === 0) {
      console.warn("⚠️ [Watcher] WATCHER_SESSION_ID not set!");
      return;
    }

    if (deadWatchers.size >= sids.length) {
      deadWatchers.clear();
    }
    let slot = watcherTurnIndex % sids.length;
    for (let i = 0; i < sids.length; i++) {
      const candidate = (watcherTurnIndex + i) % sids.length;
      if (!deadWatchers.has(candidate)) {
        slot = candidate;
        watcherTurnIndex = candidate + 1;
        break;
      }
    }

    currentlyOnlineSlot = slot;
    const sid = sids[slot];
    botLabel = `Watcher #${slot + 1}/${sids.length}`;

    console.log(`🌅 [${botLabel} Online] Exclusively checking ${activeSubs.length} channel(s)...`);

    const watcherDir = `./watcher_session_${slot + 1}`;
    if (!initializedWatchers.has(slot) || !fs.existsSync(path.join(watcherDir, "creds.json"))) {
      fs.mkdirSync(watcherDir, { recursive: true });
      await restoreCredsToFile(sid, path.join(watcherDir, "creds.json"));
      initializedWatchers.add(slot);
    }

    const detectedByJid = new Map();
    const { sock, saveCreds } = await openWatcherSocket(watcherDir, detectedByJid, botLabel, slot, 2);
    activeSock = sock;

    if (!sock) {
      console.warn(`⚠️ [${botLabel}] Could not connect WhatsApp socket this turn.`);
      return;
    }

    // Hold open 8 seconds so WhatsApp flushes offline @newsletter messages
    await delay(8000);

    for (const sub of activeSubs) {
      try {
        let jid = sub.jid;
        if (!jid || jid.startsWith(sub.inviteCode)) {
          const meta = await sock.newsletterMetadata("invite", sub.inviteCode).catch(() => null);
          if (meta?.id) {
            jid = meta.id;
            const cleanTitle = decodeHtmlEntities(meta?.thread_metadata?.name?.text || meta?.name || sub.channelName);
            await subsCol.updateOne(
              { _id: sub._id },
              { $set: { jid, channelName: cleanTitle } }
            );
            sub.channelName = cleanTitle;
          }
        }

        if (!jid || !jid.endsWith("@newsletter")) continue;

        const followedSlots = Array.isArray(sub.followedSlots) ? sub.followedSlots : [];
        if (!followedSlots.includes(slot)) {
          await sock.newsletterFollow(jid).catch(() => {});
          await subsCol.updateOne(
            { _id: sub._id },
            { $addToSet: { followedSlots: slot }, $set: { followed: true } }
          );
          await delay(1000);
        }

        if (typeof sock.subscribeNewsletterUpdates === "function") {
          await sock.subscribeNewsletterUpdates(jid).catch(() => {});
        }

        const postIdSet = new Set();
        if (detectedByJid.has(jid)) {
          for (const id of detectedByJid.get(jid)) postIdSet.add(id);
        }

        if (typeof sock.newsletterFetchMessages === "function") {
          const rawMsgs = await sock.newsletterFetchMessages(jid, 10, undefined, undefined).catch(() => null);
          const fetchedIds = extractPostIdsFromBaileysResponse(rawMsgs);
          for (const pid of fetchedIds) postIdSet.add(pid);
        }

        const sortedIds = Array.from(postIdSet).sort((a, b) => b - a);
        console.log(
          `🔎 [${botLabel}] ${sub.channelName} -> posts=[${sortedIds.join(",")}], lastReacted=${sub.lastReactedPostId || 0}`
        );

        if (sortedIds.length > 0) {
          const newest = sortedIds[0];
          const prevLast = Number(sub.lastReactedPostId || 0);

          if (prevLast === 0) {
            await subsCol.updateOne({ _id: sub._id }, { $set: { lastReactedPostId: newest } });
            console.log(`📍 [${botLabel}] Baseline locked at post #${newest} for ${sub.channelName}`);
          } else if (newest > prevLast) {
            const candidateSet = new Set(sortedIds.filter((id) => id > prevLast));
            const startFill = Math.max(prevLast + 1, newest - 5);
            for (let id = startFill; id <= newest; id++) {
              candidateSet.add(id);
            }

            const toBoost = Array.from(candidateSet).sort((a, b) => a - b).slice(-6);
            for (const pid of toBoost) {
              await boostDetectedPost(sub, pid);
              await delay(1000);
            }
          }
        }

        await delay(700);
      } catch (subErr) {
        console.warn(`⚠️ [${botLabel}] Error checking ${sub.inviteCode}:`, subErr.message);
      }
    }

    if (saveCreds) await saveCreds().catch(() => {});
  } catch (err) {
    console.warn("⚠️ [Watcher Cycle] Error:", err.message);
  } finally {
    if (activeSock) {
      try {
        activeSock.ev.removeAllListeners();
        activeSock.end(new Error("going to sleep"));
      } catch (_) {}
      await delay(1000);
    }
    if (currentlyOnlineSlot !== null) {
      console.log(`😴 [${botLabel} Offline] Socket closed cleanly.`);
    }
    currentlyOnlineSlot = null;
    isCycleRunning = false;
  }
}

router.post("/single", singleReactLimiter, async (req, res) => {
  try {
    const rawUrl = String(req.body?.url || "").trim();
    const match = rawUrl.match(CHANNEL_POST_RE);
    if (!match) {
      return res.status(400).json({
        ok: false,
        error: "Invalid WhatsApp Channel Post URL. Format: https://whatsapp.com/channel/<id>/<post>",
      });
    }

    const count = validateCount(req.body?.count);
    if (!count) {
      return res.status(400).json({ ok: false, error: "Count must be an integer between 1 and 3500." });
    }

    const emojis = validateEmojis(req.body?.emojis);
    if (!emojis) {
      return res.status(400).json({ ok: false, error: "Select between 1 and 10 valid emojis." });
    }

    const cleanUrl = `https://whatsapp.com/channel/${match[2]}/${match[3]}`;
    const result = await dispatchPremiumReact(cleanUrl, count, emojis);

    return res.json({
      ok: true,
      message: result.message || `Successfully queued ${count} reactions!`,
      postId: match[3],
      inviteCode: match[2],
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: redactSensitive(err?.message || "Failed to send reactions."),
    });
  }
});

router.post("/weekly", weeklySubLimiter, async (req, res) => {
  try {
    const rawUrl = String(req.body?.url || "").trim();
    const match = rawUrl.match(CHANNEL_ONLY_RE) || rawUrl.match(CHANNEL_POST_RE);
    if (!match) {
      return res.status(400).json({
        ok: false,
        error: "Invalid WhatsApp Channel URL. Format: https://whatsapp.com/channel/<id>",
      });
    }

    const inviteCode = match[2];
    const specificPostId = match[3] ? Number(match[3]) : null;

    const count = validateCount(req.body?.count);
    if (!count) {
      return res.status(400).json({ ok: false, error: "Count per post must be between 1 and 3500." });
    }

    const emojis = validateEmojis(req.body?.emojis);
    if (!emojis) {
      return res.status(400).json({ ok: false, error: "Select between 1 and 10 valid emojis." });
    }

    const channelName = await fetchChannelTitle(inviteCode);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const db = await getReactDb();
    const col = db.collection(WEEKLY_COLLECTION);

    const existing = await col.findOne({ inviteCode });
    const preservedBaseline = existing?.lastReactedPostId || specificPostId || 0;
    const preservedJid = existing?.jid || `${inviteCode}@newsletter`;
    const preservedSlots = Array.isArray(existing?.followedSlots) ? existing.followedSlots : [];

    const subDoc = {
      inviteCode,
      jid: preservedJid,
      channelName,
      count,
      emojis,
      followed: preservedSlots.length > 0,
      followedSlots: preservedSlots,
      lastReactedPostId: preservedBaseline,
      active: true,
      updatedAt: now,
      expiresAt,
      ownerIp: getIP(req),
    };

    await col.updateOne(
      { inviteCode },
      {
        $set: subDoc,
        $setOnInsert: { createdAt: now, reactedPostsCount: 0 },
      },
      { upsert: true }
    );

    if (specificPostId) {
      const savedSub = await col.findOne({ inviteCode });
      if (savedSub) {
        boostDetectedPost(savedSub, specificPostId).catch(() => {});
      }
    }

    if (!isCycleRunning && currentlyOnlineSlot === null) {
      setTimeout(() => runWakeCheckSleepCycle().catch(() => {}), 2000);
    }

    return res.json({
      ok: true,
      message: "Weekly Auto-React Pack activated for 7 days!",
      subscription: {
        inviteCode,
        jid: preservedJid,
        channelName,
        count,
        emojis,
        watcherBotsCount: getAliveWatcherCount(),
        expiresAt: expiresAt.toISOString(),
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: redactSensitive(err?.message || "Could not activate weekly subscription."),
    });
  }
});

router.get("/weekly/:inviteCode", async (req, res) => {
  try {
    const code = String(req.params.inviteCode || "").trim();
    if (!/^[A-Za-z0-9_-]{10,45}$/.test(code)) {
      return res.status(400).json({ ok: false, error: "Invalid channel ID." });
    }
    const db = await getReactDb();
    const sub = await db.collection(WEEKLY_COLLECTION).findOne({
      inviteCode: code,
      expiresAt: { $gt: new Date() },
    });
    if (!sub) {
      return res.status(404).json({ ok: false, error: "No active weekly pack found for this channel." });
    }

    const cleanName = decodeHtmlEntities(sub.channelName);
    if (cleanName !== sub.channelName) {
      await db.collection(WEEKLY_COLLECTION).updateOne({ _id: sub._id }, { $set: { channelName: cleanName } });
    }

    return res.json({
      ok: true,
      subscription: {
        inviteCode: sub.inviteCode,
        jid: sub.jid,
        channelName: cleanName,
        count: sub.count,
        emojis: sub.emojis,
        lastReactedPostId: sub.lastReactedPostId || 0,
        reactedPostsCount: sub.reactedPostsCount || 0,
        watcherBotsCount: getAliveWatcherCount(),
        expiresAt: sub.expiresAt,
      },
    });
  } catch {
    return res.status(500).json({ ok: false, error: "Failed to check status." });
  }
});

// ═════════════════════════════════════════════════════════════════
//  Sequential Chain Scheduler (Next Sleep Starts ONLY After Bot Sleeps)
// ═════════════════════════════════════════════════════════════════
let loopStarted = false;
export function startWeeklyReactWorker() {
  if (loopStarted) return;
  loopStarted = true;

  async function scheduleNextTurn() {
    const n = getAliveWatcherCount();
    const sleepMs = getScaledSleepMs();
    const secs = Math.round(sleepMs / 1000);
    const label = secs >= 60 ? `${(secs / 60).toFixed(1)} mins` : `${secs}s`;
    console.log(`💤 [Pool Sleep | ${n} Bot(s)] Next single-bot turn in ${label}...`);

    setTimeout(async () => {
      await runWakeCheckSleepCycle();
      scheduleNextTurn();
    }, sleepMs);
  }

  setTimeout(async () => {
    await runWakeCheckSleepCycle();
    scheduleNextTurn();
  }, 8 * 1000);

  const count = getWatcherSessionIds().length;
  console.log(`🚀 Weekly Channel Auto-React Worker active (${count} Bot(s) | Auto-Scaled | Strict 1-Bot Online)`);
}

export default router;
