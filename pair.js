import express from "express";
import fs from "fs";
import pino from "pino";
import { z } from "zod";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
} from "@whiskeysockets/baileys";
import { phone as validatePhone } from "phone";
import { saveSessionState } from "./mongodb.js";
import { setSessionId } from "./session-store.js";

// ─────────────────────────────────────────────────────────────────
//  Zod schema — International E.164 Phone Number Validation
// ─────────────────────────────────────────────────────────────────
const phoneQuerySchema = z.object({
    number: z
        .string({ required_error: "Phone number is required." })
        .min(7, "Phone number too short — include country code (min 7 digits).")
        .max(15, "Phone number too long — maximum 15 digits.")
        .regex(/^[1-9][0-9]{6,14}$/, "Enter country code + phone number without + or leading 0."),
});

const router = express.Router();

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error("Error removing file:", e);
    }
}

function generateMegaStyleId() {
    const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    function randomString(len) {
        let str = "";
        for (let i = 0; i < len; i++)
            str += chars[Math.floor(Math.random() * chars.length)];
        return str;
    }
    return `${randomString(8)}#${randomString(43)}`;
}

router.get("/", async (req, res) => {
    const isWatcher = req.query.watcher === "1";

    // ── Normalize international number (strip +, spaces, dashes, and leading 00 exit prefix)
    let rawNum = String(req.query.number ?? "").replace(/[^0-9]/g, "");
    if (rawNum.startsWith("00")) {
        rawNum = rawNum.slice(2);
    }

    const parsed = phoneQuerySchema.safeParse({ number: rawNum });
    if (!parsed.success) {
        const msg = parsed.error.errors[0]?.message || "Invalid international phone number.";
        console.warn(`⚠️ Rejected phone input: "${req.query.number}" — ${msg}`);
        return res.status(400).send({ code: msg });
    }

    let num = parsed.data.number;

    // ── Flexible international validation (supports all countries & virtual numbers)
    const phoneResult = validatePhone("+" + num, { validateMobilePrefix: false });
    if (phoneResult.isValid && phoneResult.phoneNumber) {
        num = phoneResult.phoneNumber.replace("+", "");
    }

    if (!fs.existsSync("./pair_sessions")) {
        fs.mkdirSync("./pair_sessions", { recursive: true });
    }

    const tempId = `${num}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const dirs = `./pair_sessions/${tempId}`;
    removeFile(dirs);

    const sessionId = generateMegaStyleId();
    let codeSent = false;
    let pairingRequested = false;
    let sessionDone = false;
    let reconnecting = false;
    let reconnectAttempts = 0;
    const MAX_RECONNECTS = 4;

    // ── Hard 2-minute session lifetime so abandoned requests NEVER loop forever
    let activeSocket = null;
    const hardTimeout = setTimeout(() => {
        if (!sessionDone) {
            sessionDone = true;
            console.log(`⏱️ Pairing session timed out (2m) for ${num} — cleaning up.`);
            if (!res.headersSent) {
                res.status(408).send({ code: "Pairing timeout. Please try again." });
            }
            if (activeSocket) {
                try {
                    activeSocket.ev.removeAllListeners();
                    activeSocket.end(new Error("session timeout"));
                } catch (_) {}
            }
            removeFile(dirs);
        }
    }, 2 * 60 * 1000);

    function finishSession(sock) {
        sessionDone = true;
        clearTimeout(hardTimeout);
        if (sock) {
            try {
                sock.ev.removeAllListeners();
                sock.end(new Error("session finished"));
            } catch (_) {}
        }
        removeFile(dirs);
    }

    async function initiateSession() {
        if (sessionDone) return;

        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        const safeSaveCreds = async () => {
            try {
                await saveCreds();
            } catch (e) {
                console.error("⚠️ creds.update write error (non-fatal):", e.message);
            }
        };

        try {
            let version;
            try {
                const fetched = await fetchLatestBaileysVersion();
                version = fetched.version;
            } catch (_) {
                version = [2, 3000, 1035194821];
            }

            const KnightBot = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        pino({ level: "fatal" }).child({ level: "fatal" }),
                    ),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.macOS("Safari"),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                syncFullHistory: false,
                getMessage: async () => ({ conversation: "hello" }),
                patchMessageBeforeSending: (m) => m,
                defaultQueryTimeoutMs: 30000,
                connectTimeoutMs: 25000,
                keepAliveIntervalMs: 25000,
                retryRequestDelayMs: 300,
                maxMsgRetryCount: 3,
            });

            activeSocket = KnightBot;
            KnightBot.ev.on("creds.update", safeSaveCreds);

            KnightBot.ev.on("connection.update", async (update) => {
                if (sessionDone) return;

                const { connection, lastDisconnect, isNewLogin } = update;

                if (connection === "open") {
                    sessionDone = true;
                    clearTimeout(hardTimeout);
                    console.log("✅ Connected — Sending welcome notice & saving to DB...");

                    try {
                        const targetUserJid = KnightBot.user?.id
                            ? jidNormalizedUser(KnightBot.user.id)
                            : `${num}@s.whatsapp.net`;

                        const welcomeText = isWatcher
                            ? `📡 *MALIYA-MD Channel Watcher Linked!*\n\nSession ID:\n\`${sessionId}\`\n\nAdd this ID to Railway \`WATCHER_SESSION_ID\` (Main bot will ignore this session).`
                            : `
🌸 *හෙලෝ යාලුවේ... MALIYA-MD එකට ඔයාව සාදරයෙන් පිළිගන්නවා!* ✨🥰
────────────────────
✨ *ඔයාගේ WhatsApp එක සාර්ථකව සම්බන්ධ වුණා!*

⏳ *පොඩි වෙලාවක් රැඳී ඉන්නකෝ...*
⚙️ ඔයාට පහසුවෙන් පාවිච්චි කරන්න පුළුවන් විදිහට Bot එකේ වැඩ කටයුතු සහ Settings මේ වෙලාවේ සූදානම් වෙනවා.

⏱️ *විනාඩි 2 – 3ක්* ඇතුළත Bot එක සම්පූර්ණයෙන්ම Ready වෙලා ඔයාට ලස්සන Message එකක් එවයි. 

🤍 _MALIYA-MD එක්ක එකතු වුණාට ගොඩක් ස්තූතියි!_ 🌸
────────────────────
> 🚀 *With friend, MALIYA-MD Team* ✨🤖
`.trim();

                        await KnightBot.sendMessage(targetUserJid, { text: welcomeText });
                        console.log("💌 Welcome alert sent to user inbox successfully!");
                    } catch (msgErr) {
                        console.error("⚠️ Failed to send welcome message:", msgErr?.message || msgErr);
                    }

                    try {
                        const credsPath = dirs + "/creds.json";
                        const savedSessionId = await saveSessionState({
                            sessionId,
                            phone: num,
                            filePath: credsPath,
                            fileName: `creds_${num}_${Date.now()}.json`,
                            source: isWatcher ? "watcher" : "pair-code",
                            connectBot: !isWatcher,
                        });

                        console.log("✅ Session saved to MongoDB. ID:", savedSessionId);
                        setSessionId(savedSessionId);

                        await delay(2000);
                        finishSession(KnightBot);
                        console.log("🎉 Pairing process completed successfully!");
                    } catch (error) {
                        console.error("❌ MongoDB upload error:", error);
                        finishSession(KnightBot);
                    }
                    return;
                }

                if (isNewLogin) console.log("🔐 New login via pair code");

                if (connection === "close") {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const reason = lastDisconnect?.error?.message || "unknown";
                    console.log(`🔴 Pair connection closed. Code: ${statusCode}, Reason: ${reason}`);

                    await safeSaveCreds();

                    if (statusCode === 401 || sessionDone || reconnectAttempts >= MAX_RECONNECTS) {
                        console.log("🛑 Pair session ended — stopping reconnect loop.");
                        if (!res.headersSent) {
                            res.status(408).send({ code: "Pairing expired. Please try again." });
                        }
                        finishSession(KnightBot);
                        return;
                    }

                    if (reconnecting) return;
                    reconnecting = true;
                    reconnectAttempts += 1;

                    KnightBot.ev.removeAllListeners();
                    try {
                        KnightBot.end(new Error("reconnecting"));
                    } catch (_) {}

                    const reconnectDelay = String(reason).toLowerCase().includes("conflict") ? 6000 : 3000;
                    console.log(`🔁 Reconnecting pair session (${reconnectAttempts}/${MAX_RECONNECTS}) in ${reconnectDelay / 1000}s...`);
                    await delay(reconnectDelay);
                    reconnecting = false;

                    if (!sessionDone) {
                        await initiateSession();
                    }
                }
            });

            if (!KnightBot.authState.creds.registered && !codeSent && !pairingRequested) {
                pairingRequested = true;
                await delay(3500);
                if (sessionDone) return;

                try {
                    let code = await KnightBot.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    codeSent = true;
                    if (!res.headersSent) {
                        console.log({ num, code, isWatcher });
                        await res.send({ code, sessionId });
                    }
                } catch (error) {
                    console.error("Error requesting pairing code:", error);
                    if (!res.headersSent) {
                        res.status(503).send({
                            code: "Failed to get pairing code. Check country code & number, then try again.",
                        });
                    }
                    finishSession(KnightBot);
                }
            }
        } catch (err) {
            console.error("Error initializing pair session:", err);
            if (!res.headersSent) {
                res.status(503).send({ code: "Service Unavailable" });
            }
            finishSession(null);
        }
    }

    await initiateSession();
});

export default router;
