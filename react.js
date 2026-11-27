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
import { createRequire } from "module";
import { getMongoUri, getMongoDb, redactSensitive } from "./security.js";
import { restoreCredsToFile } from "./mongodb.js";

const require = createRequire(import.meta.url);
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

function getRandomSleepMs() {
  const MIN_MS = 2 * 60 * 1000;
  const MAX_MS = 6.5 * 60 * 1000;
  return Math.floor(MIN_MS + Math.random() * (MAX_MS - MIN_MS));
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
      if (dupErr?.code === 11000) return false;
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

async function fetchChannelInfoAndDiag(inviteCode) {
  let title = "WhatsApp Channel";
  const ids = new Set();
  let htmlLen = 0;
  let httpStatus = 0;

  try {
    const res = await fetch(`https://www.whatsapp.com/channel/${inviteCode}`, {
      headers: {
        "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    httpStatus = res.status;
    const html = await res.text();
    htmlLen = html.length;

    const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
    if (titleMatch?.[1]) title = decodeHtmlEntities(titleMatch[1]);

    const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/i);
    const ogDesc = descMatch?.[1] ? decodeHtmlEntities(descMatch[1]).slice(0, 80) : "none";

    const patterns = [
      new RegExp(`whatsapp\\.com/channel/${inviteCode}/(\\d{1,12})`, "g"),
      new RegExp(`whatsapp\\.com\\\\/channel\\\\/${inviteCode}\\\\/(\\d{1,12})`, "g"),
      /"(?:server_id|newsletter_server_id|message_server_id|post_id)"\s*:\s*"?(\d{1,12})"?/g,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(html)) !== null) {
        const val = Number(m[1]);
        if (val > 0 && val < 100000000) ids.add(val);
      }
    }

    console.log(
      `🌐 [DIAG HTTP] code=${inviteCode} status=${httpStatus} htmlLen=${htmlLen} title="${title}" ogDesc="${ogDesc}" extractedIds=[${Array.from(ids).join(",")}]`
    );
  } catch (err) {
    console.log(`🌐 [DIAG HTTP ERR] code=${inviteCode} err=${err.message}`);
  }

  return { title, postIds: Array.from(ids).sort((a, b) => b - a) };
}

// ═════════════════════════════════════════════════════════════════
//  FULL DIAGNOSTIC WAKE -> CHECK -> SLEEP CYCLE
// ═════════════════════════════════════════════════════════════════
async function runWakeCheckSleepCycle() {
  if (isCycleRunning) return;
  isCycleRunning = true;

  let activeSock = null;
  try {
    // 1. Log Baileys version & environment info
    let baileysPkgVer = "unknown";
    try {
      baileysPkgVer = require("@whiskeysockets/baileys/package.json").version;
    } catch (_) {}

    const db = await getReactDb();
    const subsCol = db.collection(WEEKLY_COLLECTION);

    const activeSubs = await subsCol
      .find({ active: true, expiresAt: { $gt: new Date() } })
      .toArray();

    console.log(
      `📊 [DIAG ENV] baileysPkg=${baileysPkgVer} | activeSubs=${activeSubs.length} | watcherSidPresent=${Boolean(getWatcherSessionId())} | wprhKeyPresent=${Boolean(getApiKey())}`
    );

    if (activeSubs.length === 0) {
      return;
    }

    for (const s of activeSubs) {
      console.log(
        `📋 [DIAG SUB] name="${s.channelName}" inviteCode=${s.inviteCode} jid=${s.jid} followed=${Boolean(s.followed)} lastReacted=${s.lastReactedPostId || 0} boostedCount=${s.reactedPostsCount || 0}`
      );
    }

    const sid = getWatcherSessionId();
    const watcherDir = "./watcher_session";

    if (sid) {
      if (!watcherInitialized || !fs.existsSync(path.join(watcherDir, "creds.json"))) {
        fs.mkdirSync(watcherDir, { recursive: true });
        await restoreCredsToFile(sid, path.join(watcherDir, "creds.json"));
        watcherInitialized = true;
      }

      const { state, saveCreds } = await useMultiFileAuthState(watcherDir);
      console.log(
        `🔑 [DIAG CREDS] registered=${state?.creds?.registered} | me=${JSON.stringify(state?.creds?.me || null)}`
      );

      const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({
        version: [2, 3000, 1035194821],
        isLatest: false,
      }));
      console.log(`📡 [DIAG WA-VER] protocolVersion=${JSON.stringify(version)} isLatest=${isLatest}`);

      const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "warn" }), // Print Baileys internal warnings/errors to console!
        browser: Browsers.macOS("Safari"),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        connectTimeoutMs: 30000,
        defaultQueryTimeoutMs: 30000,
      });
      activeSock = sock;

      // List all newsletter-related methods available on this Baileys socket
      const newsletterMethods = Object.keys(sock).filter((k) =>
        k.toLowerCase().includes("newsletter")
      );
      console.log(`🧰 [DIAG METHODS] sock newsletter methods = [${newsletterMethods.join(", ")}]`);

      sock.ev.on("creds.update", saveCreds);

      // Log ALL incoming XMPP stanzas related to newsletters or notifications
      sock.ws.on("CB:message", (node) => {
        console.log(`📨 [DIAG CB:message] attrs=${JSON.stringify(node?.attrs || {})}`);
      });
      sock.ws.on("CB:notification", (node) => {
        if (String(node?.attrs?.from || "").includes("newsletter") || node?.attrs?.type === "newsletter") {
          console.log(`🔔 [DIAG CB:notification] attrs=${JSON.stringify(node?.attrs || {})}`);
        }
      });

      sock.ev.on("messages.upsert", (upsert) => {
        const summary = (upsert?.messages || []).map((m) => ({
          jid: m?.key?.remoteJid,
          id: m?.key?.id,
          serverId: m?.key?.serverId,
          stub: m?.messageStubParameters,
        }));
        console.log(`📥 [DIAG messages.upsert] type=${upsert?.type} msgs=${JSON.stringify(summary)}`);
      });

      const connected = await new Promise((resolve) => {
        let settled = false;
        const done = (val) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(val);
          }
        };
        const timer = setTimeout(() => {
          console.log("⏱️ [DIAG CONN] Timeout waiting 30s for connection=open");
          done(false);
        }, 30000);

        sock.ev.on("connection.update", (upd) => {
          const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = upd;
          console.log(
            `🔌 [DIAG CONN] connection=${connection || "none"} qr=${Boolean(qr)} isNewLogin=${Boolean(isNewLogin)} pendingNotif=${Boolean(receivedPendingNotifications)}`
          );
          if (lastDisconnect) {
            console.log(
              `❌ [DIAG DISCONNECT] statusCode=${lastDisconnect?.error?.output?.statusCode} message=${lastDisconnect?.error?.message} stack=${String(lastDisconnect?.error?.stack || "").split("\n")[0]}`
            );
          }
          if (connection === "open") {
            done(true);
          } else if (connection === "close") {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === 401 || code === 403 || code === 405) {
              done(false);
            }
          }
        });
      });

      console.log(`🏁 [DIAG CONN RESULT] connected=${connected}`);

      if (connected) {
        await delay(5000);

        for (const sub of activeSubs) {
          console.log(`🔍 [DIAG CHANNEL TEST] Testing ${sub.channelName} (${sub.inviteCode})...`);

          // Test A: newsletterMetadata
          if (typeof sock.newsletterMetadata === "function") {
            try {
              const meta = await sock.newsletterMetadata("invite", sub.inviteCode);
              console.log(`✅ [DIAG META] ${sub.inviteCode} -> ${JSON.stringify(meta)}`);
              if (meta?.id && meta.id !== sub.jid) {
                await subsCol.updateOne(
                  { _id: sub._id },
                  { $set: { jid: meta.id, channelName: decodeHtmlEntities(meta.name || sub.channelName) } }
                );
                sub.jid = meta.id;
              }
            } catch (e) {
              console.log(`❌ [DIAG META ERR] ${sub.inviteCode} -> ${e.message}`);
            }
          }

          // Test B: newsletterFollow
          if (typeof sock.newsletterFollow === "function" && sub.jid?.endsWith("@newsletter")) {
            try {
              const fol = await sock.newsletterFollow(sub.jid);
              console.log(`✅ [DIAG FOLLOW] ${sub.jid} -> ${JSON.stringify(fol ?? "ok")}`);
            } catch (e) {
              console.log(`❌ [DIAG FOLLOW ERR] ${sub.jid} -> ${e.message}`);
            }
          }

          // Test C: newsletterFetchMessages
          if (typeof sock.newsletterFetchMessages === "function") {
            try {
              const msgs = await sock.newsletterFetchMessages("invite", sub.inviteCode, 5, undefined);
              console.log(
                `✅ [DIAG FETCH MSGS] ${sub.inviteCode} -> type=${typeof msgs} raw=${JSON.stringify(msgs).slice(0, 600)}`
              );
            } catch (e) {
              console.log(`❌ [DIAG FETCH MSGS ERR] ${sub.inviteCode} -> ${e.message}`);
            }
          }
        }

        await saveCreds().catch(() => {});
      }
    }

    // Also log public HTML check
    for (const sub of activeSubs) {
      await fetchChannelInfoAndDiag(sub.inviteCode);
    }
  } catch (err) {
    console.error("💥 [DIAG FATAL]", err);
  } finally {
    if (activeSock) {
      try {
        activeSock.ev.removeAllListeners();
        activeSock.end(new Error("diag sleep"));
      } catch (_) {}
    }
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
    if (!count) return res.status(400).json({ ok: false, error: "Count must be an integer between 1 and 3500." });

    const emojis = validateEmojis(req.body?.emojis);
    if (!emojis) return res.status(400).json({ ok: false, error: "Select between 1 and 10 valid emojis." });

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
    if (!count) return res.status(400).json({ ok: false, error: "Count per post must be between 1 and 3500." });

    const emojis = validateEmojis(req.body?.emojis);
    if (!emojis) return res.status(400).json({ ok: false, error: "Select between 1 and 10 valid emojis." });

    const scraped = await fetchChannelInfoAndDiag(inviteCode);
    const channelName = decodeHtmlEntities(scraped.title);
    const jid = `${inviteCode}@newsletter`;
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
      if (savedSub) boostDetectedPost(savedSub, specificPostId).catch(() => {});
    }

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

  console.log("🚀 Weekly Channel Auto-React Worker active (Diagnostic Mode)");
}

export default router;
