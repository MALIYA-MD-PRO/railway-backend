// ═══════════════════════════════════════════════════════════════
//  auth.js — Google OAuth + Local (email/password) auth
//  GET  /auth/google            → Google login redirect
//  GET  /auth/google/callback   → Google callback
//  POST /auth/register          → create local account
//  POST /auth/login             → local email/password login
//  GET  /auth/user              → current session user (or null)
//  POST /auth/logout            → destroy session
// ═══════════════════════════════════════════════════════════════

import express            from "express";
import jwt                from "jsonwebtoken";
import { createRequire }  from "module";
import { getGoogleClientId, getGoogleClientSecret, getSessionSecret } from "./security.js";
import { findByEmail, findByGoogleId, createLocal, upsertGoogle } from "./models/User.js";

const require  = createRequire(import.meta.url);
const passport = require("passport");
const bcrypt   = require("bcryptjs");
const { Strategy: GoogleStrategy } = require("passport-google-oauth20");

const BACKEND_PUBLIC_URL  = (process.env.BACKEND_URL || "https://railway-backend-production-0b48.up.railway.app").replace(/\/$/, "");
const FRONTEND_PUBLIC_URL = (process.env.FRONTEND_URL || "https://maliya-md.vercel.app").replace(/\/$/, "");

// ─── Helper — safe user object for session ────────────────────
function toSessionUser(doc) {
  return {
    id:       String(doc._id || doc.googleId || doc.id || ""),
    name:     doc.name  || "User",
    email:    doc.email || "",
    photo:    doc.photo || null,
    provider: doc.provider || "local",
  };
}

// ─── Passport: Google strategy ───────────────────────────────
passport.use(
  new GoogleStrategy(
    {
      clientID:     getGoogleClientId(),
      clientSecret: getGoogleClientSecret(),
      callbackURL:  `${BACKEND_PUBLIC_URL}/auth/google/callback`,
      proxy:        true,
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const doc = await upsertGoogle({
          googleId: profile.id,
          name:     profile.displayName || "User",
          email:    profile.emails?.[0]?.value || "",
          photo:    profile.photos?.[0]?.value || "",
        });
        return done(null, toSessionUser(doc));
      } catch (err) {
        return done(err);
      }
    }
  )
);

passport.serializeUser((user, done)   => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

export { passport };

// ─── Router ──────────────────────────────────────────────────
const router = express.Router();

// ── Google OAuth ─────────────────────────────────────────────
router.get("/google", (req, res, next) => {
  const redirectTarget = String(req.query.redirect || `${FRONTEND_PUBLIC_URL}/react.html?tab=poll`);
  const state = Buffer.from(redirectTarget).toString("base64url");
  passport.authenticate("google", {
    scope: ["profile", "email"],
    state,
  })(req, res, next);
});

router.get(
  "/google/callback",
  passport.authenticate("google", { failureRedirect: `${FRONTEND_PUBLIC_URL}/react.html?tab=poll&auth=failed` }),
  (req, res) => {
    let targetUrl = `${FRONTEND_PUBLIC_URL}/react.html?tab=poll`;
    try {
      if (req.query.state) {
        const decoded = Buffer.from(String(req.query.state), "base64url").toString("utf8");
        if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
          targetUrl = decoded;
        }
      }
    } catch (_) {}

    const authToken = jwt.sign(
      {
        id:    req.user.id,
        email: req.user.email,
        name:  req.user.name,
        photo: req.user.photo,
      },
      getSessionSecret() || "maliya-md-fallback-secret",
      { expiresIn: "7d" }
    );

    const finalRedirect = new URL(targetUrl);
    finalRedirect.searchParams.set("auth_token", authToken);
    return res.redirect(finalRedirect.toString());
  }
);

// ── POST /auth/register ── create local account ───────────────
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !email || !password)
      return res.status(400).json({ ok: false, error: "All fields are required." });

    if (password.length < 6)
      return res.status(400).json({ ok: false, error: "Password must be at least 6 characters." });

    const existing = await findByEmail(email);
    if (existing) {
      if (existing.provider === "google")
        return res.status(409).json({ ok: false, error: "This email is linked to a Google account. Please sign in with Google." });
      return res.status(409).json({ ok: false, error: "Email already registered. Please login." });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const doc = await createLocal({ name: name.trim(), email, hashedPassword });

    const user = toSessionUser(doc);
    req.login(user, (err) => {
      if (err) return res.status(500).json({ ok: false, error: "Session error." });
      res.json({ ok: true, user });
    });
  } catch (err) {
    console.error("[auth/register]", err);
    res.status(500).json({ ok: false, error: "Server error. Try again." });
  }
});

// ── POST /auth/login ── local email/password ──────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password)
      return res.status(400).json({ ok: false, error: "Email and password are required." });

    const doc = await findByEmail(email);
    if (!doc) return res.status(401).json({ ok: false, error: "Invalid email or password." });

    if (doc.provider === "google" || !doc.password)
      return res.status(401).json({ ok: false, error: "This account uses Google login. Click 'Sign in with Google'." });

    const match = await bcrypt.compare(password, doc.password);
    if (!match) return res.status(401).json({ ok: false, error: "Invalid email or password." });

    const user = toSessionUser(doc);
    req.login(user, (err) => {
      if (err) return res.status(500).json({ ok: false, error: "Session error." });
      res.json({ ok: true, user });
    });
  } catch (err) {
    console.error("[auth/login]", err);
    res.status(500).json({ ok: false, error: "Server error. Try again." });
  }
});

// ── GET /auth/user  (and /auth/me alias) ──────────────────────
router.get("/user", (req, res) => {
  res.json({ user: req.user || null });
});
router.get("/me", (req, res) => {
  res.json({ user: req.user || null });
});

// ── POST /auth/logout ─────────────────────────────────────────
router.post("/logout", (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).json({ ok: false });
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      res.json({ ok: true });
    });
  });
});

export default router;
