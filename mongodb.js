import fs from "fs";
import path from "path";
import dns from "dns";
import zlib from "zlib";
import { MongoClient } from "mongodb";
import { getMongoUri, getMongoDb, getSessionCollection } from "./security.js";

// 🔥 fix DNS issues (Heroku important)
dns.setDefaultResultOrder("ipv4first");

// Read from security.js accessor — process.env vars are deleted at startup
const MONGODB_URI        = getMongoUri();
const MONGODB_DB         = getMongoDb();
const SESSION_COLLECTION = getSessionCollection();

let cachedClient = null;
let cachedDb = null;

/* ================= DB CONNECT ================= */

async function getDb() {
  if (cachedDb) return cachedDb;

  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is missing");
  }

  cachedClient = new MongoClient(MONGODB_URI, {
    maxPoolSize: 10,
    family: 4,
    serverSelectionTimeoutMS: 15000,
  });

  await cachedClient.connect();
  cachedDb = cachedClient.db(MONGODB_DB);
  console.log("✅ Connected to MongoDB");
  return cachedDb;
}

/* ================= HELPERS ================= */

function fileToBase64(filePath) {
  return fs.readFileSync(filePath).toString("base64");
}

function normalizeSessionId(value) {
  return String(value || "").trim();
}

/* ================= UPLOAD ================= */

export async function upload(filePath, fileName, options = {}) {
  const db = await getDb();
  const col = db.collection(SESSION_COLLECTION);

  const sessionId = normalizeSessionId(
    options.sessionId ||
      path.parse(fileName || "session").name ||
      `session_${Date.now()}`,
  );

  const now = new Date();

  // Folder එකේ තියෙන සියලුම JSON files (creds + signal keys) Compress කිරීම
  let authBundle = null;
  try {
    const authDir = path.dirname(filePath);
    if (fs.existsSync(authDir)) {
      const filesMap = {};
      for (const file of fs.readdirSync(authDir)) {
        if (file.endsWith(".json")) {
          filesMap[file] = fs.readFileSync(path.join(authDir, file)).toString("base64");
        }
      }
      const compressed = zlib.gzipSync(JSON.stringify(filesMap)).toString("base64");
      authBundle = {
        encoding: "gzip+base64",
        fileCount: Object.keys(filesMap).length,
        data: compressed,
      };
    }
  } catch (err) {
    console.warn("⚠️ Could not create authBundle (continuing with creds.json):", err.message);
  }

  const uploadDoc = {
    sessionId,
    fileName: fileName || path.basename(filePath),
    primaryFile: {
      name: fileName || path.basename(filePath),
      mimeType: "application/json",
      data: fileToBase64(filePath),
    },
    ...(authBundle ? { authBundle } : {}),
    status: options.status || "ready",
    connectBot: options.connectBot ?? true,
    source: options.source || "pair-site",
    phone: options.phone || null,
    updatedAt: now,
  };

  await col.updateOne(
    { sessionId },
    {
      $set: uploadDoc,
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );

  console.log(`💾 Session saved (with ${authBundle?.fileCount || 1} files):`, sessionId);

  return sessionId;
}

/* ================= SAVE SESSION ================= */

export async function saveSessionState(options = {}) {
  const {
    sessionId,
    phone,
    filePath,
    fileName,
    source = "pair-site",
  } = options;

  if (!filePath) {
    throw new Error("filePath is required");
  }

  return upload(filePath, fileName || path.basename(filePath), {
    sessionId,
    phone,
    source,
    status: "ready",
    connectBot: true,
  });
}

/* ================= GET SESSION ================= */

export async function getSessionById(sessionId) {
  const db = await getDb();
  const col = db.collection(SESSION_COLLECTION);

  return col.findOne({ sessionId: normalizeSessionId(sessionId) });
}

/* ================= RESTORE CREDS ================= */

export async function restoreCredsToFile(sessionId, targetFilePath) {
  const doc = await getSessionById(sessionId);

  if (!doc) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (!doc.primaryFile?.data) {
    throw new Error(`No primaryFile found for session: ${sessionId}`);
  }

  const authDir = path.dirname(targetFilePath);
  fs.mkdirSync(authDir, { recursive: true });

  if (doc.authBundle?.data) {
    try {
      const compressedBuf = Buffer.from(doc.authBundle.data, "base64");
      const jsonStr = zlib.gunzipSync(compressedBuf).toString("utf8");
      const filesMap = JSON.parse(jsonStr);

      for (const [fileName, base64Content] of Object.entries(filesMap)) {
        const safeName = path.basename(fileName);
        fs.writeFileSync(path.join(authDir, safeName), Buffer.from(base64Content, "base64"));
      }
      console.log("📂 Restored full auth bundle:", sessionId);
      return targetFilePath;
    } catch (err) {
      console.warn("⚠️ Auth bundle extract failed, falling back to creds.json:", err.message);
    }
  }

  fs.writeFileSync(targetFilePath, Buffer.from(doc.primaryFile.data, "base64"));
  console.log("📂 Restored creds:", sessionId);

  return targetFilePath;
}

/* ================= KEEP-ALIVE / WARMUP ================= */

export async function warmupDb() {
  try {
    await getDb();
    console.log("🔗 MongoDB connection pre-warmed");
  } catch (e) {
    console.warn("⚠️ MongoDB pre-warm failed (will retry on first use):", e.message);
  }
}

export async function keepAlivePing() {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
  } catch (e) {
    cachedClient = null;
    cachedDb = null;
    console.warn("⚠️ MongoDB keepalive ping failed — will reconnect on next use:", e.message);
  }
}

/* ================= CLOSE ================= */

export async function closeMongoConnection() {
  try {
    if (cachedClient) {
      await cachedClient.close();
    }
  } catch (err) {
    console.error("Error closing MongoDB connection:", err);
  } finally {
    cachedClient = null;
    cachedDb = null;
  }
}
