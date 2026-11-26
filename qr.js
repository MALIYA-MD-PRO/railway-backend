import express from "express";
import fs from "fs";
import pino from "pino";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { saveSessionState } from "./mongodb.js";
import { setSessionId } from "./session-store.js";

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
        for (let i = 0; i < len; i++) {
            str += chars[Math.floor(Math.random() * chars.length)];
        }
        return str;
    }
    return `${randomString(8)}#${randomString(43)}`;
}

router.get("/", async (req, res) => {
    const tempId =
        Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const sessionId = generateMegaStyleId();
    const dirs = `./qr_sessions/session_${tempId}`;

    if (!fs.existsSync("./qr_sessions")) {
        fs.mkdirSync("./qr_sessions", { recursive: true });
    }

    removeFile(dirs);

    let responseSent = false;
    let sessionDone = false;
    let reconnecting = false;
    let reconnectAttempts = 0;
    const MAX_RECONNECTS = 4;
    let activeSocket = null;

    function finishSession(sock) {
        sessionDone = true;
        clearTimeout(initialTimeout);
        clearTimeout(hardLifetimeTimeout);
        if (sock) {
            try {
                sock.ev.removeAllListeners();
                sock.end(new Error("qr session finished"));
            } catch (_) {}
        }
        removeFile(dirs);
    }

    // 30s timeout to generate the first QR image
    const initialTimeout = setTimeout(() => {
        if (!responseSent && !sessionDone) {
            responseSent = true;
            if (!res.headersSent) {
                res.status(408).send({ code: "QR generation timeout" });
            }
            finishSession(activeSocket);
        }
    }, 30000);

    // Hard 2-minute lifetime to complete scanning (prevents infinite 408 loops)
    const hardLifetimeTimeout = setTimeout(() => {
        if (!sessionDone) {
            console.log(`⏱️ QR session expired (2m) for ${tempId} — cleaning up.`);
            finishSession(activeSocket);
        }
    }, 2 * 60 * 1000);

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

        let KnightBot;
        try {
            let version;
            try {
                const fetched = await fetchLatestBaileysVersion();
                version = fetched.version;
            } catch (_) {
                version = [2, 3000, 1035194821];
            }

            KnightBot = makeWASocket({
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
        } catch (err) {
            console.error("Error creating socket:", err);
            if (!res.headersSent) {
                res.status(503).send({ code: "Service Unavailable" });
            }
            finishSession(null);
            return;
        }

        KnightBot.ev.on("connection.update", async (update) => {
            if (sessionDone) return;

            const { connection, lastDisconnect, isNewLogin, isOnline, qr } = update;

            if (qr && !responseSent) {
                console.log("🟢 QR Code Generated! Scan it with your WhatsApp app.");
                try {
                    const qrDataURL = await QRCode.toDataURL(qr, {
                        errorCorrectionLevel: "M",
                        type: "image/png",
                        quality: 0.92,
                        margin: 1,
                        color: { dark: "#000000", light: "#FFFFFF" },
                    });
                    if (!responseSent) {
                        responseSent = true;
                        clearTimeout(initialTimeout);
                        console.log("QR Code sent to client");
                        res.send({
                            qr: qrDataURL,
                            message: "QR Code Generated! Scan it with your WhatsApp app.",
                            instructions: [
                                "1. Open WhatsApp on your phone",
                                "2. Go to Settings > Linked Devices",
                                '3. Tap "Link a Device"',
                                "4. Scan the QR code above",
                            ],
                        });
                    }
                } catch (qrError) {
                    console.error("Error generating QR code:", qrError);
                    if (!responseSent) {
                        responseSent = true;
                        if (!res.headersSent) {
                            res.status(500).send({ code: "Failed to generate QR code" });
                        }
                        finishSession(KnightBot);
                    }
                }
            }

            if (connection === "open") {
                sessionDone = true;
                clearTimeout(initialTimeout);
                clearTimeout(hardLifetimeTimeout);
                console.log("✅ QR Connected — Sending welcome notice & saving to DB...");

                try {
                    const userPhone = KnightBot.user?.id ? KnightBot.user.id.split("@")[0].split(":")[0] : "";
                    const targetUserJid = KnightBot.user?.id
                        ? jidNormalizedUser(KnightBot.user.id)
                        : (userPhone ? `${userPhone}@s.whatsapp.net` : null);

                    if (targetUserJid) {
                        const sweetWelcomeMessage = `
🌸 *හෙලෝ යාලුවේ... MALIYA-MD එකට ඔයාව සාදරයෙන් පිළිගන්නවා!* ✨🥰
────────────────────
✨ *ඔයාගේ WhatsApp එක සාර්ථකව සම්බන්ධ වුණා!*

⏳ *පොඩි වෙලාවක් රැඳී ඉන්නකෝ...*
⚙️ ඔයාට පහසුවෙන් පාවිච්චි කරන්න පුළුවන් විදිහට Bot එකේ වැඩ කටයුතු සහ Settings මේ වෙලාවේ සූදානම් වෙනවා.

⏱️ *විනාඩි 2 – 3ක්* ඇතුළත Bot එක සම්පූර්ණයෙන්ම Ready වෙලා ඔයාට ලස්සන Message එකක් එවයි. 

🤍 _MALIYA-MD එක්ක එකතු වුණාට ගොඩක් ස්තූතියි!_ 🌸
────────────────────
> 🚀 *With friend, MALIYA-MD Team* ✨🤖`.trim();

                        await KnightBot.sendMessage(targetUserJid, { text: sweetWelcomeMessage });
                        console.log("💌 Welcome alert sent to QR user inbox successfully!");
                    }
                } catch (msgErr) {
                    console.error("⚠️ Failed to send welcome message (QR):", msgErr?.message || msgErr);
                }

                try {
                    const credsPath = dirs + "/creds.json";
                    const savedSessionId = await saveSessionState({
                        sessionId,
                        filePath: credsPath,
                        fileName: `creds_qr_${tempId}.json`,
                        source: "qr",
                    });
                    console.log("✅ Session uploaded to MongoDB. ID:", savedSessionId);
                    setSessionId(savedSessionId);
                } catch (error) {
                    console.error("❌ Error uploading to MongoDB:", error);
                }

                await delay(2000);
                finishSession(KnightBot);
                console.log("🎉 Process completed successfully!");
                return;
            }

            if (isNewLogin) console.log("🔐 New login via QR code");
            if (isOnline) console.log("📶 Client is online");

            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason = lastDisconnect?.error?.message || "unknown";
                console.log(`🔴 QR connection closed. Code: ${statusCode}, Reason: ${reason}`);

                if (statusCode === 401 || sessionDone || reconnectAttempts >= MAX_RECONNECTS) {
                    console.log("🛑 QR session ended — stopping reconnect loop.");
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
                console.log(`🔁 Reconnecting QR (${reconnectAttempts}/${MAX_RECONNECTS}) in ${reconnectDelay / 1000}s...`);
                await delay(reconnectDelay);
                reconnecting = false;

                if (!sessionDone) {
                    await initiateSession();
                }
            }
        });

        KnightBot.ev.on("creds.update", safeSaveCreds);
    }

    await initiateSession();
});

export default router;
