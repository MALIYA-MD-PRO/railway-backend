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
const CACHED_WATCHER_SID = (process.env.WATCHER_SESSION_ID || "").trim();

const WEEKLY_COLLECTION = "weekly_react_subs";
const BOOSTED_POSTS_COLLECTION = "boosted_channel_posts";

const CHANNEL_POST_RE = /^https?:\/\/(www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]{10,45})\/(\d{1,12})\/?$/;
const CHANNEL_ONLY_RE = /^https?:\/\/(www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]{10,45})\/?$/;

const inFlightPosts = new Set();
let isCycleRunning = false;
let watcherInitialized = false;

function getApiKey() {
  return CACHED_WPRH_KEY || process.env.WPRH_API_KEY || "";
}

function getWatcherSessionId() {
  return CACHED_WATCHER_SID || (process.env.WATCHER_SESSION_ID || "").trim();
}

// ── Random Sleep Delay Helper: Strictly between 2.0 mins and 6.5 mins (< 7 mins) ──
function getRandomSleepMs() {
  const MIN_MS = 2 * 60 * 1000;       // 2.0 minutes
  const MAX_MS = 6.5 * 60 * 1000;     // 6.5 minutes (always < 7 mins)
  return Math.floor(MIN_MS + Math.random() * (MAX_MS - MIN_MS));
}

// ── Decode HTML Entities (e.g. &#x1f341; -> 🍁) ──────────────────
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

// ── MongoDB Connection & Unique Anti-Spam Indexes ────────────────
let _db = null;
async function getReactDb() {
  if (_db) return _db;
  const uri = getMongoUri();
  if (!uri) throw new Error("Database not configured");
  const client = new MongoClient(uri, { maxPoolSize: 5, family: 4 });
  await client.connect();
  _db = client.db(getMongoDb());

  await _db.collection(WEEKLY_COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  // Hard database-level guarantee: a post can ONLY ever be boosted ONCE
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

// ── Rate Limiters ────────────────────────────────────────────────
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

// ── Validation Helpers (Supports up to 10 emojis) ────────────────
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

// ── Send Reacts via Upstream Premium API ─────────────────────────
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

// ── Strictly-Once Post Booster (Zero Duplicate / Anti-Spam) ──────
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

// ── Channel Title Fetcher ────────────────────────────────────────
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

// ── Extract Post IDs from Baileys v7 newsletterFetchMessages Result ──
function extractPostIdsFromBaileysResponse(rawMsgs) {
  const ids = new Set();

  // Case 1: Array of WAMessage / newsletter message objects
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

  // Case 2: Raw XMPP BinaryNode tree fallback (scan all server_id attributes)
  if (ids.size === 0 && rawMsgs && typeof rawMsgs === "object") {
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

// ── Connect Helper with Stream Restart Support ───────────────────
async function openWatcherSocket(watcherDir, detectedByJid, maxAttempts = 2) {
  const { state, saveCreds } = await useMultiFileAuthState(watcherDir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1043857760] }));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "fatal" }),
      browser: Browsers.macOS("Safari"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 30000,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ws.on("CB:message", (node) => {
      try {
        const from = node?.attrs?.from || "";
        const serverId = Number(node?.attrs?.server_id || 0);
        if (from.endsWith("@newsletter") && serverId > 0) {
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
      console.warn("🛑 [Watcher] Session logged out (401)! Update WATCHER_SESSION_ID.");
      return { sock: null, saveCreds: null };
    }

    if (attempt < maxAttempts) {
      await delay(2500);
    }
  }

  return { sock: null, saveCreds: null };
}

// ═════════════════════════════════════════════════════════════════
//  WAKE -> CHECK CHANNELS -> REACT -> SLEEP (Human-Like Burst Cycle)
// ═════════════════════════════════════════════════════════════════
async function runWakeCheckSleepCycle() {
  if (isCycleRunning) return;
  isCycleRunning = true;

  let activeSock = null;
  try {
    const db = await getReactDb();
    const subsCol = db.collection(WEEKLY_COLLECTION);

    const activeSubs = await subsCol
      .find({ active: true, expiresAt: { $gt: new Date() } })
      .toArray();

    if (activeSubs.length === 0) {
      return;
    }

    const sid = getWatcherSessionId();
    if (!sid) {
      console.warn("⚠️ [Watcher] WATCHER_SESSION_ID is missing in Railway Variables!");
      return;
    }

    console.log(`🌅 [Watcher Wake-Up] Checking ${activeSubs.length} active channel(s)...`);

    const watcherDir = "./watcher_session";
    if (!watcherInitialized || !fs.existsSync(path.join(watcherDir, "creds.json"))) {
      fs.mkdirSync(watcherDir, { recursive: true });
      await restoreCredsToFile(sid, path.join(watcherDir, "creds.json"));
      watcherInitialized = true;
    }

    const detectedByJid = new Map();
    const { sock, saveCreds } = await openWatcherSocket(watcherDir, detectedByJid, 2);
    activeSock = sock;

    if (!sock) {
      console.warn("⚠️ [Watcher] Could not connect WhatsApp socket this cycle.");
      return;
    }

    // Brief 3s pause for initial state sync
    await delay(3000);

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

        // Follow & subscribe to live updates once
        if (!sub.followed) {
          await sock.newsletterFollow(jid).catch(() => {});
          await subsCol.updateOne({ _id: sub._id }, { $set: { followed: true } });
          await delay(1200);
        }
        if (typeof sock.subscribeNewsletterUpdates === "function") {
          await sock.subscribeNewsletterUpdates(jid).catch(() => {});
        }

        const postIdSet = new Set();
        if (detectedByJid.has(jid)) {
          for (const id of detectedByJid.get(jid)) postIdSet.add(id);
        }

        // ✅ Baileys v7 signature: newsletterFetchMessages(jid, count, since, after)
        if (typeof sock.newsletterFetchMessages === "function") {
          const rawMsgs = await sock.newsletterFetchMessages(jid, 5, 0, 0).catch((e) => {
            console.warn(`⚠️ [Watcher] Fetch error for ${jid}:`, e.message);
            return null;
          });
          const fetchedIds = extractPostIdsFromBaileysResponse(rawMsgs);
          for (const pid of fetchedIds) postIdSet.add(pid);
        }

        const sortedIds = Array.from(postIdSet).sort((a, b) => b - a);
        console.log(
          `🔎 [Channel Scan] ${sub.channelName} -> posts=[${sortedIds.join(",")}], lastReacted=${sub.lastReactedPostId || 0}`
        );

        if (sortedIds.length > 0) {
          const newest = sortedIds[0];
          if (!sub.lastReactedPostId || sub.lastReactedPostId === 0) {
            // Set initial baseline to current newest post so old posts aren't spammed
            await subsCol.updateOne({ _id: sub._id }, { $set: { lastReactedPostId: newest } });
            console.log(`📍 [Watcher] Baseline locked at post #${newest} for ${sub.channelName}`);
          } else if (newest > sub.lastReactedPostId) {
            // Boost every new post since lastReactedPostId (strictly ONCE each)
            const newPosts = sortedIds
              .filter((id) => id > sub.lastReactedPostId)
              .sort((a, b) => a - b)
              .slice(-5);

            for (const pid of newPosts) {
              await boostDetectedPost(sub, pid);
              await delay(1000);
            }
          }
        }

        await delay(1200);
      } catch (subErr) {
        console.warn(`⚠️ [Watcher] Error checking ${sub.inviteCode}:`, subErr.message);
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
    }
    isCycleRunning = false;
  }
}

// ═════════════════════════════════════════════════════════════════
//  POST /api/react/single — Instant Single Post Reaction Pack
// ═════════════════════════════════════════════════════════════════
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

// ═════════════════════════════════════════════════════════════════
//  POST /api/react/weekly — Activate 7-Day Auto-React Subscription
// ═════════════════════════════════════════════════════════════════
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
    const jid = `${inviteCode}@newsletter`;
    const baselinePostId = specificPostId || 0;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const db = await getReactDb();
    const col = db.collection(WEEKLY_COLLECTION);

    const subDoc = {
      inviteCode,
      jid,
      channelName,
      count,
      emojis,
      followed: false,
      lastReactedPostId: baselinePostId,
      reactedPostsCount: 0,
      active: true,
      createdAt: now,
      expiresAt,
      ownerIp: getIP(req),
    };

    await col.updateOne({ inviteCode }, { $set: subDoc }, { upsert: true });

    if (specificPostId) {
      const savedSub = await col.findOne({ inviteCode });
      if (savedSub) {
        boostDetectedPost(savedSub, specificPostId).catch(() => {});
      }
    }

    // Immediately wake watcher to lock current post baseline & follow channel
    setTimeout(() => runWakeCheckSleepCycle().catch(() => {}), 1500);

    return res.json({
      ok: true,
      message: "Weekly Auto-React Pack activated for 7 days!",
      subscription: {
        inviteCode,
        jid,
        channelName,
        count,
        emojis,
        mode: "Random Wake/Sleep (2m - 6.5m)",
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

// ═════════════════════════════════════════════════════════════════
//  GET /api/react/weekly/:inviteCode — Check Subscription Status
// ═════════════════════════════════════════════════════════════════
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
        expiresAt: sub.expiresAt,
      },
    });
  } catch {
    return res.status(500).json({ ok: false, error: "Failed to check status." });
  }
});

// ═════════════════════════════════════════════════════════════════
//  Recursive Random Timer Scheduler (Always < 7 Minutes)
// ═════════════════════════════════════════════════════════════════
export function startWeeklyReactWorker() {
  async function scheduleNextWake() {
    const sleepMs = getRandomSleepMs();
    const mins = (sleepMs / 60000).toFixed(1);
    console.log(`💤 [Watcher Sleep] Next wake-up in ${mins} mins...`);

    setTimeout(async () => {
      await runWakeCheckSleepCycle();
      scheduleNextWake();
    }, sleepMs);
  }

  setTimeout(async () => {
    await runWakeCheckSleepCycle();
    scheduleNextWake();
  }, 8 * 1000);

  console.log("🚀 Weekly Channel Auto-React Worker active (Random 2m–6.5m Wake/Sleep Mode)");
}

export default router;
