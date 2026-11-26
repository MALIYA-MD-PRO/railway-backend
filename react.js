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

// In-memory lock to prevent race conditions within the same tick
const inFlightPosts = new Set();

function getApiKey() {
  return CACHED_WPRH_KEY || process.env.WPRH_API_KEY || "";
}

function getWatcherSessionId() {
  return CACHED_WATCHER_SID || (process.env.WATCHER_SESSION_ID || "").trim();
}

// ── Decode HTML Hex/Decimal Entities (e.g. &#x1f341; -> 🍁) ─────
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
  // Auto-expire old deduplication logs after 30 days
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

    // 1. Atomic unique insert: if this postId was EVER boosted before, throws E11000 and stops immediately
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

    // 2. Dispatch reactions to the exact post link
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
      // Remove lock record only if upstream API failed so it can retry later
      await boostedCol.deleteOne({ inviteCode: sub.inviteCode, postId: numericId }).catch(() => {});
      return false;
    }
  } finally {
    inFlightPosts.delete(lockKey);
  }
}

// ── Multi-UA Public Channel Scraper (Fallback Engine) ────────────
async function fetchChannelInfoAndPosts(inviteCode) {
  let title = "WhatsApp Channel";
  const ids = new Set();

  const userAgents = [
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  ];

  for (const ua of userAgents) {
    try {
      const res = await fetch(`https://www.whatsapp.com/channel/${inviteCode}`, {
        headers: {
          "User-Agent": ua,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
        },
      });
      const html = await res.text();

      const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
      if (titleMatch?.[1]) {
        title = decodeHtmlEntities(titleMatch[1]);
      }

      const patterns = [
        new RegExp(`whatsapp\\.com/channel/${inviteCode}/(\\d{1,12})`, "g"),
        new RegExp(`whatsapp\\.com\\\\/channel\\\\/${inviteCode}\\\\/(\\d{1,12})`, "g"),
        /"(?:server_id|newsletter_server_id|message_server_id)"\s*:\s*"?(\d{1,12})"?/g,
      ];

      for (const re of patterns) {
        let m;
        while ((m = re.exec(html)) !== null) {
          const val = Number(m[1]);
          if (val > 0 && val < 100000000) ids.add(val);
        }
      }
      if (ids.size > 0) break;
    } catch (_) {}
  }

  const sortedIds = Array.from(ids).filter((n) => n > 0).sort((a, b) => b - a);
  return { title, postIds: sortedIds };
}

// ── Persistent Baileys Newsletter Watcher (Real-Time + Active Fetch) ──
let watcherSock = null;
let watcherReady = false;

async function syncWatcherFollowsAndPoll() {
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
              {
                $set: {
                  jid,
                  channelName: decodeHtmlEntities(meta.name || sub.channelName),
                },
              }
            );
          }
        }

        if (jid && jid.endsWith("@newsletter")) {
          await watcherSock.newsletterFollow(jid).catch(() => {});
        }

        // Actively fetch latest 3 messages from the channel as backup to live push
        if (typeof watcherSock.newsletterFetchMessages === "function") {
          const msgs = await watcherSock.newsletterFetchMessages("invite", sub.inviteCode, 3, undefined).catch(() => null);
          const list = Array.isArray(msgs) ? msgs : (msgs?.messages || []);
          const fetchedIds = list
            .map((m) => Number(m?.server_id || m?.attrs?.server_id || m?.key?.serverId || 0))
            .filter((n) => n > 0)
            .sort((a, b) => b - a);

          if (fetchedIds.length > 0) {
            const newest = fetchedIds[0];
            // If channel had no baseline yet, set baseline to current newest so old posts aren't spammed
            if (!sub.lastReactedPostId || sub.lastReactedPostId === 0) {
              await db.collection(WEEKLY_COLLECTION).updateOne(
                { _id: sub._id },
                { $set: { lastReactedPostId: newest } }
              );
            } else if (newest > sub.lastReactedPostId) {
              await boostDetectedPost(sub, newest);
            }
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
}

async function startBaileysNewsletterWatcher() {
  const sid = getWatcherSessionId();
  if (!sid) {
    console.log("⚠️ WATCHER_SESSION_ID not set — add a spare session ID in Railway Variables for 1s live post detection.");
    return;
  }

  const watcherDir = "./watcher_session";
  try {
    fs.mkdirSync(watcherDir, { recursive: true });
    await restoreCredsToFile(sid, path.join(watcherDir, "creds.json"));
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
          console.log("✅ Real-Time Newsletter Watcher connected & monitoring channels!");
          await syncWatcherFollowsAndPoll();
        } else if (connection === "close") {
          watcherReady = false;
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code !== 401) {
            await delay(5000);
            connectWatcher();
          } else {
            console.warn("🛑 Watcher session logged out (401). Update WATCHER_SESSION_ID.");
          }
        }
      });

      // Engine 1: Raw XMPP <message from="120363...@newsletter" server_id="825"> push
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
            console.log(`📡 [Live Channel Post] Detected #${serverId} in ${sub.channelName}`);
            await boostDetectedPost(sub, Number(serverId));
          }
        } catch (_) {}
      });

      // Engine 2: Baileys parsed messages.upsert for @newsletter
      sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
          for (const msg of messages || []) {
            const jid = msg?.key?.remoteJid || "";
            const serverId = msg?.key?.serverId || msg?.messageStubParameters?.[0];
            if (!jid.endsWith("@newsletter") || !serverId) continue;

            const db = await getReactDb();
            const sub = await db.collection(WEEKLY_COLLECTION).findOne({
              jid,
              active: true,
              expiresAt: { $gt: new Date() },
            });
            if (sub) {
              await boostDetectedPost(sub, Number(serverId));
            }
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
    let channelName = decodeHtmlEntities(scraped.title);
    let jid = `${inviteCode}@newsletter`;
    let baselinePostId = scraped.postIds.length > 0 ? scraped.postIds[0] : (specificPostId || 0);

    // Resolve real @newsletter JID & follow channel immediately if watcher socket is online
    if (watcherSock && watcherReady) {
      try {
        const meta = await watcherSock.newsletterMetadata("invite", inviteCode);
        if (meta?.id) jid = meta.id;
        if (meta?.name) channelName = decodeHtmlEntities(meta.name);
        if (jid.endsWith("@newsletter")) {
          await watcherSock.newsletterFollow(jid);
        }
        if (typeof watcherSock.newsletterFetchMessages === "function") {
          const msgs = await watcherSock.newsletterFetchMessages("invite", inviteCode, 2, undefined).catch(() => null);
          const list = Array.isArray(msgs) ? msgs : (msgs?.messages || []);
          const ids = list
            .map((m) => Number(m?.server_id || m?.attrs?.server_id || 0))
            .filter((n) => n > 0)
            .sort((a, b) => b - a);
          if (ids.length > 0 && ids[0] > baselinePostId) {
            baselinePostId = ids[0];
          }
        }
      } catch (_) {}
    }

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
      reactedPostsCount: 0,
      active: true,
      createdAt: now,
      expiresAt,
      ownerIp: getIP(req),
    };

    await col.updateOne({ inviteCode }, { $set: subDoc }, { upsert: true });

    // If user pasted a specific post URL into weekly mode, boost that post strictly once right away
    if (specificPostId) {
      const savedSub = await col.findOne({ inviteCode });
      if (savedSub) {
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
        liveWatcherConnected: watcherReady,
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
        liveWatcherConnected: watcherReady,
        expiresAt: sub.expiresAt,
      },
    });
  } catch {
    return res.status(500).json({ ok: false, error: "Failed to check status." });
  }
});

// ═════════════════════════════════════════════════════════════════
//  Background Worker: Runs Active Watcher Sync & Fallback Poller (45s)
// ═════════════════════════════════════════════════════════════════
export function startWeeklyReactWorker() {
  startBaileysNewsletterWatcher().catch(() => {});

  const POLL_INTERVAL_MS = 15 * 1000;
  setInterval(async () => {
    try {
      // 1. Run Baileys active channel follow + fetch check
      await syncWatcherFollowsAndPoll();

      // 2. Run HTTP multi-UA fallback check
      const db = await getReactDb();
      const col = db.collection(WEEKLY_COLLECTION);
      const activeSubs = await col
        .find({ active: true, expiresAt: { $gt: new Date() } })
        .toArray();

      for (const sub of activeSubs) {
        const { postIds } = await fetchChannelInfoAndPosts(sub.inviteCode);
        if (!postIds.length) continue;

        const newestId = postIds[0];
        if (!sub.lastReactedPostId || sub.lastReactedPostId === 0) {
          await col.updateOne({ _id: sub._id }, { $set: { lastReactedPostId: newestId } });
          continue;
        }

        if (newestId > sub.lastReactedPostId) {
          // Only boost the newest post (or up to 2 newest) — strictly once each via unique index
          const candidates = postIds
            .filter((id) => id > sub.lastReactedPostId)
            .sort((a, b) => a - b)
            .slice(-2);

          for (const pid of candidates) {
            await boostDetectedPost(sub, pid);
          }
        }
      }
    } catch (err) {
      console.warn("⚠️ Weekly React Worker warning:", err.message);
    }
  }, POLL_INTERVAL_MS);

  console.log("🚀 Weekly Channel Auto-React Worker started (Live XMPP + 45s Active Poller)");
}

export default router;
