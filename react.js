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
const WATCHER_SESSION_ID = (process.env.WATCHER_SESSION_ID || "").trim();
const WEEKLY_COLLECTION = "weekly_react_subs";

const CHANNEL_POST_RE = /^https?:\/\/(www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]{10,45})\/(\d{1,12})\/?$/;
const CHANNEL_ONLY_RE = /^https?:\/\/(www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]{10,45})\/?$/;

function getApiKey() {
  return CACHED_WPRH_KEY || process.env.WPRH_API_KEY || "";
}

// ── MongoDB Connection for Weekly Subscriptions ──────────────────
let _db = null;
async function getReactDb() {
  if (_db) return _db;
  const uri = getMongoUri();
  if (!uri) throw new Error("Database not configured");
  const client = new MongoClient(uri, { maxPoolSize: 5, family: 4 });
  await client.connect();
  _db = client.db(getMongoDb());
  await _db.collection(WEEKLY_COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
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

// ── Deduplicated Post Booster (Prevents Double Reacting) ─────────
async function boostDetectedPost(sub, postId) {
  const numericId = Number(postId);
  if (!Number.isInteger(numericId) || numericId <= 0) return false;

  const db = await getReactDb();
  const col = db.collection(WEEKLY_COLLECTION);

  // Atomically claim this postId so poller & real-time watcher never double-send
  const claim = await col.updateOne(
    {
      _id: sub._id,
      active: true,
      expiresAt: { $gt: new Date() },
      reactedPostIds: { $ne: numericId },
    },
    {
      $addToSet: { reactedPostIds: numericId },
      $max: { lastReactedPostId: numericId },
      $inc: { reactedPostsCount: 1 },
    }
  );

  if (claim.modifiedCount === 0) return false;

  const postUrl = `https://whatsapp.com/channel/${sub.inviteCode}/${numericId}`;
  try {
    await dispatchPremiumReact(postUrl, sub.count, sub.emojis);
    console.log(`⚡ [Weekly Auto-React] Sent ${sub.count} reacts -> ${postUrl}`);
    return true;
  } catch (err) {
    console.error(`❌ [Weekly Auto-React] Failed for ${postUrl}:`, err.message);
    // Roll back claim so next cycle can retry
    await col.updateOne(
      { _id: sub._id },
      { $pull: { reactedPostIds: numericId }, $inc: { reactedPostsCount: -1 } }
    );
    return false;
  }
}

// ── Multi-Pattern Public Channel HTML & Relay JSON Scraper ───────
async function fetchChannelInfoAndPosts(inviteCode) {
  let title = "WhatsApp Channel";
  const ids = new Set();

  try {
    const res = await fetch(`https://www.whatsapp.com/channel/${inviteCode}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    });
    const html = await res.text();

    const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
    if (titleMatch?.[1]) {
      title = titleMatch[1].replace(/&amp;/g, "&").replace(/&#x27;/g, "'").trim();
    }

    // Pattern 1: Standard URLs (whatsapp.com/channel/CODE/123)
    const standardRe = new RegExp(`whatsapp\\.com/channel/${inviteCode}/(\\d{1,12})`, "g");
    let m;
    while ((m = standardRe.exec(html)) !== null) ids.add(Number(m[1]));

    // Pattern 2: JSON-escaped URLs (whatsapp.com\/channel\/CODE\/123)
    const escapedRe = new RegExp(`whatsapp\\.com\\\\/channel\\\\/${inviteCode}\\\\/(\\d{1,12})`, "g");
    while ((m = escapedRe.exec(html)) !== null) ids.add(Number(m[1]));

    // Pattern 3: Meta Relay JSON server_id / message_id fields
    const serverIdRe = /"(?:server_id|newsletter_server_id|message_server_id)"\s*:\s*"?(\d{1,12})"?/g;
    while ((m = serverIdRe.exec(html)) !== null) {
      const val = Number(m[1]);
      if (val > 0 && val < 100000000) ids.add(val);
    }
  } catch (err) {
    console.warn(`⚠️ Channel HTML fetch warning (${inviteCode}):`, err.message);
  }

  const sortedIds = Array.from(ids).filter((n) => n > 0).sort((a, b) => b - a);
  return { title, postIds: sortedIds };
}

// ── Optional Persistent Baileys Newsletter Watcher ───────────────
let watcherSock = null;
let watcherReady = false;

async function syncWatcherFollows() {
  if (!watcherSock || !watcherReady) return;
  try {
    const db = await getReactDb();
    const subs = await db
      .collection(WEEKLY_COLLECTION)
      .find({ active: true, expiresAt: { $gt: new Date() } })
      .toArray();

    for (const sub of subs) {
      try {
        let jid = sub.jid;
        if (!jid || jid.startsWith(sub.inviteCode)) {
          const meta = await watcherSock.newsletterMetadata("invite", sub.inviteCode);
          if (meta?.id) {
            jid = meta.id;
            await db.collection(WEEKLY_COLLECTION).updateOne(
              { _id: sub._id },
              { $set: { jid, channelName: meta.name || sub.channelName } }
            );
          }
        }
        if (jid && jid.endsWith("@newsletter")) {
          await watcherSock.newsletterFollow(jid);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

async function startBaileysNewsletterWatcher() {
  if (!WATCHER_SESSION_ID) {
    console.log("ℹ️ WATCHER_SESSION_ID not set — running Weekly Auto-React in HTTP Poller mode.");
    return;
  }

  const watcherDir = "./watcher_session";
  try {
    fs.mkdirSync(watcherDir, { recursive: true });
    await restoreCredsToFile(WATCHER_SESSION_ID, path.join(watcherDir, "creds.json"));
  } catch (err) {
    console.warn("⚠️ Could not restore WATCHER_SESSION_ID from MongoDB:", err.message);
    return;
  }

  async function connectWatcher() {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(watcherDir);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1035194821] }));

      const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "fatal" }),
        browser: Browsers.macOS("Safari"),
        markOnlineOnConnect: false,
        syncFullHistory: false,
      });

      watcherSock = sock;
      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          watcherReady = true;
          console.log("✅ Real-Time Newsletter Watcher connected!");
          await syncWatcherFollows();
        } else if (connection === "close") {
          watcherReady = false;
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code !== 401) {
            await delay(5000);
            connectWatcher();
          } else {
            console.warn("🛑 Watcher session logged out (401).");
          }
        }
      });

      // Listen directly to raw XMPP <message from="...@newsletter" server_id="123"> stanzas
      sock.ws.on("CB:message", async (node) => {
        try {
          const from = node?.attrs?.from || "";
          const serverId = node?.attrs?.server_id;
          if (!from.endsWith("@newsletter") || !serverId) return;

          const db = await getReactDb();
          const sub = await db.collection(WEEKLY_COLLECTION).findOne({
            jid: from,
            active: true,
            expiresAt: { $gt: new Date() },
          });
          if (sub) {
            console.log(`📡 [Live Channel Post] Detected post #${serverId} in ${sub.channelName}`);
            await boostDetectedPost(sub, Number(serverId));
          }
        } catch (_) {}
      });
    } catch (err) {
      console.warn("⚠️ Watcher connect error:", err.message);
    }
  }

  await connectWatcher();
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

    const scraped = await fetchChannelInfoAndPosts(inviteCode);
    let channelName = scraped.title;
    let jid = `${inviteCode}@newsletter`;

    // Resolve exact @newsletter JID if watcher socket is online
    if (watcherSock && watcherReady) {
      try {
        const meta = await watcherSock.newsletterMetadata("invite", inviteCode);
        if (meta?.id) jid = meta.id;
        if (meta?.name) channelName = meta.name;
        if (jid.endsWith("@newsletter")) await watcherSock.newsletterFollow(jid);
      } catch (_) {}
    }

    const baselinePostId = scraped.postIds.length > 0 ? scraped.postIds[0] : (specificPostId || 0);
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
      lastReactedPostId: baselinePostId,
      reactedPostIds: scraped.postIds.slice(0, 20),
      reactedPostsCount: 0,
      active: true,
      createdAt: now,
      expiresAt,
      ownerIp: getIP(req),
    };

    await col.updateOne({ inviteCode }, { $set: subDoc }, { upsert: true });

    // If user pasted a specific post URL into weekly mode, boost that post right away too
    if (specificPostId) {
      const savedSub = await col.findOne({ inviteCode });
      if (savedSub) {
        await col.updateOne({ _id: savedSub._id }, { $pull: { reactedPostIds: specificPostId } });
        boostDetectedPost(savedSub, specificPostId).catch(() => {});
      }
    }

    return res.json({
      ok: true,
      message: "Weekly Auto-React Pack activated for 7 days!",
      subscription: {
        inviteCode,
        jid,
        channelName,
        count,
        emojis,
        lastDetectedPostId: baselinePostId,
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
    return res.json({
      ok: true,
      subscription: {
        inviteCode: sub.inviteCode,
        jid: sub.jid,
        channelName: sub.channelName,
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
//  Background Worker: Polls Active Channels Every 60 Seconds
// ═════════════════════════════════════════════════════════════════
export function startWeeklyReactWorker() {
  startBaileysNewsletterWatcher().catch(() => {});

  const POLL_INTERVAL_MS = 60 * 1000; // Check every 60 seconds
  setInterval(async () => {
    try {
      const db = await getReactDb();
      const col = db.collection(WEEKLY_COLLECTION);
      const activeSubs = await col
        .find({ active: true, expiresAt: { $gt: new Date() } })
        .toArray();

      for (const sub of activeSubs) {
        const { postIds } = await fetchChannelInfoAndPosts(sub.inviteCode);
        if (!postIds.length) continue;

        // Detect any new post IDs greater than the baseline when subscribed
        const newPostIds = postIds
          .filter((id) => id > (sub.lastReactedPostId || 0))
          .sort((a, b) => a - b)
          .slice(-5);

        for (const pid of newPostIds) {
          await boostDetectedPost(sub, pid);
        }
      }
    } catch (err) {
      console.warn("⚠️ Weekly React Poller warning:", err.message);
    }
  }, POLL_INTERVAL_MS);

  console.log("🚀 Weekly Channel Auto-React Worker active (60s poller + live watcher)");
}

export default router;
