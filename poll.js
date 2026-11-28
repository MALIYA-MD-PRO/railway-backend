import express from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { MongoClient } from "mongodb";
import { getMongoUri, getMongoDb, getUnbanCode, getSessionSecret } from "./security.js";

const router = express.Router();

const BOT_ENGINE_URL = (process.env.BOT_ENGINE_URL || "https://your-heroku-bot.herokuapp.com").replace(/\/$/, "");
const POLL_MASTER_SECRET = process.env.POLL_MASTER_SECRET || "maliya_poll_secret_2026_change_me";
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const COST_PER_VOTE = 25;
const WELCOME_BONUS_COINS = 50;

let dbInstance = null;
async function getPollDb() {
  if (dbInstance) return dbInstance;
  const client = new MongoClient(getMongoUri(), { maxPoolSize: 10 });
  await client.connect();
  dbInstance = client.db(getMongoDb());
  return dbInstance;
}

function getClientIP(req) {
  const fwd = req.headers["x-forwarded-for"];
  return fwd ? fwd.split(",")[0].trim() : req.socket.remoteAddress || "unknown";
}

function signPayload(bodyObj) {
  const ts = Date.now();
  const sig = crypto
    .createHmac("sha256", POLL_MASTER_SECRET)
    .update(`${ts}.${JSON.stringify(bodyObj)}`)
    .digest("hex");
  return { ts, sig };
}

async function requireGoogleUser(req, res, next) {
  let authUser = (req.isAuthenticated && req.isAuthenticated() && req.user) ? req.user : null;

  if (!authUser) {
    const authHeader = String(req.headers["authorization"] || "");
    if (authHeader.startsWith("Bearer ")) {
      try {
        authUser = jwt.verify(authHeader.slice(7).trim(), getSessionSecret() || "maliya-md-fallback-secret");
      } catch (_) {}
    }
  }

  if (!authUser) {
    return res.status(401).json({
      ok: false,
      requireLogin: true,
      error: "Google Sign-In required to access Poll Vote Service.",
    });
  }

  const email = String(
    authUser.email || authUser.emails?.[0]?.value || ""
  ).trim().toLowerCase();

  if (!email) {
    return res.status(401).json({ ok: false, requireLogin: true, error: "Valid Google email not found." });
  }

  try {
    const db = await getPollDb();
    const usersCol = db.collection("poll_users");
    const ip = getClientIP(req);

    let userDoc = await usersCol.findOne({ email });

    if (!userDoc) {
      const sameIpCount = await usersCol.countDocuments({ signupIp: ip });
      const startingCoins = sameIpCount >= 2 ? 0 : WELCOME_BONUS_COINS;

      userDoc = {
        email,
        name: authUser.displayName || authUser.name || email.split("@")[0],
        avatar: authUser.photos?.[0]?.value || authUser.photo || authUser.picture || "",
        coins: startingCoins,
        totalVotesOrdered: 0,
        signupIp: ip,
        lastIp: ip,
        isBanned: false,
        createdAt: new Date(),
        lastLoginAt: new Date(),
      };
      await usersCol.insertOne(userDoc);
    } else {
      await usersCol.updateOne(
        { email },
        {
          $set: {
            name: authUser.displayName || authUser.name || userDoc.name,
            avatar: authUser.photos?.[0]?.value || authUser.photo || authUser.picture || userDoc.avatar,
            lastIp: ip,
            lastLoginAt: new Date(),
          },
        }
      );
    }

    if (userDoc.isBanned) {
      return res.status(403).json({ ok: false, error: "Your account has been suspended by Admin." });
    }

    req.pollUser = userDoc;
    req.isPollAdmin = ADMIN_EMAILS.includes(email);
    next();
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Database error verifying user." });
  }
}

function requirePollAdmin(req, res, next) {
  if (!req.isPollAdmin) {
    return res.status(403).json({ ok: false, error: "Forbidden: Not an authorized admin account." });
  }
  const secretPin = getUnbanCode();
  const providedPin = String(req.headers["x-admin-pin"] || "").trim();
  if (secretPin && providedPin !== String(secretPin).trim()) {
    return res.status(403).json({ ok: false, needPin: true, error: "Invalid Admin Secret PIN." });
  }
  next();
}

router.get("/me", requireGoogleUser, async (req, res) => {
  const db = await getPollDb();
  const orders = await db
    .collection("poll_orders")
    .find({ email: req.pollUser.email })
    .sort({ createdAt: -1 })
    .limit(25)
    .toArray();

  return res.json({
    ok: true,
    isAdmin: req.isPollAdmin,
    costPerVote: COST_PER_VOTE,
    user: {
      email: req.pollUser.email,
      name: req.pollUser.name,
      avatar: req.pollUser.avatar,
      coins: req.pollUser.coins,
      totalVotesOrdered: req.pollUser.totalVotesOrdered || 0,
      createdAt: req.pollUser.createdAt,
    },
    orders,
  });
});

router.post("/preview", requireGoogleUser, async (req, res) => {
  const pollUrl = String(req.body?.pollUrl || "").trim();
  if (!/^https:\/\/(www\.)?whatsapp\.com\/channel\/[A-Za-z0-9_-]+\/\d+/.test(pollUrl)) {
    return res.status(400).json({
      ok: false,
      error: "Valid Poll Message Link required (e.g. https://whatsapp.com/channel/CODE/123)",
    });
  }

  try {
    const cleanUrl = pollUrl.split("?")[0];
    const { ts, sig } = signPayload({ pollUrl: cleanUrl });
    const engineRes = await fetch(`${BOT_ENGINE_URL}/api/internal/poll-preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-poll-timestamp": String(ts),
        "x-poll-signature": sig,
      },
      body: JSON.stringify({ pollUrl: cleanUrl }),
    });
    const data = await engineRes.json();
    return res.status(engineRes.status).json(data);
  } catch {
    return res.status(502).json({ ok: false, error: "Bot engine offline. Try again shortly." });
  }
});

const voteSchema = z.object({
  pollUrl: z.string().regex(/^https:\/\/(www\.)?whatsapp\.com\/channel\/[A-Za-z0-9_-]+\/\d+/),
  optionIndex: z.coerce.number().int().min(0).max(11),
  optionName: z.string().max(120).optional().default("Selected Option"),
  channelName: z.string().max(120).optional().default("WhatsApp Channel"),
  votesCount: z.coerce.number().int().min(1).max(100),
});

router.post("/vote", requireGoogleUser, async (req, res) => {
  const parsed = voteSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "Invalid poll parameters." });
  }

  const { pollUrl, optionIndex, optionName, channelName, votesCount } = parsed.data;
  const cleanUrl = pollUrl.trim().split("?")[0];
  const totalCost = votesCount * COST_PER_VOTE;
  const email = req.pollUser.email;

  const db = await getPollDb();
  const usersCol = db.collection("poll_users");
  const ordersCol = db.collection("poll_orders");

  const deductResult = await usersCol.findOneAndUpdate(
    { email, coins: { $gte: totalCost }, isBanned: { $ne: true } },
    {
      $inc: { coins: -totalCost, totalVotesOrdered: votesCount },
      $set: { updatedAt: new Date() },
    },
    { returnDocument: "after" }
  );

  const updatedUser = deductResult?.value || deductResult;
  if (!updatedUser || typeof updatedUser.coins !== "number") {
    return res.status(402).json({
      ok: false,
      error: `Insufficient coins! Need ${totalCost} coins (${votesCount} × ${COST_PER_VOTE}), you have ${req.pollUser.coins} coins.`,
    });
  }

  try {
    const payload = {
      pollUrl: cleanUrl,
      optionIndex,
      requestedVotes: votesCount,
      userEmail: email,
    };
    const { ts, sig } = signPayload(payload);

    const engineRes = await fetch(`${BOT_ENGINE_URL}/api/internal/poll-vote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-poll-timestamp": String(ts),
        "x-poll-signature": sig,
      },
      body: JSON.stringify(payload),
    });

    const data = await engineRes.json();

    if (!engineRes.ok || !data.ok) {
      await usersCol.updateOne(
        { email },
        { $inc: { coins: totalCost, totalVotesOrdered: -votesCount } }
      );
      return res.status(engineRes.status || 500).json({
        ok: false,
        error: data.error || "Bot engine error. Coins refunded.",
      });
    }

    await ordersCol.insertOne({
      jobId: data.jobId,
      email,
      userName: req.pollUser.name,
      pollUrl: cleanUrl,
      channelName,
      optionIndex,
      optionName,
      votesCount: data.plannedVotes,
      coinsSpent: totalCost,
      status: "running",
      createdAt: new Date(),
    });

    return res.json({
      ok: true,
      jobId: data.jobId,
      plannedVotes: data.plannedVotes,
      remainingCoins: updatedUser.coins,
      estimatedMinutes: data.estimatedMinutes || 4,
    });
  } catch (err) {
    await usersCol.updateOne(
      { email },
      { $inc: { coins: totalCost, totalVotesOrdered: -votesCount } }
    );
    return res.status(502).json({ ok: false, error: "Bot server unreachable. Coins refunded." });
  }
});

router.get("/status/:jobId", requireGoogleUser, async (req, res) => {
  const jobId = String(req.params.jobId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  try {
    const { ts, sig } = signPayload({});
    const engineRes = await fetch(`${BOT_ENGINE_URL}/api/internal/poll-status/${jobId}`, {
      headers: { "x-poll-timestamp": String(ts), "x-poll-signature": sig },
    });
    const data = await engineRes.json();
    return res.status(engineRes.status).json(data);
  } catch {
    return res.status(502).json({ ok: false, error: "Status check failed." });
  }
});

// ==================== SECRET ADMIN API ROUTES ====================
router.get("/admin/overview", requireGoogleUser, requirePollAdmin, async (_req, res) => {
  const db = await getPollDb();
  const users = await db.collection("poll_users").find({}).sort({ createdAt: -1 }).limit(300).toArray();
  const orders = await db.collection("poll_orders").find({}).sort({ createdAt: -1 }).limit(100).toArray();

  let liveJobs = [];
  try {
    const { ts, sig } = signPayload({});
    const r = await fetch(`${BOT_ENGINE_URL}/api/internal/all-jobs`, {
      headers: { "x-poll-timestamp": String(ts), "x-poll-signature": sig },
    });
    const d = await r.json();
    if (d.ok) liveJobs = d.jobs || [];
  } catch (_) {}

  return res.json({ ok: true, users, orders, liveJobs });
});

router.post("/admin/coins", requireGoogleUser, requirePollAdmin, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const amount = Number(req.body?.amount);
  const mode = req.body?.mode === "set" ? "set" : "add";

  if (!email || !Number.isFinite(amount)) {
    return res.status(400).json({ ok: false, error: "Valid email and coin amount required." });
  }

  const db = await getPollDb();
  const usersCol = db.collection("poll_users");
  const updateOp = mode === "set" ? { $set: { coins: Math.max(0, amount) } } : { $inc: { coins: amount } };

  const result = await usersCol.findOneAndUpdate({ email }, updateOp, { returnDocument: "after" });
  const updated = result?.value || result;
  if (!updated) return res.status(404).json({ ok: false, error: "User not found." });

  return res.json({ ok: true, email, newBalance: updated.coins });
});

router.post("/admin/ban-user", requireGoogleUser, requirePollAdmin, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const isBanned = Boolean(req.body?.isBanned);
  const db = await getPollDb();
  await db.collection("poll_users").updateOne({ email }, { $set: { isBanned } });
  return res.json({ ok: true, email, isBanned });
});

router.post("/admin/add-partner", requireGoogleUser, requirePollAdmin, async (req, res) => {
  const { ts, sig } = signPayload(req.body || {});
  const r = await fetch(`${BOT_ENGINE_URL}/api/internal/partners/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-poll-timestamp": String(ts), "x-poll-signature": sig },
    body: JSON.stringify(req.body || {}),
  });
  const d = await r.json();
  return res.status(r.status).json(d);
});

export default router;
