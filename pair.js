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
//  Zod schema — Phone number validation
// ─────────────────────────────────────────────────────────────────
const phoneQuerySchema = z.object({
    number: z
        .string({ required_error: "Phone number is required." })
        .min(7, "Phone number too short — minimum 7 digits.")
        .max(15, "Phone number too long — maximum 15 digits.")
        .regex(/^[0-9]+$/, "Phone number must contain digits only."),
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
    // ── Layer 1: Zod schema validation
    const parsed = phoneQuerySchema.safeParse({
        number: String(req.query.number ?? "").replace(/[^0-9]/g, ""),
    });
    if (!parsed.success) {
        const msg = parsed.error.errors[0]?.message || "Invalid phone number.";
        console.warn(
            `⚠️ Zod rejected phone input: "${req.query.number}" — ${msg}`,
        );
        return res.status(400).send({ code: msg });
    }

    let num = parsed.data.number;

    // ── Layer 2: phone library validation
    const phoneResult = validatePhone("+" + num);
    if (!phoneResult.isValid) {
        return res.status(400).send({
            code: "Invalid phone number. Please enter your full international number without + or spaces.",
        });
    }
    num = phoneResult.phoneNumber.replace("+", "");

    const dirs = "./" + num;
    removeFile(dirs);

    const sessionId = generateMegaStyleId();
    let codeSent = false;
    let sessionDone = false;

    async function initiateSession() {
        if (sessionDone) return;

        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        const safeSaveCreds = async () => {
            try {
                await saveCreds();
            } catch (e) {
                console.error(
                    "⚠️ creds.update write error (non-fatal):",
                    e.message,
                );
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

            let KnightBot = makeWASocket({
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

            KnightBot.ev.on("creds.update", safeSaveCreds);

            KnightBot.ev.on("connection.update", async (update) => {
                if (sessionDone) return;

                const { connection, lastDisconnect, isNewLogin } = update;

                if (connection === "open") {
                    sessionDone = true;
                    console.log("✅ Connected — Sending sweet welcome notice & saving to DB...");

                    // ── 💌 ආදරණීය සහ සුහදශීලී Welcome Alert එක Inbox එකට යැවීම ──
                    try {
                        const targetUserJid = KnightBot.user?.id
                            ? jidNormalizedUser(KnightBot.user.id)
                            : `${num}@s.whatsapp.net`;

                       const sweetWelcomeMessage = `
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

                        await KnightBot.sendMessage(targetUserJid, { text: sweetWelcomeMessage });
                        console.log("💌 Welcome alert sent to user inbox successfully!");
                    } catch (msgErr) {
                        console.error("⚠️ Failed to send friendly welcome message:", msgErr?.message || msgErr);
                    }

                    // ── MongoDB වෙත session upload කිරීම ──
                    try {
                        const credsPath = dirs + "/creds.json";
                        const savedSessionId = await saveSessionState({
                            sessionId,
                            phone: num,
                            filePath: credsPath,
                            fileName: `creds_${num}_${Date.now()}.json`,
                            source: "pair-code",
                        });

                        console.log("✅ Session saved to MongoDB. ID:", savedSessionId);
                        setSessionId(savedSessionId);

                        await delay(2000);
                        KnightBot.ev.removeAllListeners();
                        try {
                            await KnightBot.end(new Error("session saved"));
                        } catch (_) {}
                        removeFile(dirs);
                        console.log("🎉 Pairing process completed successfully!");
                    } catch (error) {
                        console.error("❌ MongoDB upload error:", error);
                        KnightBot.ev.removeAllListeners();
                        try {
                            await KnightBot.end(new Error("upload error"));
                        } catch (_) {}
                        removeFile(dirs);
                    }
                    return;
                }

                if (isNewLogin) console.log("🔐 New login via pair code");

                if (connection === "close") {
                    const statusCode =
                        lastDisconnect?.error?.output?.statusCode;
                    const reason = lastDisconnect?.error?.message || "unknown";
                    console.log(
                        `🔴 Connection closed. Code: ${statusCode}, Reason: ${reason}`,
                    );

                    await safeSaveCreds();

                    if (statusCode === 401 || sessionDone) {
                        console.log("❌ Session ended — not reconnecting.");
                        if (!sessionDone) removeFile(dirs);
                        return;
                    }

                    if (codeSent) {
                        console.log(
                            "⚠️ Code was already sent — reconnecting to await pairing confirmation.",
                        );
                    } else {
                        console.log("🔁 Reconnecting before code was sent...");
                    }

                    KnightBot.ev.removeAllListeners();
                    try {
                        KnightBot.end(new Error("reconnecting"));
                    } catch (_) {}

                    const reconnectDelay = String(reason)
                        .toLowerCase()
                        .includes("conflict")
                        ? 8000
                        : 3000;
                    await delay(reconnectDelay);

                    try {
                        await initiateSession();
                    } catch (e) {
                        console.error("❌ Reconnect error:", e);
                    }
                }
            });

            if (!KnightBot.authState.creds.registered && !codeSent) {
                await delay(5000);
                num = num.replace(/[^\d+]/g, "");
                if (num.startsWith("+")) num = num.substring(1);

                try {
                    let code = await KnightBot.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    codeSent = true;
                    if (!res.headersSent) {
                        console.log({ num, code });
                        await res.send({ code });
                    }
                } catch (error) {
                    console.error("Error requesting pairing code:", error);
                    if (!res.headersSent) {
                        res.status(503).send({
                            code: "Failed to get pairing code. Please check your number and try again.",
                        });
                    }
                    sessionDone = true;
                    KnightBot.ev.removeAllListeners();
                    try {
                        KnightBot.end(new Error("pair code error"));
                    } catch (_) {}
                    removeFile(dirs);
                }
            }
        } catch (err) {
            console.error("Error initializing session:", err);
            if (!res.headersSent) {
                res.status(503).send({ code: "Service Unavailable" });
            }
            removeFile(dirs);
        }
    }

    await initiateSession();
});

export default router;
