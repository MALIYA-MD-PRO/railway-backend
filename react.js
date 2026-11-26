import express from "express";
import rateLimit from "express-rate-limit";
import { MongoClient } from "mongodb";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
} from "@whiskeysockets/baileys";
import pino from "pino";
import fs from "fs";
import path from "path";
import { getMongoUri, getMongoDb, redactSensitive } from "./security.js";

const router = express.Router();

const WPRH_API_URL = "https://wp-react-hub.vercel.app/api/premium-submit";
const WPRH_API_KEY = process.env.WPRH_API_KEY || "";
const WEEKLY_COLLECTION = "weekly_react_subs";

const CHANNEL_POST_RE = /^https?:\/\/(www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]{10,45})\/(\d{1,12})\/?$/;
const CHANNEL_ONLY_RE = /^https?:\/\/(www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]{10,45})\/?$/;

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

// ── Rate Limiters (Security) ─────────────────────────────────────
function getIP(req) {
  const fwd = req.headers["x-forwarded-for"];
  return fwd ? fwd.split(",")[0].trim() : req.socket.remoteAddress;
}

const singleReactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 15,
  keyGenerator: getIP,
  message: { ok: false, error: "Hourly react limit reached. Try again later." },
});

const weeklySubLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 3,
  keyGenerator: getIP,
  message: { ok: false, error: "Daily weekly-pack limit reached (max 3 channels/day)." },
});

// ── Input Sanitization Helpers ───────────────────────────────────
function validateEmojis(emojis) {
  if (!Array.isArray(emojis) || emojis.length === 0 || emojis.length > 5) {
    return null;
  }
  const clean = emojis
    .map((e) => String(e || "").trim())
    .filter((e) => e.length > 0 && e.length <= 12 && !/[<>{}"'`;\\]/.test(e));
  return clean.length > 0 ? clean.slice(0, 5) : null;
}

function validateCount(count) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > 3500) return null;
  return n;
}

// ── Helper: Send Reacts via Upstream Premium API ─────────────────
async function dispatchPremiumReact(postUrl, count, emojis) {
  if (!WPRH_API_KEY) {
    throw new Error("React service API key is not configured on server.");
  }
  const res = await fetch(WPRH_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": WPRH_API_KEY,
    },
    body: JSON.stringify({ url: postUrl, count, emojis }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.message || `Upstream API error (${res.status})`);
  }
  return data;
}

// ── Helper: Resolve Channel Invite Code -> JID & Metadata ────────
async function resolveChannelMetadata(inviteCode) {
  // 1. Try lightweight HTML/OG metadata fetch first (fast & zero session needed)
  let title = "WhatsApp Channel";
  let description = "";
  try {
    const pageRes = await fetch(`https://whatsapp.com/channel/${inviteCode}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
      },
    });
    const html = await pageRes.text();
    const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
    const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/i);
    if (titleMatch?.[1]) title = titleMatch[1].replace(/&amp;/g, "&").trim();
    if (descMatch?.[1]) description = descMatch[1].replace(/&amp;/g, "&").trim();
  } catch (_) {}

  // 2. Try Baileys newsletterMetadata if a linked session exists in auth_info / sessions
  let jid = null;
  let subscribers = null;
  try {
    const sessionDirs = ["./session", "./auth_info_baileys", "./sessions"];
    const existingDir = sessionDirs.find((d) => fs.existsSync(path.join(d, "creds.json")));
    if (existingDir) {
      const { state } = await useMultiFileAuthState(existingDir);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1035194821] }));
      const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "fatal" }),
        browser: Browsers.macOS("Safari"),
        syncFullHistory: false,
      });

      const meta = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 8000);
        sock.ev.on("connection.update", async ({ connection }) => {
          if (connection === "open") {
            try {
              const info = await sock.newsletterMetadata("invite", inviteCode);
              clearTimeout(timer);
              resolve(info);
            } catch (err) {
              clearTimeout(timer);
              reject(err);
            }
          }
        });
      });

      if (meta?.id) jid = meta.id;
      if (meta?.name) title = meta.name;
      if (typeof meta?.subscribers === "number") subscribers = meta.subscribers;
      try { sock.end(); } catch (_) {}
    }
  } catch (_) {}

  // Fallback deterministic newsletter JID representation if socket wasn't online
  if (!jid) {
    jid = `${inviteCode}@newsletter`;
  }

  return { jid, title, description, subscribers, inviteCode };
}

// ── Helper: Scrape Latest Post IDs from Public Channel Page ──────
async function fetchLatestChannelPostIds(inviteCode) {
  try {
    const res = await fetch(`https://whatsapp.com/channel/${inviteCode}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
      },
    });
    const html = await res.text();
    const regex = new RegExp(`whatsapp\\.com/channel/${inviteCode}/(\\d+)`, "g");
    const ids = new Set();
    let m;
    while ((m = regex.exec(html)) !== null) {
      ids.add(Number(m[1]));
    }
    return Array.from(ids).sort((a, b) => b - a);
  } catch {
    return [];
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
      return res.status(400).json({ ok: false, error: "Select between 1 and 5 valid emojis." });
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
    const count = validateCount(req.body?.count);
    if (!count) {
      return res.status(400).json({ ok: false, error: "Count per post must be between 1 and 3500." });
    }

    const emojis = validateEmojis(req.body?.emojis);
    if (!emojis) {
      return res.status(400).json({ ok: false, error: "Select between 1 and 5 valid emojis." });
    }

    const meta = await resolveChannelMetadata(inviteCode);
    const existingPosts = await fetchLatestChannelPostIds(inviteCode);
    const latestPostId = existingPosts.length > 0 ? existingPosts[0] : 0;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const db = await getReactDb();
    const col = db.collection(WEEKLY_COLLECTION);

    const subDoc = {
      inviteCode,
      jid: meta.jid,
      channelName: meta.title,
      subscribers: meta.subscribers,
      count,
      emojis,
      lastReactedPostId: latestPostId,
      reactedPostsCount: 0,
      active: true,
      createdAt: now,
      expiresAt,
      ownerIp: getIP(req),
    };

    await col.updateOne(
      { inviteCode },
      { $set: subDoc },
      { upsert: true }
    );

    // If user also passed a specific post URL in weekly mode, react to it immediately
    if (match[3]) {
      dispatchPremiumReact(`https://whatsapp.com/channel/${inviteCode}/${match[3]}`, count, emojis).catch(() => {});
    }

    return res.json({
      ok: true,
      message: "Weekly Auto-React Pack activated for 7 days!",
      subscription: {
        inviteCode,
        jid: meta.jid,
        channelName: meta.title,
        subscribers: meta.subscribers,
        count,
        emojis,
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
        reactedPostsCount: sub.reactedPostsCount || 0,
        expiresAt: sub.expiresAt,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Failed to check status." });
  }
});

// ═════════════════════════════════════════════════════════════════
//  Background Poller: Checks Active Weekly Channels Every 2 Mins
// ═════════════════════════════════════════════════════════════════
export function startWeeklyReactWorker() {
  const INTERVAL_MS = 2 * 60 * 1000;
  setInterval(async () => {
    try {
      const db = await getReactDb();
      const col = db.collection(WEEKLY_COLLECTION);
      const activeSubs = await col
        .find({ active: true, expiresAt: { $gt: new Date() } })
        .toArray();

      for (const sub of activeSubs) {
        const postIds = await fetchLatestChannelPostIds(sub.inviteCode);
        if (!postIds.length) continue;

        const newestId = postIds[0];
        if (newestId > (sub.lastReactedPostId || 0)) {
          const newPosts = postIds.filter((id) => id > (sub.lastReactedPostId || 0)).slice(0, 3);
          for (const pid of newPosts) {
            const postUrl = `https://whatsapp.com/channel/${sub.inviteCode}/${pid}`;
            try {
              await dispatchPremiumReact(postUrl, sub.count, sub.emojis);
              console.log(`⚡ Auto-Reacted [${sub.count}] to ${sub.channelName} post #${pid}`);
            } catch (e) {
              console.warn(`⚠️ Auto-React failed for ${sub.inviteCode}/${pid}:`, e.message);
            }
          }
          await col.updateOne(
            { _id: sub._id },
            {
              $set: { lastReactedPostId: newestId },$inc: { reactedPostsCount: newPosts.length },
            }
          );
        }
      }
    } catch (err) {
      console.warn("⚠️ Weekly React Worker error:", err.message);
    }
  }, INTERVAL_MS);
  console.log("🚀 Weekly Channel Auto-React Worker started");
}

export default router;
