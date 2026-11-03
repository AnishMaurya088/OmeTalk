const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");

const SESSION_COOKIE = "ometalk_premium_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CHAT_TTL_HOURS = 24;
const SINGLE_VIEW_TTL_SECONDS = 60;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_PAYMENT_PROOF_BYTES = 5 * 1024 * 1024;
const MAX_PROFILE_AVATAR_BYTES = 2 * 1024 * 1024;
const PREMIUM_GRACE_HOURS = 24;
const DATABASE_KEEPALIVE_INTERVAL_MS = process.env.DATABASE_KEEPALIVE_INTERVAL_MS
    ? Number(process.env.DATABASE_KEEPALIVE_INTERVAL_MS)
    : 0;
if (!Number.isSafeInteger(DATABASE_KEEPALIVE_INTERVAL_MS) || DATABASE_KEEPALIVE_INTERVAL_MS < 0) {
    throw new Error("DATABASE_KEEPALIVE_INTERVAL_MS must be zero or a positive whole number of milliseconds.");
}
const PREMIUM_PLANS = {
    month_1: { id: "month_1", label: "1 month", months: 1, priceInr: 299 },
    month_3: { id: "month_3", label: "3 months", months: 3, priceInr: 699 }
};
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const pool = DATABASE_URL
    ? new Pool({
        connectionString: DATABASE_URL
    })
    : null;
let databaseReady = false;

const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpUser = process.env.SMTP_USER || "";
const smtpPassword = process.env.SMTP_PASSWORD || "";
const smtpAuthIsValid = Boolean(smtpUser) === Boolean(smtpPassword);
const passwordResetMailer = process.env.SMTP_HOST && process.env.SMTP_FROM &&
    Number.isInteger(smtpPort) && smtpPort > 0 && smtpPort <= 65535 && smtpAuthIsValid
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: smtpPort,
        secure: process.env.SMTP_SECURE
            ? process.env.SMTP_SECURE === "true"
            : smtpPort === 465,
        ...(smtpUser ? { auth: { user: smtpUser, pass: smtpPassword } } : {})
    })
    : null;

const mediaUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_MEDIA_BYTES, files: 1, fields: 2, fieldSize: 2000 },
    fileFilter(req, file, callback) {
        if (!file.mimetype.startsWith("audio/") && !file.mimetype.startsWith("video/") &&
            !["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
            callback(new Error("Only JPG, PNG, WebP, audio, or video files can be sent."));
            return;
        }
        callback(null, true);
    }
});

const paymentProofUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PAYMENT_PROOF_BYTES, files: 1, fields: 4, fieldSize: 2000 },
    fileFilter(req, file, callback) {
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
            callback(new Error("Upload a JPG, PNG, or WebP payment screenshot."));
            return;
        }
        callback(null, true);
    }
});

const paymentQrUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PAYMENT_PROOF_BYTES, files: 1, fields: 0 },
    fileFilter(req, file, callback) {
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
            callback(new Error("Upload a JPG, PNG, or WebP QR image."));
            return;
        }
        callback(null, true);
    }
});

const profileAvatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PROFILE_AVATAR_BYTES, files: 1, fields: 0 },
    fileFilter(req, file, callback) {
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
            callback(new Error("Upload a JPG, PNG, or WebP profile picture."));
            return;
        }
        callback(null, true);
    }
});

function hash(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function getCookie(req, name) {
    const cookies = (req.headers.cookie || "").split(";");
    const cookie = cookies.find((part) => part.trim().startsWith(`${name}=`));
    return cookie ? decodeURIComponent(cookie.trim().slice(name.length + 1)) : null;
}

function setSessionCookie(res, token) {
    res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        maxAge: SESSION_TTL_MS,
        path: "/"
    });
}

function clearSessionCookie(res) {
    res.clearCookie(SESSION_COOKIE, {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        path: "/"
    });
}

function normalizeUsername(value) {
    return typeof value === "string" ? value.trim() : "";
}

function getValidDateOfBirth(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day) return null;

    const now = new Date();
    const age = now.getUTCFullYear() - year -
        (now.getUTCMonth() + 1 < month ||
            (now.getUTCMonth() + 1 === month && now.getUTCDate() < day) ? 1 : 0);
    return age >= 18 ? value : null;
}

function usernameBase(fullName) {
    const base = fullName.normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 19);
    const usableBase = base || "user";
    return usableBase.length >= 3 ? usableBase : `${usableBase}_user`;
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function getPublicBaseUrl() {
    const configuredUrl = process.env.APP_BASE_URL ||
        (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000");
    if (!configuredUrl) return null;
    try {
        const url = new URL(configuredUrl);
        if (!["http:", "https:"].includes(url.protocol) ||
            (process.env.NODE_ENV === "production" && url.protocol !== "https:")) return null;
        return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
        return null;
    }
}

function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch((error) => {
        console.error("Premium request failed:", error.message);
        if (!res.headersSent) res.status(503).json({ error: "Premium service is temporarily unavailable." });
    });
}

function uploadPremiumMedia(req, res, next) {
    mediaUpload.single("media")(req, res, (error) => {
        if (!error) {
            next();
            return;
        }
        const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        res.status(status).json({
            error: error.code === "LIMIT_FILE_SIZE"
                ? "Image, audio, and video messages are limited to 25 MB."
                : error.message
        });
    });
}

function detectMediaType(buffer, declaredType) {
    if (declaredType.startsWith("image/")) return detectImageType(buffer);
    const declaredAudio = declaredType.startsWith("audio/");
    if (buffer.length >= 4 &&
        buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
        return declaredAudio ? "audio/webm" : "video/webm";
    }
    if (buffer.subarray(0, 4).toString("ascii") === "OggS") {
        return declaredType.startsWith("video/") ? "video/ogg" : "audio/ogg";
    }
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WAVE") {
        return "audio/wav";
    }
    if (buffer.subarray(0, 4).toString("ascii") === "fLaC") {
        return "audio/flac";
    }
    if (buffer.length >= 8 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
        const brand = buffer.subarray(8, 12).toString("ascii");
        if (brand === "qt  ") return "video/quicktime";
        if (brand === "M4A ") return "audio/mp4";
        return declaredAudio ? "audio/mp4" : "video/mp4";
    }
    if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0) {
        return "audio/aac";
    }
    if (buffer.subarray(0, 3).toString("ascii") === "ID3" ||
        (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
        return "audio/mpeg";
    }
    return null;
}

function detectImageType(buffer) {
    if (buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return "image/png";
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return "image/jpeg";
    }
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP") {
        return "image/webp";
    }
    return null;
}

function normalizeProfileInput(profile) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
    const displayName = typeof profile.displayName === "string" ? profile.displayName.trim() : null;
    const bio = typeof profile.bio === "string" ? profile.bio.trim() : null;
    const country = typeof profile.country === "string" ? profile.country.trim() : null;
    const language = typeof profile.language === "string" ? profile.language.trim() : null;
    const interests = profile.interests;
    if (displayName === null || displayName.length > 50 ||
        bio === null || bio.length > 160 ||
        country === null || country.length > 80 ||
        language === null || language.length > 50 ||
        !Array.isArray(interests) || interests.length > 10 ||
        interests.some((interest) => typeof interest !== "string" || interest.trim().length > 32) ||
        typeof profile.profilePrivate !== "boolean") {
        return null;
    }
    const normalizedInterests = [...new Map(interests
        .map((interest) => interest.trim())
        .filter(Boolean)
        .map((interest) => [interest.toLocaleLowerCase(), interest])).values()];
    if (normalizedInterests.length > 10) return null;
    return {
        displayName,
        bio,
        country,
        language,
        interests: normalizedInterests,
        profilePrivate: profile.profilePrivate
    };
}

function uploadError(upload, tooLargeMessage = "The image must be 5 MB or smaller.") {
    return (req, res, next) => upload(req, res, (error) => {
        if (!error) {
            next();
            return;
        }
        const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        res.status(status).json({
            error: error.code === "LIMIT_FILE_SIZE"
                ? tooLargeMessage
                : error.message
        });
    });
}

const uploadPaymentProof = uploadError(paymentProofUpload.single("proof"));
const uploadPaymentQr = uploadError(paymentQrUpload.single("qr"));
const uploadProfileAvatar = uploadError(
    profileAvatarUpload.single("avatar"),
    "Profile pictures are limited to 2 MB."
);

function getPremiumPlan(planId) {
    return typeof planId === "string" ? PREMIUM_PLANS[planId] || null : null;
}

function requireDatabase(req, res, next) {
    if (!pool) {
        res.status(503).json({ error: "Premium accounts are unavailable until DATABASE_URL is configured." });
        return;
    }
    if (!databaseReady) {
        res.status(503).json({ error: "Premium database is not ready yet." });
        return;
    }
    next();
}

async function findSession(token) {
    if (!pool || !token) return null;
    const result = await pool.query(
        `SELECT u.id, u.email, u.username, u.premium_expires_at, u.premium_plan,
                u.premium_locked_at, u.premium_locked_reason
         FROM premium_sessions s
         JOIN premium_users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
        [hash(token)]
    );
    return result.rows[0] || null;
}

async function requireUser(req, res, next) {
    try {
        const user = await findSession(getCookie(req, SESSION_COOKIE));
        if (!user) {
            res.status(401).json({ error: "Sign in to your premium account." });
            return;
        }
        req.premiumUser = user;
        next();
    } catch (error) {
        console.error("Premium authentication failed:", error.message);
        res.status(503).json({ error: "Could not verify your premium session." });
    }
}

async function requireActivePremium(req, res, next) {
    try {
        const user = await findSession(getCookie(req, SESSION_COOKIE));
        if (!user) {
            res.status(401).json({ error: "Sign in to your premium account." });
            return;
        }
        if (user.premium_locked_at) {
            res.status(403).json({ error: "Your Premium access is temporarily locked. Contact support or complete renewal." });
            return;
        }
        if (!user.premium_expires_at ||
            new Date(user.premium_expires_at).getTime() + PREMIUM_GRACE_HOURS * 60 * 60 * 1000 <= Date.now()) {
            res.status(403).json({ error: "Your Premium membership expired. Submit a payment request to restore access." });
            return;
        }
        req.premiumUser = user;
        next();
    } catch (error) {
        console.error("Premium authentication failed:", error.message);
        res.status(503).json({ error: "Could not verify your premium session." });
    }
}

async function areFriends(userId, friendId, client = pool) {
    const result = await client.query(
        "SELECT 1 FROM premium_friends WHERE user_id = $1 AND friend_id = $2",
        [userId, friendId]
    );
    return result.rowCount > 0;
}

async function areBlocked(userId, otherUserId, client = pool) {
    const result = await client.query(
        `SELECT 1 FROM premium_blocks
         WHERE (blocker_id = $1 AND blocked_id = $2)
            OR (blocker_id = $2 AND blocked_id = $1)
         LIMIT 1`,
        [userId, otherUserId]
    );
    return result.rowCount > 0;
}

async function initializePremiumDatabase() {
    if (!pool) {
        console.warn("Premium features are disabled: configure DATABASE_URL or POSTGRES_URL.");
        return;
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS premium_users (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            username TEXT NOT NULL,
            full_name TEXT,
            date_of_birth DATE,
            password_hash TEXT NOT NULL,
            adult_confirmed_at TIMESTAMPTZ,
            premium_expires_at TIMESTAMPTZ,
            premium_plan TEXT,
            premium_locked_at TIMESTAMPTZ,
            premium_locked_reason TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE premium_users
            ADD COLUMN IF NOT EXISTS adult_confirmed_at TIMESTAMPTZ;
        ALTER TABLE premium_users
            ADD COLUMN IF NOT EXISTS full_name TEXT,
            ADD COLUMN IF NOT EXISTS date_of_birth DATE,
            ADD COLUMN IF NOT EXISTS premium_plan TEXT,
            ADD COLUMN IF NOT EXISTS premium_locked_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS premium_locked_reason TEXT,
            ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS interests JSONB NOT NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS profile_private BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS avatar_mime_type TEXT,
            ADD COLUMN IF NOT EXISTS avatar_data BYTEA;
        CREATE UNIQUE INDEX IF NOT EXISTS premium_users_username_lower_idx
            ON premium_users (LOWER(username));
        CREATE TABLE IF NOT EXISTS premium_password_resets (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES premium_users(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS premium_password_resets_user_idx
            ON premium_password_resets(user_id);
        CREATE TABLE IF NOT EXISTS premium_payment_qr (
            id TEXT PRIMARY KEY CHECK (id = 'primary'),
            mime_type TEXT NOT NULL,
            data BYTEA NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS premium_manual_payment_requests (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES premium_users(id) ON DELETE CASCADE,
            requested_plan TEXT NOT NULL,
            coupon_code TEXT,
            discount_percent INTEGER NOT NULL DEFAULT 0,
            requested_amount_inr INTEGER NOT NULL,
            utr TEXT NOT NULL,
            proof_mime_type TEXT NOT NULL,
            proof_data BYTEA NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),
            approved_plan TEXT,
            verified_amount_inr INTEGER,
            activated_at TIMESTAMPTZ,
            plan_expires_at TIMESTAMPTZ,
            admin_note TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            reviewed_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS premium_manual_payment_user_idx
            ON premium_manual_payment_requests(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS premium_manual_payment_status_idx
            ON premium_manual_payment_requests(status, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS premium_manual_payment_pending_user_idx
            ON premium_manual_payment_requests(user_id) WHERE status = 'pending';
        CREATE UNIQUE INDEX IF NOT EXISTS premium_manual_payment_utr_idx
            ON premium_manual_payment_requests(LOWER(utr));
        CREATE TABLE IF NOT EXISTS premium_account_deletion_requests (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL UNIQUE REFERENCES premium_users(id) ON DELETE CASCADE,
            reason TEXT,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'completed', 'cancelled')),
            requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ
        );
        CREATE TABLE IF NOT EXISTS premium_sessions (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES premium_users(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS premium_sessions_user_idx ON premium_sessions(user_id);
        CREATE TABLE IF NOT EXISTS premium_friends (
            user_id TEXT NOT NULL REFERENCES premium_users(id) ON DELETE CASCADE,
            friend_id TEXT NOT NULL REFERENCES premium_users(id) ON DELETE CASCADE,
            added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, friend_id),
            CHECK (user_id <> friend_id)
        );
        CREATE TABLE IF NOT EXISTS premium_friend_requests (
            sender_id TEXT NOT NULL REFERENCES premium_users(id) ON DELETE CASCADE,
            recipient_id TEXT NOT NULL REFERENCES premium_users(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'rejected')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (sender_id, recipient_id),
            CHECK (sender_id <> recipient_id)
        );
        CREATE INDEX IF NOT EXISTS premium_friend_requests_incoming_idx
            ON premium_friend_requests(recipient_id, created_at DESC)
            WHERE status = 'pending';
        CREATE TABLE IF NOT EXISTS premium_blocks (
            blocker_id TEXT NOT NULL REFERENCES premium_users(id) ON DELETE CASCADE,
            blocked_id TEXT NOT NULL REFERENCES premium_users(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (blocker_id, blocked_id),
            CHECK (blocker_id <> blocked_id)
        );
        CREATE TABLE IF NOT EXISTS premium_invites (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES premium_users(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            redeemed_by TEXT REFERENCES premium_users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS premium_media (
            id TEXT PRIMARY KEY,
            uploader_id TEXT NOT NULL REFERENCES premium_users(id) ON DELETE CASCADE,
            mime_type TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            data BYTEA NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS premium_messages (
            id TEXT PRIMARY KEY,
            sender_id TEXT NOT NULL REFERENCES premium_users(id) ON DELETE CASCADE,
            recipient_id TEXT NOT NULL REFERENCES premium_users(id) ON DELETE CASCADE,
            body TEXT NOT NULL,
            media_id TEXT REFERENCES premium_media(id) ON DELETE SET NULL,
            view_once BOOLEAN NOT NULL DEFAULT FALSE,
            viewed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL
        );
        ALTER TABLE premium_messages
            ADD COLUMN IF NOT EXISTS media_id TEXT REFERENCES premium_media(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS premium_messages_pair_idx
            ON premium_messages(sender_id, recipient_id, created_at);
        CREATE INDEX IF NOT EXISTS premium_messages_expiry_idx ON premium_messages(expires_at);
        CREATE TABLE IF NOT EXISTS premium_chat_reports (
            id TEXT PRIMARY KEY,
            reporter_id TEXT NOT NULL REFERENCES premium_users(id) ON DELETE CASCADE,
            reported_id TEXT NOT NULL REFERENCES premium_users(id) ON DELETE CASCADE,
            category TEXT NOT NULL,
            transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'resolved')),
            review_note TEXT NOT NULL DEFAULT '',
            access_log JSONB NOT NULL DEFAULT '[]'::jsonb,
            audit_log JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            reviewed_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS premium_chat_reports_status_idx
            ON premium_chat_reports(status, created_at DESC);
        CREATE TABLE IF NOT EXISTS premium_coupons (
            code TEXT PRIMARY KEY,
            discount_percent INTEGER NOT NULL CHECK (discount_percent BETWEEN 1 AND 90),
            max_redemptions INTEGER NOT NULL CHECK (max_redemptions > 0),
            redemption_count INTEGER NOT NULL DEFAULT 0,
            expires_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS premium_payments (
            order_id TEXT PRIMARY KEY,
            payment_id TEXT UNIQUE,
            user_id TEXT NOT NULL REFERENCES premium_users(id) ON DELETE CASCADE,
            amount_paise INTEGER NOT NULL,
            coupon_code TEXT REFERENCES premium_coupons(code) ON DELETE SET NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            paid_at TIMESTAMPTZ
        );
    `);
    databaseReady = true;
    console.log("Premium PostgreSQL schema is ready.");

    if (DATABASE_KEEPALIVE_INTERVAL_MS > 0) {
        const keepaliveTimer = setInterval(async () => {
            try {
                await pool.query("SELECT 1");
            } catch (error) {
                console.error("PostgreSQL keepalive query failed:", error.message);
            }
        }, DATABASE_KEEPALIVE_INTERVAL_MS);
        keepaliveTimer.unref();
        console.log(`PostgreSQL keepalive enabled every ${DATABASE_KEEPALIVE_INTERVAL_MS} ms.`);
    }
}

function attachPremiumRoutes(app, io, requireAdmin, recordConnection) {
    const premiumIo = io.of("/premium");
    const randomPartnersByUser = new Map();
    const waitingPremium = [];
    const activePremiumPartners = new Map();
    const socketsByUser = new Map();

    function endPremiumPairForUsers(userId, otherUserId, eventName) {
        const userSockets = socketsByUser.get(userId) || [];
        for (const socketId of userSockets) {
            const partnerSocketId = activePremiumPartners.get(socketId);
            const partnerSocket = partnerSocketId && premiumIo.sockets.sockets.get(partnerSocketId);
            if (!partnerSocket || partnerSocket.data.premiumUser.id !== otherUserId) continue;
            activePremiumPartners.delete(socketId);
            activePremiumPartners.delete(partnerSocketId);
            randomPartnersByUser.delete(userId);
            randomPartnersByUser.delete(otherUserId);
            const eventData = {
                userId,
                otherUserId,
                blocked: eventName === "premium-contact-blocked"
            };
            premiumIo.sockets.sockets.get(socketId)?.emit(eventName, eventData);
            partnerSocket.emit(eventName, eventData);
        }
        for (const socketId of socketsByUser.get(userId) || []) {
            const index = waitingPremium.indexOf(socketId);
            if (index >= 0) waitingPremium.splice(index, 1);
        }
        for (const socketId of socketsByUser.get(otherUserId) || []) {
            const index = waitingPremium.indexOf(socketId);
            if (index >= 0) waitingPremium.splice(index, 1);
        }
    }

    app.get("/premium", (req, res) => {
        res.set("Cache-Control", "no-store");
        res.set("Referrer-Policy", "no-referrer");
        res.sendFile(require("path").join(__dirname, "public", "premium.html"));
    });

    app.use("/api/premium", requireDatabase);

    app.post("/api/premium/username-suggestions", asyncRoute(async (req, res) => {
        const fullName = typeof (req.body && req.body.fullName) === "string"
            ? req.body.fullName.trim()
            : "";
        if (!fullName || fullName.length > 100) {
            res.status(400).json({ error: "Enter your name to get username suggestions." });
            return;
        }

        const base = usernameBase(fullName);
        const candidates = [base, ...Array.from({ length: 100 }, (_, index) => `${base}${index + 2}`)];
        const existing = await pool.query(
            "SELECT LOWER(username) AS username FROM premium_users WHERE LOWER(username) = ANY($1::text[])",
            [candidates]
        );
        const taken = new Set(existing.rows.map((row) => row.username));
        res.json({ suggestions: candidates.filter((candidate) => !taken.has(candidate)).slice(0, 5) });
    }));

    app.get("/api/premium/payment-qr", asyncRoute(async (req, res) => {
        const result = await pool.query(
            "SELECT mime_type, data FROM premium_payment_qr WHERE id = 'primary'"
        );
        if (!result.rowCount) {
            res.status(404).json({ error: "Payment QR has not been added yet. Please try again later." });
            return;
        }
        res.set("Cache-Control", "no-store");
        res.type(result.rows[0].mime_type).send(result.rows[0].data);
    }));

    app.post("/api/premium/register", asyncRoute(async (req, res) => {
        const email = String(req.body && req.body.email || "").trim().toLowerCase();
        const fullName = typeof (req.body && req.body.fullName) === "string"
            ? req.body.fullName.trim()
            : "";
        const dateOfBirth = getValidDateOfBirth(req.body && req.body.dateOfBirth);
        const username = normalizeUsername(req.body && req.body.username);
        const password = typeof (req.body && req.body.password) === "string" ? req.body.password : "";
        if (!fullName || fullName.length > 100 || !dateOfBirth ||
            !isValidEmail(email) || !/^[A-Za-z0-9_]{3,24}$/.test(username) ||
            password.length < 6 || password.length > 128) {
            res.status(400).json({
                error: !dateOfBirth
                    ? "Enter a valid date of birth. You must be 18 or older to create a Premium account."
                    : "Enter your name, a valid email, a 3–24 character username (letters, numbers, underscore), and a 6–128 character password."
            });
            return;
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const id = crypto.randomUUID();
        try {
            await pool.query(
                `INSERT INTO premium_users
                    (id, email, username, full_name, date_of_birth, password_hash, adult_confirmed_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                [id, email, username, fullName, dateOfBirth, passwordHash]
            );
        } catch (error) {
            if (error.code === "23505") {
                res.status(409).json({ error: "That email or username is already registered." });
                return;
            }
            throw error;
        }
        await issueSession(id, res);
        res.status(201).json({ success: true });
    }));

    app.post("/api/premium/forgot-password", asyncRoute(async (req, res) => {
        if (!passwordResetMailer) {
            res.status(503).json({ error: "Password reset email is unavailable until SMTP settings are configured." });
            return;
        }
        const baseUrl = getPublicBaseUrl();
        if (!baseUrl) {
            res.status(503).json({ error: "Password reset email is unavailable until APP_BASE_URL is configured." });
            return;
        }

        const email = String(req.body && req.body.email || "").trim().toLowerCase();
        if (!isValidEmail(email)) {
            res.status(400).json({ error: "Enter a valid email address." });
            return;
        }

        await pool.query("DELETE FROM premium_password_resets WHERE expires_at <= NOW()");
        const result = await pool.query(
            "SELECT id, email FROM premium_users WHERE email = $1",
            [email]
        );
        const user = result.rows[0];
        if (!user) {
            res.json({ success: true, message: "If an account exists for that email, a reset link has been sent." });
            return;
        }

        const token = crypto.randomBytes(32).toString("hex");
        const tokenHash = hash(token);
        await pool.query("DELETE FROM premium_password_resets WHERE user_id = $1", [user.id]);
        await pool.query(
            `INSERT INTO premium_password_resets (token_hash, user_id, expires_at)
             VALUES ($1, $2, NOW() + INTERVAL '30 minutes')`,
            [tokenHash, user.id]
        );
        const resetUrl = new URL(`${baseUrl}/premium`);
        resetUrl.searchParams.set("resetToken", token);
        try {
            await passwordResetMailer.sendMail({
                from: process.env.SMTP_FROM,
                to: user.email,
                subject: "Reset your OmeTalk password",
                text: `Use this one-time link to reset your OmeTalk password. It expires in 30 minutes:\n\n${resetUrl.toString()}\n\nIf you did not request a reset, you can ignore this email.`,
                html: `<p>Use this one-time link to reset your OmeTalk password. It expires in 30 minutes:</p><p><a href="${resetUrl.toString()}">Reset your OmeTalk password</a></p><p>If you did not request a reset, you can ignore this email.</p>`
            });
        } catch (error) {
            await pool.query("DELETE FROM premium_password_resets WHERE token_hash = $1", [tokenHash]);
            console.error("Could not send password reset email:", error.message);
            res.status(503).json({ error: "Could not send the password reset email. Check the SMTP configuration and try again." });
            return;
        }
        res.json({ success: true, message: "If an account exists for that email, a reset link has been sent." });
    }));

    app.post("/api/premium/reset-password", asyncRoute(async (req, res) => {
        const token = typeof (req.body && req.body.token) === "string" ? req.body.token : "";
        const password = typeof (req.body && req.body.password) === "string" ? req.body.password : "";
        if (!/^[a-f0-9]{64}$/.test(token) || password.length < 6 || password.length > 128) {
            res.status(400).json({ error: "Use a valid reset link and a 6–128 character password." });
            return;
        }

        const tokenHash = hash(token);
        const validReset = await pool.query(
            "SELECT 1 FROM premium_password_resets WHERE token_hash = $1 AND expires_at > NOW()",
            [tokenHash]
        );
        if (!validReset.rowCount) {
            res.status(400).json({ error: "This password reset link is invalid or has expired. Request a new one." });
            return;
        }
        const passwordHash = await bcrypt.hash(password, 12);
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const reset = await client.query(
                `SELECT user_id FROM premium_password_resets
                 WHERE token_hash = $1 AND expires_at > NOW()
                 FOR UPDATE`,
                [tokenHash]
            );
            if (!reset.rows[0]) {
                await client.query("ROLLBACK");
                res.status(400).json({ error: "This password reset link is invalid or has expired. Request a new one." });
                return;
            }
            await client.query(
                "UPDATE premium_users SET password_hash = $1 WHERE id = $2",
                [passwordHash, reset.rows[0].user_id]
            );
            await client.query("DELETE FROM premium_sessions WHERE user_id = $1", [reset.rows[0].user_id]);
            await client.query("DELETE FROM premium_password_resets WHERE user_id = $1", [reset.rows[0].user_id]);
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
        res.json({ success: true });
    }));

    app.post("/api/premium/login", asyncRoute(async (req, res) => {
        const email = String(req.body && req.body.email || "").trim().toLowerCase();
        const password = typeof (req.body && req.body.password) === "string" ? req.body.password : "";
        const result = await pool.query(
            "SELECT id, password_hash FROM premium_users WHERE email = $1",
            [email]
        );
        const user = result.rows[0];
        if (!user || !await bcrypt.compare(password, user.password_hash)) {
            res.status(401).json({ error: "Email or password is incorrect." });
            return;
        }
        await issueSession(user.id, res);
        res.json({ success: true });
    }));

    app.post("/api/premium/logout", asyncRoute(async (req, res) => {
        const token = getCookie(req, SESSION_COOKIE);
        if (token) await pool.query("DELETE FROM premium_sessions WHERE token_hash = $1", [hash(token)]);
        clearSessionCookie(res);
        res.json({ success: true });
    }));

    app.get("/api/premium/me", requireUser, asyncRoute(async (req, res) => {
        res.set("Cache-Control", "no-store");
        const deletionRequest = await pool.query(
            `SELECT status, requested_at AS "requestedAt"
             FROM premium_account_deletion_requests WHERE user_id = $1`,
            [req.premiumUser.id]
        );
        const premiumExpiresAt = req.premiumUser.premium_expires_at;
        const graceExpiresAt = premiumExpiresAt
            ? new Date(new Date(premiumExpiresAt).getTime() + PREMIUM_GRACE_HOURS * 60 * 60 * 1000)
            : null;
        const premiumActive = Boolean(!req.premiumUser.premium_locked_at &&
            graceExpiresAt && graceExpiresAt > new Date());
        res.json({
            id: req.premiumUser.id,
            email: req.premiumUser.email,
            username: req.premiumUser.username,
            premiumPlan: req.premiumUser.premium_plan,
            premiumActive,
            premiumLocked: Boolean(req.premiumUser.premium_locked_at),
            premiumExpiresAt,
            graceExpiresAt,
            deletionRequest: deletionRequest.rows[0] || null
        });
    }));

    app.get("/api/premium/config", (req, res) => {
        res.json({
            plans: Object.values(PREMIUM_PLANS),
            paymentMethod: "manual"
        });
    });

    app.get("/api/premium/payment-history", requireUser, asyncRoute(async (req, res) => {
        const result = await pool.query(
            `SELECT id, requested_plan AS "requestedPlan", approved_plan AS "approvedPlan",
                    requested_amount_inr AS "requestedAmountInr",
                    verified_amount_inr AS "verifiedAmountInr", discount_percent AS "discountPercent",
                    coupon_code AS "couponCode", utr, status, admin_note AS "adminNote",
                    created_at AS "createdAt", reviewed_at AS "reviewedAt",
                    activated_at AS "activatedAt", plan_expires_at AS "planExpiresAt"
             FROM premium_manual_payment_requests WHERE user_id = $1
             UNION ALL
             SELECT order_id, 'legacy', 'legacy', amount_paise / 100, amount_paise / 100,
                    0, coupon_code, NULL, status, NULL, created_at, paid_at, paid_at, NULL
             FROM premium_payments WHERE user_id = $1 AND status = 'paid'
             ORDER BY "createdAt" DESC`,
            [req.premiumUser.id]
        );
        res.json({ payments: result.rows });
    }));

    app.post("/api/premium/payment-requests",
        requireUser,
        uploadPaymentProof,
        asyncRoute(async (req, res) => {
            const paymentQr = await pool.query(
                "SELECT 1 FROM premium_payment_qr WHERE id = 'primary'"
            );
            if (!paymentQr.rowCount) {
                res.status(503).json({ error: "Premium payment is not available until admin uploads a payment QR." });
                return;
            }
            const plan = getPremiumPlan(String(req.body && req.body.planId || ""));
            const utr = String(req.body && req.body.utr || "").trim();
            const couponCode = String(req.body && req.body.couponCode || "").trim().toUpperCase();
            if (!plan || !/^[A-Za-z0-9/-]{6,40}$/.test(utr) || !req.file) {
                res.status(400).json({ error: "Select a plan, enter a valid UTR/reference, and attach your payment screenshot." });
                return;
            }
            const proofMimeType = detectImageType(req.file.buffer);
            if (!proofMimeType) {
                res.status(400).json({ error: "The screenshot must be a valid JPG, PNG, or WebP image." });
                return;
            }
            const pending = await pool.query(
                "SELECT 1 FROM premium_manual_payment_requests WHERE user_id = $1 AND status = 'pending'",
                [req.premiumUser.id]
            );
            if (pending.rowCount) {
                res.status(409).json({ error: "You already have a payment request waiting for admin verification." });
                return;
            }
            const client = await pool.connect();
            let coupon = null;
            try {
                await client.query("BEGIN");
                if (couponCode) {
                    const couponResult = await client.query(
                        `SELECT code, discount_percent, max_redemptions, redemption_count
                         FROM premium_coupons WHERE code = $1
                           AND (expires_at IS NULL OR expires_at > NOW())
                         FOR UPDATE`,
                        [couponCode]
                    );
                    if (!couponResult.rowCount ||
                        couponResult.rows[0].redemption_count >= couponResult.rows[0].max_redemptions) {
                        await client.query("ROLLBACK");
                        res.status(400).json({ error: "This coupon is invalid, expired, or fully redeemed." });
                        return;
                    }
                    coupon = couponResult.rows[0];
                }
                const discountPercent = coupon ? coupon.discount_percent : 0;
                const requestedAmountInr = Math.max(1,
                    Math.round(plan.priceInr * (100 - discountPercent) / 100));
                const id = crypto.randomUUID();
                await client.query(
                    `INSERT INTO premium_manual_payment_requests
                        (id, user_id, requested_plan, coupon_code, discount_percent,
                         requested_amount_inr, utr, proof_mime_type, proof_data)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [id, req.premiumUser.id, plan.id, coupon && coupon.code, discountPercent,
                        requestedAmountInr, utr, proofMimeType, req.file.buffer]
                );
                await client.query("COMMIT");
                res.status(201).json({
                    success: true,
                    id,
                    requestedAmountInr,
                    discountPercent,
                    couponCode: coupon && coupon.code,
                    status: "pending"
                });
            } catch (error) {
                await client.query("ROLLBACK");
                if (error.code === "23505") {
                    res.status(409).json({ error: "You already have a pending request, or this UTR is attached to another pending payment." });
                    return;
                }
                throw error;
            } finally {
                client.release();
            }
        })
    );

    app.post("/api/premium/account-deletion-requests", requireUser, asyncRoute(async (req, res) => {
        const reason = typeof (req.body && req.body.reason) === "string"
            ? req.body.reason.trim().slice(0, 500)
            : "";
        const id = crypto.randomUUID();
        await pool.query(
            `INSERT INTO premium_account_deletion_requests (id, user_id, reason)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id) DO UPDATE
             SET id = EXCLUDED.id, reason = EXCLUDED.reason, status = 'pending',
                 requested_at = NOW(), completed_at = NULL`,
            [id, req.premiumUser.id, reason || null]
        );
        res.status(201).json({ success: true, message: "Your account deletion request was sent to admin for review." });
    }));

    app.delete("/api/premium/account-deletion-requests", requireUser, asyncRoute(async (req, res) => {
        const result = await pool.query(
            `UPDATE premium_account_deletion_requests SET status = 'cancelled'
             WHERE user_id = $1 AND status = 'pending'`,
            [req.premiumUser.id]
        );
        if (!result.rowCount) {
            res.status(404).json({ error: "No pending account deletion request was found." });
            return;
        }
        res.json({ success: true });
    }));

    app.post("/api/premium/coupons/validate", requireUser, asyncRoute(async (req, res) => {
        const code = String(req.body && req.body.code || "").trim().toUpperCase();
        const plan = getPremiumPlan(String(req.body && req.body.planId || ""));
        if (!plan) {
            res.status(400).json({ error: "Select a valid Premium plan first." });
            return;
        }
        const coupon = await pool.query(
            `SELECT code, discount_percent, max_redemptions, redemption_count
             FROM premium_coupons
             WHERE code = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
            [code]
        );
        if (!coupon.rowCount || coupon.rows[0].redemption_count >= coupon.rows[0].max_redemptions) {
            res.status(400).json({ error: "This coupon is invalid, expired, or fully redeemed." });
            return;
        }
        const discountPercent = coupon.rows[0].discount_percent;
        const amountInr = Math.max(1, Math.round(plan.priceInr * (100 - discountPercent) / 100));
        res.json({ code: coupon.rows[0].code, discountPercent, amountInr, planId: plan.id });
    }));

    app.get("/api/premium/friends", requireActivePremium, asyncRoute(async (req, res) => {
        const result = await pool.query(
            `SELECT u.id, u.username, u.display_name AS "displayName",
                    u.avatar_mime_type IS NOT NULL AS "hasAvatar"
             FROM premium_friends f
             JOIN premium_users u ON u.id = f.friend_id
             WHERE f.user_id = $1
             ORDER BY LOWER(u.username)`,
            [req.premiumUser.id]
        );
        res.json({ friends: result.rows });
    }));

    app.delete("/api/premium/friends/:friendId", requireUser, asyncRoute(async (req, res) => {
        const friendId = req.params.friendId;
        if (friendId === req.premiumUser.id) {
            res.status(400).json({ error: "You cannot remove yourself as a friend." });
            return;
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const removed = await client.query(
                `DELETE FROM premium_friends
                 WHERE (user_id = $1 AND friend_id = $2)
                    OR (user_id = $2 AND friend_id = $1)
                 RETURNING user_id`,
                [req.premiumUser.id, friendId]
            );
            if (!removed.rowCount) {
                await client.query("ROLLBACK");
                res.status(404).json({ error: "This account is not in your friends list." });
                return;
            }
            await client.query(
                `DELETE FROM premium_friend_requests
                 WHERE (sender_id = $1 AND recipient_id = $2)
                    OR (sender_id = $2 AND recipient_id = $1)`,
                [req.premiumUser.id, friendId]
            );
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
        endPremiumPairForUsers(req.premiumUser.id, friendId, "premium-friendship-ended");
        premiumIo.to(`premium-user:${req.premiumUser.id}`)
            .to(`premium-user:${friendId}`).emit("premium-friendship-ended", {
                userId: req.premiumUser.id,
                otherUserId: friendId,
                blocked: false
            });
        res.json({ success: true });
    }));

    app.get("/api/premium/blocks", requireUser, asyncRoute(async (req, res) => {
        const result = await pool.query(
            `SELECT u.id, u.username
             FROM premium_blocks b JOIN premium_users u ON u.id = b.blocked_id
             WHERE b.blocker_id = $1 ORDER BY LOWER(u.username)`,
            [req.premiumUser.id]
        );
        res.json({ blockedUsers: result.rows });
    }));

    app.post("/api/premium/blocks/:userId", requireUser, asyncRoute(async (req, res) => {
        const blockedId = req.params.userId;
        if (blockedId === req.premiumUser.id) {
            res.status(400).json({ error: "You cannot block your own account." });
            return;
        }
        const target = await pool.query("SELECT id FROM premium_users WHERE id = $1", [blockedId]);
        if (!target.rowCount) {
            res.status(404).json({ error: "Account was not found." });
            return;
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(
                `INSERT INTO premium_blocks (blocker_id, blocked_id) VALUES ($1, $2)
                 ON CONFLICT DO NOTHING`,
                [req.premiumUser.id, blockedId]
            );
            await client.query(
                `DELETE FROM premium_friends
                 WHERE (user_id = $1 AND friend_id = $2)
                    OR (user_id = $2 AND friend_id = $1)`,
                [req.premiumUser.id, blockedId]
            );
            await client.query(
                `UPDATE premium_friend_requests SET status = 'rejected', updated_at = NOW()
                 WHERE status = 'pending'
                   AND ((sender_id = $1 AND recipient_id = $2)
                     OR (sender_id = $2 AND recipient_id = $1))`,
                [req.premiumUser.id, blockedId]
            );
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
        endPremiumPairForUsers(req.premiumUser.id, blockedId, "premium-contact-blocked");
        premiumIo.to(`premium-user:${req.premiumUser.id}`)
            .to(`premium-user:${blockedId}`).emit("premium-contact-blocked", {
                userId: req.premiumUser.id,
                otherUserId: blockedId,
                blocked: true
            });
        res.json({ success: true });
    }));

    app.delete("/api/premium/blocks/:userId", requireUser, asyncRoute(async (req, res) => {
        await pool.query(
            "DELETE FROM premium_blocks WHERE blocker_id = $1 AND blocked_id = $2",
            [req.premiumUser.id, req.params.userId]
        );
        res.json({ success: true });
    }));

    app.get("/api/premium/friend-requests", requireActivePremium, asyncRoute(async (req, res) => {
        const [incoming, outgoing] = await Promise.all([
            pool.query(
                `SELECT r.sender_id AS id, u.username, r.created_at AS "createdAt"
                 FROM premium_friend_requests r
                 JOIN premium_users u ON u.id = r.sender_id
                 WHERE r.recipient_id = $1 AND r.status = 'pending'
                 ORDER BY r.created_at DESC`,
                [req.premiumUser.id]
            ),
            pool.query(
                `SELECT r.recipient_id AS id, u.username, r.created_at AS "createdAt"
                 FROM premium_friend_requests r
                 JOIN premium_users u ON u.id = r.recipient_id
                 WHERE r.sender_id = $1 AND r.status = 'pending'
                 ORDER BY r.created_at DESC`,
                [req.premiumUser.id]
            )
        ]);
        res.json({ incoming: incoming.rows, outgoing: outgoing.rows });
    }));

    app.get("/api/premium/profile", requireUser, asyncRoute(async (req, res) => {
        const result = await pool.query(
            `SELECT username, display_name AS "displayName", bio, country, language,
                    interests, profile_private AS "profilePrivate",
                    avatar_mime_type IS NOT NULL AS "hasAvatar"
             FROM premium_users WHERE id = $1`,
            [req.premiumUser.id]
        );
        if (!result.rowCount) {
            res.status(404).json({ error: "Account profile was not found." });
            return;
        }
        res.set("Cache-Control", "no-store");
        res.json({ profile: result.rows[0] });
    }));

    app.put("/api/premium/profile", requireUser, asyncRoute(async (req, res) => {
        const profile = normalizeProfileInput(req.body);
        if (!profile) {
            res.status(400).json({ error: "Check the profile fields and their length limits, then try again." });
            return;
        }
        const result = await pool.query(
            `UPDATE premium_users
             SET display_name = $2, bio = $3, country = $4, language = $5,
                 interests = $6::jsonb, profile_private = $7
             WHERE id = $1
             RETURNING username, display_name AS "displayName", bio, country, language,
                       interests, profile_private AS "profilePrivate"`,
            [req.premiumUser.id, profile.displayName, profile.bio, profile.country, profile.language,
                JSON.stringify(profile.interests), profile.profilePrivate]
        );
        res.set("Cache-Control", "no-store");
        res.json({ profile: result.rows[0] });
    }));

    app.get("/api/premium/profile/avatar", requireUser, asyncRoute(async (req, res) => {
        const userId = typeof req.query.userId === "string" ? req.query.userId : req.premiumUser.id;
        if (userId !== req.premiumUser.id &&
            await areBlocked(req.premiumUser.id, userId)) {
            res.status(404).json({ error: "Profile picture was not found." });
            return;
        }
        const result = await pool.query(
            `SELECT avatar_mime_type, avatar_data, profile_private
             FROM premium_users WHERE id = $1`,
            [userId]
        );
        if (!result.rowCount || !result.rows[0].avatar_data) {
            res.status(404).json({ error: "Profile picture was not found." });
            return;
        }
        if (userId !== req.premiumUser.id && result.rows[0].profile_private) {
            const friendship = await areFriends(req.premiumUser.id, userId);
            if (!friendship) {
                res.status(403).json({ error: "This profile is private." });
                return;
            }
        }
        res.set({
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Type": result.rows[0].avatar_mime_type
        });
        res.send(result.rows[0].avatar_data);
    }));

    app.post("/api/premium/profile/avatar", requireUser, uploadProfileAvatar, asyncRoute(async (req, res) => {
        if (!req.file) {
            res.status(400).json({ error: "Choose a JPG, PNG, or WebP profile picture." });
            return;
        }
        const mimeType = detectImageType(req.file.buffer);
        if (!mimeType) {
            res.status(400).json({ error: "The profile picture must be a valid JPG, PNG, or WebP image." });
            return;
        }
        await pool.query(
            `UPDATE premium_users SET avatar_mime_type = $2, avatar_data = $3 WHERE id = $1`,
            [req.premiumUser.id, mimeType, req.file.buffer]
        );
        res.status(201).json({ success: true });
    }));

    app.delete("/api/premium/profile/avatar", requireUser, asyncRoute(async (req, res) => {
        await pool.query(
            `UPDATE premium_users SET avatar_mime_type = NULL, avatar_data = NULL WHERE id = $1`,
            [req.premiumUser.id]
        );
        res.json({ success: true });
    }));

    app.get("/api/premium/messages/:friendId", requireActivePremium, asyncRoute(async (req, res) => {
        if (await areBlocked(req.premiumUser.id, req.params.friendId) ||
            (!await areFriends(req.premiumUser.id, req.params.friendId) &&
            randomPartnersByUser.get(req.premiumUser.id) !== req.params.friendId)) {
            res.status(403).json({ error: "You can only chat with an accepted friend." });
            return;
        }
        const result = await pool.query(
            `SELECT m.id, m.sender_id AS "senderId", m.recipient_id AS "recipientId", m.body,
                    m.view_once AS "viewOnce", m.viewed_at AS "viewedAt", m.created_at AS "createdAt",
                    m.expires_at AS "expiresAt", m.media_id AS "mediaId",
                    media.mime_type AS "mediaType", media.file_size AS "mediaSize"
             FROM premium_messages m
             LEFT JOIN premium_media media ON media.id = m.media_id
             WHERE ((m.sender_id = $1 AND m.recipient_id = $2) OR (m.sender_id = $2 AND m.recipient_id = $1))
               AND m.expires_at > NOW()
             ORDER BY m.created_at`,
            [req.premiumUser.id, req.params.friendId]
        );
        res.json({ messages: result.rows });
    }));

    app.post("/api/premium/reports/:partnerId", requireUser, asyncRoute(async (req, res) => {
        const partnerId = req.params.partnerId;
        const category = String(req.body && req.body.category || "").trim().toLowerCase();
        if (!["harassment", "sexual content", "spam", "impersonation", "other"].includes(category)) {
            res.status(400).json({ error: "Choose a valid report category." });
            return;
        }
        if (partnerId === req.premiumUser.id ||
            (!await areFriends(req.premiumUser.id, partnerId) &&
                randomPartnersByUser.get(req.premiumUser.id) !== partnerId)) {
            res.status(403).json({ error: "You can only report a friend or your current Premium chat partner." });
            return;
        }

        await pool.query(
            "DELETE FROM premium_chat_reports WHERE created_at <= NOW() - INTERVAL '30 days'"
        );
        const result = await pool.query(
            `SELECT m.sender_id AS "senderId", u.username AS "senderName", m.body,
                    m.media_id AS "mediaId", media.mime_type AS "mediaType",
                    m.created_at AS "sentAt"
             FROM (
                 SELECT * FROM premium_messages
                 WHERE ((sender_id = $1 AND recipient_id = $2)
                    OR (sender_id = $2 AND recipient_id = $1))
                   AND expires_at > NOW()
                 ORDER BY created_at DESC
                 LIMIT 100
             ) m
             JOIN premium_users u ON u.id = m.sender_id
             LEFT JOIN premium_media media ON media.id = m.media_id
             ORDER BY m.created_at`,
            [req.premiumUser.id, partnerId]
        );
        await pool.query(
            `INSERT INTO premium_chat_reports
                (id, reporter_id, reported_id, category, transcript)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [crypto.randomUUID(), req.premiumUser.id, partnerId, category, JSON.stringify(result.rows)]
        );
        res.status(201).json({ success: true });
    }));

    app.post("/api/premium/media/:recipientId", requireActivePremium, uploadPremiumMedia, asyncRoute(async (req, res) => {
        const recipientId = req.params.recipientId;
        const file = req.file;
        if (!file) {
            res.status(400).json({ error: "Choose an audio or video file to send." });
            return;
        }
        if (await areBlocked(req.premiumUser.id, recipientId) ||
            (!await areFriends(req.premiumUser.id, recipientId) &&
            randomPartnersByUser.get(req.premiumUser.id) !== recipientId)) {
            res.status(403).json({ error: "You can only send media to an active chat or friend." });
            return;
        }
        const mediaType = detectMediaType(file.buffer, file.mimetype);
        if (!mediaType) {
            res.status(415).json({ error: "Unsupported audio/video file format." });
            return;
        }

        const mediaId = crypto.randomUUID();
        const messageId = crypto.randomUUID();
        const caption = String(req.body && req.body.caption || "").trim().slice(0, 2000);
        const viewOnce = req.body && req.body.viewOnce === "true";
        const client = await pool.connect();
        let message;
        try {
            await client.query("BEGIN");
            await client.query(
                `INSERT INTO premium_media (id, uploader_id, mime_type, file_size, data)
                 VALUES ($1, $2, $3, $4, $5)`,
                [mediaId, req.premiumUser.id, mediaType, file.size, file.buffer]
            );
            const result = await client.query(
                `INSERT INTO premium_messages
                    (id, sender_id, recipient_id, body, media_id, view_once, expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '${CHAT_TTL_HOURS} hours')
                 RETURNING id, sender_id AS "senderId", recipient_id AS "recipientId", body,
                           view_once AS "viewOnce", viewed_at AS "viewedAt", created_at AS "createdAt",
                           expires_at AS "expiresAt", media_id AS "mediaId"`,
                [messageId, req.premiumUser.id, recipientId, caption, mediaId, viewOnce]
            );
            message = { ...result.rows[0], mediaType, mediaSize: file.size };
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }

        premiumIo.to(`premium-user:${req.premiumUser.id}`).to(`premium-user:${recipientId}`)
            .emit("premium-chat-message", message);
        res.status(201).json(message);
    }));

    app.get("/api/premium/media/:mediaId", requireActivePremium, asyncRoute(async (req, res) => {
        const result = await pool.query(
            `SELECT m.id AS "messageId", m.sender_id AS "senderId", m.recipient_id AS "recipientId",
                    m.view_once AS "viewOnce", m.viewed_at AS "viewedAt", m.expires_at AS "expiresAt",
                    media.mime_type AS "mediaType", media.data
             FROM premium_messages m
             JOIN premium_media media ON media.id = m.media_id
             WHERE media.id = $1 AND (m.sender_id = $2 OR m.recipient_id = $2)
               AND m.expires_at > NOW()`,
            [req.params.mediaId, req.premiumUser.id]
        );
        if (!result.rowCount) {
            res.status(404).json({ error: "This media message has expired or is unavailable." });
            return;
        }
        const media = result.rows[0];
        const otherUserId = media.senderId === req.premiumUser.id ? media.recipientId : media.senderId;
        if (await areBlocked(req.premiumUser.id, otherUserId) ||
            (!await areFriends(req.premiumUser.id, otherUserId) &&
            randomPartnersByUser.get(req.premiumUser.id) !== otherUserId)) {
            res.status(403).json({ error: "You can only open media from an active chat or friend." });
            return;
        }
        if (media.viewOnce && media.recipientId === req.premiumUser.id && media.viewedAt) {
            res.status(410).json({ error: "This single-view media has already been opened." });
            return;
        }
        if (media.viewOnce && media.recipientId === req.premiumUser.id) {
            const viewed = await pool.query(
                `UPDATE premium_messages
                 SET viewed_at = NOW(), expires_at = NOW() + INTERVAL '${SINGLE_VIEW_TTL_SECONDS} seconds'
                 WHERE id = $1 AND recipient_id = $2 AND view_once = TRUE
                   AND viewed_at IS NULL AND expires_at > NOW()
                 RETURNING id, sender_id AS "senderId", recipient_id AS "recipientId",
                           expires_at AS "expiresAt"`,
                [media.messageId, req.premiumUser.id]
            );
            if (!viewed.rowCount) {
                res.status(410).json({ error: "This single-view media has already been opened." });
                return;
            }
            const opened = viewed.rows[0];
            media.expiresAt = opened.expiresAt;
            premiumIo.to(`premium-user:${opened.senderId}`).to(`premium-user:${opened.recipientId}`)
                .emit("premium-message-viewed", opened);
        }

        res.set({
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Message-Expires-At": new Date(media.expiresAt).toISOString(),
            "Content-Type": media.mediaType
        });
        res.send(media.data);
    }));

    app.post("/api/premium/friends/request", requireActivePremium, asyncRoute(async (req, res) => {
        const friend = await pool.query(
            `SELECT id, username, premium_expires_at, premium_locked_at FROM premium_users
             WHERE LOWER(username) = LOWER($1)
               AND premium_locked_at IS NULL
               AND premium_expires_at + INTERVAL '${PREMIUM_GRACE_HOURS} hours' > NOW()`,
            [String(req.body && req.body.username || "").trim()]
        );
        if (!friend.rowCount || friend.rows[0].id === req.premiumUser.id) {
            res.status(404).json({ error: "No other account with that username was found." });
            return;
        }
        if (!friend.rows[0].premium_expires_at ||
            new Date(friend.rows[0].premium_expires_at).getTime() +
                PREMIUM_GRACE_HOURS * 60 * 60 * 1000 <= Date.now()) {
            res.status(400).json({ error: "Both users need an active Premium membership to be friends." });
            return;
        }
        const friendId = friend.rows[0].id;
        if (await areBlocked(req.premiumUser.id, friendId)) {
            res.status(403).json({ error: "Friend requests are unavailable for this account." });
            return;
        }
        if (await areFriends(req.premiumUser.id, friendId)) {
            res.status(409).json({ error: "You are already friends." });
            return;
        }
        const reciprocal = await pool.query(
            `SELECT status FROM premium_friend_requests
             WHERE sender_id = $1 AND recipient_id = $2`,
            [friendId, req.premiumUser.id]
        );
        if (reciprocal.rows[0] && reciprocal.rows[0].status === "pending") {
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                await client.query(
                    `UPDATE premium_friend_requests SET status = 'accepted', updated_at = NOW()
                     WHERE (sender_id = $1 AND recipient_id = $2)
                        OR (sender_id = $2 AND recipient_id = $1)`,
                    [friendId, req.premiumUser.id]
                );
                await client.query(
                    `INSERT INTO premium_friends (user_id, friend_id) VALUES ($1, $2), ($2, $1)
                     ON CONFLICT DO NOTHING`,
                    [req.premiumUser.id, friendId]
                );
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            } finally {
                client.release();
            }
            const currentFriend = {
                id: req.premiumUser.id,
                username: req.premiumUser.username
            };
            const newFriend = { id: friendId, username: friend.rows[0].username };
            premiumIo.to(`premium-user:${friendId}`).emit("premium-friend-added", currentFriend);
            premiumIo.to(`premium-user:${req.premiumUser.id}`).emit("premium-friend-added", newFriend);
            res.status(201).json({ success: true, accepted: true });
            return;
        }

        const request = await pool.query(
            `INSERT INTO premium_friend_requests (sender_id, recipient_id)
             VALUES ($1, $2)
             ON CONFLICT (sender_id, recipient_id)
             DO UPDATE SET status = 'pending', created_at = NOW(), updated_at = NOW()
             WHERE premium_friend_requests.status = 'rejected'
             RETURNING sender_id`,
            [req.premiumUser.id, friendId]
        );
        if (!request.rowCount) {
            res.status(409).json({ error: "You already sent this friend request." });
            return;
        }
        premiumIo.to(`premium-user:${friendId}`).emit("premium-friend-request", {
            id: req.premiumUser.id,
            username: req.premiumUser.username
        });
        res.status(201).json({ success: true, requestSent: true });
    }));

    app.post("/api/premium/friend-requests/:senderId/respond",
        requireActivePremium,
        asyncRoute(async (req, res) => {
            const accept = req.body && req.body.accept;
            if (typeof accept !== "boolean" || req.params.senderId === req.premiumUser.id) {
                res.status(400).json({ error: "Choose whether to accept or reject this request." });
                return;
            }
            if (await areBlocked(req.premiumUser.id, req.params.senderId)) {
                res.status(403).json({ error: "This friend request is unavailable." });
                return;
            }
            const client = await pool.connect();
            let sender;
            try {
                await client.query("BEGIN");
                const request = await client.query(
                    `SELECT u.id, u.username
                     FROM premium_friend_requests r
                     JOIN premium_users u ON u.id = r.sender_id
                     WHERE r.sender_id = $1 AND r.recipient_id = $2 AND r.status = 'pending'
                     FOR UPDATE OF r`,
                    [req.params.senderId, req.premiumUser.id]
                );
                if (!request.rowCount) {
                    await client.query("ROLLBACK");
                    res.status(404).json({ error: "This friend request is no longer pending." });
                    return;
                }
                sender = request.rows[0];
                await client.query(
                    `UPDATE premium_friend_requests SET status = $3, updated_at = NOW()
                     WHERE sender_id = $1 AND recipient_id = $2`,
                    [sender.id, req.premiumUser.id, accept ? "accepted" : "rejected"]
                );
                await client.query(
                    `UPDATE premium_friend_requests SET status = $3, updated_at = NOW()
                     WHERE sender_id = $2 AND recipient_id = $1 AND status = 'pending'`,
                    [sender.id, req.premiumUser.id, accept ? "accepted" : "rejected"]
                );
                if (accept) {
                    await client.query(
                        `INSERT INTO premium_friends (user_id, friend_id) VALUES ($1, $2), ($2, $1)
                         ON CONFLICT DO NOTHING`,
                        [req.premiumUser.id, sender.id]
                    );
                }
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            } finally {
                client.release();
            }
            if (accept) {
                premiumIo.to(`premium-user:${sender.id}`).emit("premium-friend-added", {
                    id: req.premiumUser.id,
                    username: req.premiumUser.username
                });
                premiumIo.to(`premium-user:${req.premiumUser.id}`).emit("premium-friend-added", sender);
            }
            premiumIo.to(`premium-user:${sender.id}`).emit("premium-friend-request-updated", {
                recipientId: req.premiumUser.id,
                accepted: accept
            });
            res.json({ success: true, accepted: accept });
        }));

    app.post("/api/premium/invites", requireActivePremium, asyncRoute(async (req, res) => {
        const token = crypto.randomBytes(32).toString("hex");
        await pool.query(
            `INSERT INTO premium_invites (token_hash, user_id, expires_at)
             VALUES ($1, $2, NOW() + INTERVAL '24 hours')`,
            [hash(token), req.premiumUser.id]
        );
        res.status(201).json({ token });
    }));

    app.post("/api/premium/invites/accept", requireUser, asyncRoute(async (req, res) => {
        const token = typeof (req.body && req.body.token) === "string" ? req.body.token : "";
        if (!/^[a-f0-9]{64}$/.test(token)) {
            res.status(400).json({ error: "This Premium invitation is invalid." });
            return;
        }
        const inviter = await acceptFriendInvite(hash(token), req.premiumUser.id);
        if (!inviter) {
            res.status(400).json({ error: "This invitation is expired or has already been used." });
            return;
        }
        premiumIo.to(`premium-user:${inviter.id}`).emit("premium-friend-added", {
            id: req.premiumUser.id,
            username: req.premiumUser.username
        });
        res.json({ success: true, friend: inviter });
    }));

    app.get("/api/premium/user/:userId", requireActivePremium, asyncRoute(async (req, res) => {
        if (req.params.userId !== req.premiumUser.id &&
            await areBlocked(req.premiumUser.id, req.params.userId)) {
            res.status(404).json({ error: "Premium user was not found." });
            return;
        }
        const result = await pool.query(
            `SELECT u.id, u.username, u.display_name AS "displayName", u.bio,
                    u.country, u.language, u.interests,
                    u.profile_private AS "profilePrivate",
                    u.avatar_mime_type IS NOT NULL AS "hasAvatar",
                    EXISTS (
                        SELECT 1 FROM premium_friends f
                        WHERE f.user_id = $2 AND f.friend_id = u.id
                    ) AS "isFriend"
             FROM premium_users u
             WHERE u.id = $1 AND u.premium_locked_at IS NULL
               AND u.premium_expires_at + INTERVAL '${PREMIUM_GRACE_HOURS} hours' > NOW()`,
            [req.params.userId, req.premiumUser.id]
        );
        if (!result.rowCount) {
            res.status(404).json({ error: "Premium user was not found." });
            return;
        }
        if (result.rows[0].profilePrivate && !result.rows[0].isFriend &&
            result.rows[0].id !== req.premiumUser.id) {
            res.status(403).json({ error: "This profile is private." });
            return;
        }
        delete result.rows[0].profilePrivate;
        delete result.rows[0].isFriend;
        res.json(result.rows[0]);
    }));

    app.get("/api/admin/premium/reports", requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
        await pool.query(
            "DELETE FROM premium_chat_reports WHERE created_at <= NOW() - INTERVAL '30 days'"
        );
        const result = await pool.query(
            `SELECT r.id, r.category, r.status, r.created_at AS "createdAt",
                    r.reviewed_at AS "reviewedAt", reporter.username AS "reporterName",
                    reported.username AS "reportedName",
                    jsonb_array_length(r.transcript) AS "messageCount"
             FROM premium_chat_reports r
             JOIN premium_users reporter ON reporter.id = r.reporter_id
             JOIN premium_users reported ON reported.id = r.reported_id
             ORDER BY r.created_at DESC
             LIMIT 500`
        );
        res.set("Cache-Control", "no-store");
        res.json({ reports: result.rows });
    }));

    app.get("/api/admin/premium/reports/:reportId", requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
        const reason = typeof req.query.reason === "string" ? req.query.reason.trim().slice(0, 500) : "";
        if (reason.length < 10) {
            res.status(400).json({ error: "Enter at least 10 characters explaining why you need to access this reported conversation." });
            return;
        }
        const accessEvent = {
            accessedAt: new Date().toISOString(),
            reason,
            actor: "admin"
        };
        const result = await pool.query(
            `UPDATE premium_chat_reports
             SET access_log = COALESCE(access_log, '[]'::jsonb) || $2::jsonb
             WHERE id = $1 AND created_at > NOW() - INTERVAL '30 days'
             RETURNING id, reporter_id AS "reporterId", reported_id AS "reportedId",
                       category, status, review_note AS "reviewNote",
                       created_at AS "createdAt", reviewed_at AS "reviewedAt",
                       transcript, access_log AS "accessLog", audit_log AS "auditLog"`,
            [req.params.reportId, JSON.stringify([accessEvent])]
        );
        if (!result.rowCount) {
            res.status(404).json({ error: "This report was not found or has expired." });
            return;
        }
        const report = result.rows[0];
        const names = await pool.query(
            `SELECT id, username FROM premium_users
             WHERE id = ANY($1::text[])`,
            [[report.reporterId, report.reportedId]]
        );
        const usernames = new Map(names.rows.map((user) => [user.id, user.username]));
        report.reporterName = usernames.get(report.reporterId) || "Deleted account";
        report.reportedName = usernames.get(report.reportedId) || "Deleted account";
        res.set("Cache-Control", "no-store");
        res.json({ report });
    }));

    app.patch("/api/admin/premium/reports/:reportId", requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
        const status = req.body && req.body.status;
        const note = typeof (req.body && req.body.note) === "string"
            ? req.body.note.trim().slice(0, 1000)
            : "";
        if (!["pending", "resolved"].includes(status)) {
            res.status(400).json({ error: "Choose pending or resolved." });
            return;
        }
        const auditEvent = {
            action: status === "resolved" ? "resolved" : "reopened",
            at: new Date().toISOString(),
            note,
            actor: "admin"
        };
        const result = await pool.query(
            `UPDATE premium_chat_reports
             SET status = $2, review_note = $3,
                 reviewed_at = CASE WHEN $2 = 'resolved' THEN NOW() ELSE NULL END,
                 audit_log = COALESCE(audit_log, '[]'::jsonb) || $4::jsonb
             WHERE id = $1 AND created_at > NOW() - INTERVAL '30 days'
             RETURNING id`,
            [req.params.reportId, status, note, JSON.stringify([auditEvent])]
        );
        if (!result.rowCount) {
            res.status(404).json({ error: "This report was not found or has expired." });
            return;
        }
        res.json({ success: true });
    }));

    app.get("/api/admin/premium/coupons", requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
        const result = await pool.query(
            `SELECT code, discount_percent AS "discountPercent", max_redemptions AS "maxRedemptions",
                    redemption_count AS "redemptionCount", expires_at AS "expiresAt", created_at AS "createdAt"
             FROM premium_coupons ORDER BY created_at DESC LIMIT 100`
        );
        res.json({ coupons: result.rows });
    }));

    app.post("/api/admin/premium/coupons", requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
        const suppliedCode = String(req.body && req.body.code || "").trim().toUpperCase();
        const code = suppliedCode || `OME${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
        const discount = Number(req.body && req.body.discountPercent);
        const maxRedemptions = Number(req.body && req.body.maxRedemptions);
        const expiresAt = req.body && req.body.expiresAt ? new Date(req.body.expiresAt) : null;
        if (!/^[A-Z0-9_-]{4,32}$/.test(code) || !Number.isInteger(discount) || discount < 1 || discount > 90 ||
            !Number.isInteger(maxRedemptions) || maxRedemptions < 1 || maxRedemptions > 100000 ||
            (expiresAt && Number.isNaN(expiresAt.getTime()))) {
            res.status(400).json({ error: "Enter a valid code, 1–90% discount, usage limit, and optional expiry." });
            return;
        }
        try {
            await pool.query(
                `INSERT INTO premium_coupons (code, discount_percent, max_redemptions, expires_at)
                 VALUES ($1, $2, $3, $4)`,
                [code, discount, maxRedemptions, expiresAt]
            );
        } catch (error) {
            if (error.code === "23505") {
                res.status(409).json({ error: "That coupon code already exists." });
                return;
            }
            throw error;
        }
        res.status(201).json({ code, discountPercent: discount, maxRedemptions, expiresAt });
    }));

    app.get("/api/admin/premium/payment-qr", requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
        const result = await pool.query(
            "SELECT updated_at AS \"updatedAt\" FROM premium_payment_qr WHERE id = 'primary'"
        );
        res.json({ configured: Boolean(result.rowCount), updatedAt: result.rows[0]?.updatedAt || null });
    }));

    app.post("/api/admin/premium/payment-qr", requireAdmin, requireDatabase, uploadPaymentQr, asyncRoute(async (req, res) => {
        if (!req.file) {
            res.status(400).json({ error: "Select a JPG, PNG, or WebP QR image to upload." });
            return;
        }
        const mimeType = detectImageType(req.file.buffer);
        if (!mimeType) {
            res.status(400).json({ error: "The QR file is not a valid JPG, PNG, or WebP image." });
            return;
        }
        const result = await pool.query(
            `INSERT INTO premium_payment_qr (id, mime_type, data)
             VALUES ('primary', $1, $2)
             ON CONFLICT (id) DO UPDATE SET mime_type = EXCLUDED.mime_type,
                 data = EXCLUDED.data, updated_at = NOW()
             RETURNING updated_at AS "updatedAt"`,
            [mimeType, req.file.buffer]
        );
        res.json({ success: true, updatedAt: result.rows[0].updatedAt });
    }));

    app.delete("/api/admin/premium/payment-qr", requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
        await pool.query("DELETE FROM premium_payment_qr WHERE id = 'primary'");
        res.json({ success: true });
    }));

    app.get("/api/admin/premium/payment-requests", requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
        const result = await pool.query(
            `SELECT p.id, p.user_id AS "userId", u.username, u.email,
                    p.requested_plan AS "requestedPlan", p.approved_plan AS "approvedPlan",
                    p.requested_amount_inr AS "requestedAmountInr",
                    p.verified_amount_inr AS "verifiedAmountInr",
                    p.discount_percent AS "discountPercent", p.coupon_code AS "couponCode",
                    p.utr, p.status, p.admin_note AS "adminNote",
                    p.created_at AS "createdAt", p.reviewed_at AS "reviewedAt",
                    p.activated_at AS "activatedAt", p.plan_expires_at AS "planExpiresAt"
             FROM premium_manual_payment_requests p
             JOIN premium_users u ON u.id = p.user_id
             ORDER BY (p.status = 'pending') DESC, p.created_at DESC LIMIT 500`
        );
        res.json({ requests: result.rows });
    }));

    app.get("/api/admin/premium/payment-requests/:requestId/proof",
        requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
            const result = await pool.query(
                `SELECT proof_mime_type, proof_data FROM premium_manual_payment_requests
                 WHERE id = $1`,
                [req.params.requestId]
            );
            if (!result.rowCount) {
                res.status(404).json({ error: "Payment proof was not found." });
                return;
            }
            res.set("Cache-Control", "no-store");
            res.type(result.rows[0].proof_mime_type).send(result.rows[0].proof_data);
        })
    );

    app.post("/api/admin/premium/payment-requests/:requestId/approve",
        requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
            const plan = getPremiumPlan(String(req.body && req.body.planId || ""));
            const verifiedAmountInr = Number(req.body && req.body.verifiedAmountInr);
            if (!plan || !Number.isSafeInteger(verifiedAmountInr) || verifiedAmountInr < 1 ||
                verifiedAmountInr > 1000000) {
                res.status(400).json({ error: "Select the verified plan and enter the amount received." });
                return;
            }

            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                const request = await client.query(
                    `SELECT id, user_id, coupon_code, discount_percent, status
                     FROM premium_manual_payment_requests WHERE id = $1 FOR UPDATE`,
                    [req.params.requestId]
                );
                if (!request.rowCount || request.rows[0].status !== "pending") {
                    await client.query("ROLLBACK");
                    res.status(409).json({ error: "This payment request is missing or has already been reviewed." });
                    return;
                }
                if (request.rows[0].coupon_code) {
                    const coupon = await client.query(
                        `SELECT max_redemptions, redemption_count
                         FROM premium_coupons WHERE code = $1 FOR UPDATE`,
                        [request.rows[0].coupon_code]
                    );
                    if (!coupon.rowCount ||
                        coupon.rows[0].redemption_count >= coupon.rows[0].max_redemptions) {
                        await client.query("ROLLBACK");
                        res.status(409).json({ error: "This coupon has reached its redemption limit; resolve the request manually." });
                        return;
                    }
                    await client.query(
                        "UPDATE premium_coupons SET redemption_count = redemption_count + 1 WHERE code = $1",
                        [request.rows[0].coupon_code]
                    );
                }

                const account = await client.query(
                    `UPDATE premium_users
                     SET premium_plan = $2,
                         premium_expires_at = GREATEST(COALESCE(premium_expires_at, NOW()), NOW())
                             + ($3 * INTERVAL '1 month'),
                         premium_locked_at = NULL,
                         premium_locked_reason = NULL
                     WHERE id = $1
                     RETURNING username, premium_expires_at - ($3 * INTERVAL '1 month') AS "activatedAt",
                               premium_expires_at AS "planExpiresAt"`,
                    [request.rows[0].user_id, plan.id, plan.months]
                );
                if (!account.rowCount) {
                    await client.query("ROLLBACK");
                    res.status(404).json({ error: "The account for this payment request was not found." });
                    return;
                }
                await client.query(
                    `UPDATE premium_manual_payment_requests
                     SET status = 'approved', approved_plan = $2, verified_amount_inr = $3,
                         activated_at = $4, plan_expires_at = $5, reviewed_at = NOW()
                     WHERE id = $1`,
                    [req.params.requestId, plan.id, verifiedAmountInr,
                        account.rows[0].activatedAt, account.rows[0].planExpiresAt]
                );
                await client.query("COMMIT");
                res.json({
                    success: true,
                    username: account.rows[0].username,
                    plan: plan.id,
                    activatedAt: account.rows[0].activatedAt,
                    planExpiresAt: account.rows[0].planExpiresAt
                });
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            } finally {
                client.release();
            }
        })
    );

    app.post("/api/admin/premium/payment-requests/:requestId/reject",
        requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
            const note = typeof (req.body && req.body.note) === "string"
                ? req.body.note.trim().slice(0, 500)
                : "";
            const result = await pool.query(
                `UPDATE premium_manual_payment_requests
                 SET status = 'rejected', admin_note = $2, reviewed_at = NOW()
                 WHERE id = $1 AND status = 'pending'
                 RETURNING id`,
                [req.params.requestId, note || null]
            );
            if (!result.rowCount) {
                res.status(409).json({ error: "This payment request is missing or has already been reviewed." });
                return;
            }
            res.json({ success: true });
        })
    );

    app.get("/api/admin/premium/deletion-requests", requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
        const result = await pool.query(
            `SELECT d.id, d.user_id AS "userId", u.username, u.email, d.reason,
                    d.status, d.requested_at AS "requestedAt"
             FROM premium_account_deletion_requests d
             JOIN premium_users u ON u.id = d.user_id
             WHERE d.status = 'pending'
             ORDER BY d.requested_at LIMIT 200`
        );
        res.json({ requests: result.rows });
    }));

    app.delete("/api/admin/premium/deletion-requests/:requestId",
        requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
            const result = await pool.query(
                `DELETE FROM premium_users WHERE id = (
                    SELECT user_id FROM premium_account_deletion_requests
                    WHERE id = $1 AND status = 'pending'
                 ) RETURNING username`,
                [req.params.requestId]
            );
            if (!result.rowCount) {
                res.status(404).json({ error: "Pending account deletion request was not found." });
                return;
            }
            res.json({ success: true, username: result.rows[0].username });
        })
    );

    app.get("/api/admin/premium/members", requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
        const result = await pool.query(
            `SELECT id, email, username, premium_plan AS "premiumPlan",
                    premium_locked_at AS "premiumLockedAt",
                    premium_locked_reason AS "premiumLockedReason",
                    premium_expires_at AS "premiumExpiresAt", created_at AS "createdAt"
             FROM premium_users ORDER BY created_at DESC LIMIT 200`
        );
        res.json({ members: result.rows });
    }));

    app.post("/api/admin/premium/members/:userId/grant", requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
        const days = Number(req.body && req.body.days);
        if (!Number.isInteger(days) || days < 1 || days > 3650) {
            res.status(400).json({ error: "Grant duration must be from 1 to 3650 days." });
            return;
        }
        const result = await pool.query(
            `UPDATE premium_users
             SET premium_expires_at = GREATEST(COALESCE(premium_expires_at, NOW()), NOW())
                 + ($2 * INTERVAL '1 day'),
                 premium_locked_at = NULL, premium_locked_reason = NULL
             WHERE id = $1
             RETURNING id, username, premium_expires_at AS "premiumExpiresAt"`,
            [req.params.userId, days]
        );
        if (!result.rowCount) {
            res.status(404).json({ error: "Premium user was not found." });
            return;
        }
        res.json(result.rows[0]);
    }));

    app.post("/api/admin/premium/members/:userId/revoke", requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
        const result = await pool.query(
            `UPDATE premium_users
             SET premium_expires_at = NOW() - INTERVAL '${PREMIUM_GRACE_HOURS + 1} hours',
                 premium_locked_at = NULL, premium_locked_reason = NULL
             WHERE id = $1 RETURNING id, username`,
            [req.params.userId]
        );
        if (!result.rowCount) {
            res.status(404).json({ error: "Premium user was not found." });
            return;
        }
        premiumIo.to(`premium-user:${req.params.userId}`).emit("premium-membership-expired");
        premiumIo.in(`premium-user:${req.params.userId}`).disconnectSockets(true);
        res.json({ success: true });
    }));

    app.post("/api/admin/premium/members/:userId/lock", requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
        const reason = typeof (req.body && req.body.reason) === "string"
            ? req.body.reason.trim().slice(0, 200)
            : "";
        const result = await pool.query(
            `UPDATE premium_users SET premium_locked_at = NOW(), premium_locked_reason = $2
             WHERE id = $1 RETURNING id, username`,
            [req.params.userId, reason || "Locked by admin"]
        );
        if (!result.rowCount) {
            res.status(404).json({ error: "Premium user was not found." });
            return;
        }
        premiumIo.to(`premium-user:${req.params.userId}`).emit("premium-membership-expired");
        premiumIo.in(`premium-user:${req.params.userId}`).disconnectSockets(true);
        res.json({ success: true });
    }));

    app.post("/api/admin/premium/members/:userId/unlock", requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
        const result = await pool.query(
            `UPDATE premium_users SET premium_locked_at = NULL, premium_locked_reason = NULL
             WHERE id = $1 RETURNING id, username`,
            [req.params.userId]
        );
        if (!result.rowCount) {
            res.status(404).json({ error: "Premium user was not found." });
            return;
        }
        res.json({ success: true });
    }));

    if (pool) {
        io.on("connection", (socket) => {
            socket.on("premium-invite", async (data, acknowledge) => {
                try {
                    const token = typeof (data && data.token) === "string" ? data.token : "";
                    const partnerId = typeof (data && data.partnerId) === "string" ? data.partnerId : "";
                    const partnerSocket = io.sockets.sockets.get(partnerId);
                    const sharedRoom = partnerSocket && [...socket.rooms].find((room) =>
                        room !== socket.id && partnerSocket.rooms.has(room)
                    );
                    if (!/^[a-f0-9]{64}$/.test(token) || !partnerSocket || !sharedRoom) {
                        if (typeof acknowledge === "function") {
                            acknowledge({ error: "You need an active random chat to invite someone." });
                        }
                        return;
                    }

                    const invite = await pool.query(
                        `SELECT u.username
                         FROM premium_invites i JOIN premium_users u ON u.id = i.user_id
                         WHERE i.token_hash = $1 AND i.expires_at > NOW()
                           AND i.redeemed_by IS NULL AND u.premium_locked_at IS NULL
                           AND u.premium_expires_at + INTERVAL '${PREMIUM_GRACE_HOURS} hours' > NOW()`,
                        [hash(token)]
                    );
                    if (!invite.rowCount) {
                        if (typeof acknowledge === "function") {
                            acknowledge({ error: "This Premium invitation is no longer available." });
                        }
                        return;
                    }
                    partnerSocket.emit("premium-invite", {
                        username: invite.rows[0].username,
                        url: `/premium?invite=${encodeURIComponent(token)}`
                    });
                    if (typeof acknowledge === "function") acknowledge({ success: true });
                } catch (error) {
                    console.error("Could not relay Premium invitation:", error.message);
                    if (typeof acknowledge === "function") {
                        acknowledge({ error: "Could not send this invitation." });
                    }
                }
            });
        });

        premiumIo.use(async (socket, next) => {
            try {
                if (!databaseReady) {
                    next(new Error("Premium database is not ready yet."));
                    return;
                }
                const cookies = Object.fromEntries((socket.handshake.headers.cookie || "")
                    .split(";")
                    .map((part) => part.trim().split("="))
                    .filter((pair) => pair.length >= 2)
                    .map(([key, ...value]) => [key, decodeURIComponent(value.join("="))]));
                const user = await findSession(cookies[SESSION_COOKIE]);
                if (!user || !user.premium_expires_at ||
                    new Date(user.premium_expires_at).getTime() +
                        PREMIUM_GRACE_HOURS * 60 * 60 * 1000 <= Date.now() ||
                    user.premium_locked_at) {
                    next(new Error("Active Premium membership required."));
                    return;
                }
                socket.data.premiumUser = user;
                next();
            } catch (error) {
                console.error("Premium socket authentication failed:", error.message);
                next(new Error("Could not verify Premium account."));
            }
        });

        premiumIo.on("connection", (socket) => {
            const user = socket.data.premiumUser;
            recordConnection();
            socket.join(`premium-user:${user.id}`);
            if (!socketsByUser.has(user.id)) socketsByUser.set(user.id, new Set());
            socketsByUser.get(user.id).add(socket.id);

            socket.on("premium-find-stranger", async () => {
                if (activePremiumPartners.has(socket.id) || waitingPremium.includes(socket.id) ||
                    randomPartnersByUser.has(user.id)) return;
                if (waitingPremium.some((socketId) =>
                    premiumIo.sockets.sockets.get(socketId)?.data.premiumUser.id === user.id
                )) {
                    socket.emit("premium-waiting");
                    return;
                }
                let partnerIndex = -1;
                for (let index = 0; index < waitingPremium.length; index += 1) {
                    const candidate = premiumIo.sockets.sockets.get(waitingPremium[index]);
                    if (!candidate || candidate.data.premiumUser.id === user.id) continue;
                    if (await areBlocked(user.id, candidate.data.premiumUser.id)) continue;
                    partnerIndex = index;
                    break;
                }
                if (partnerIndex < 0) {
                    waitingPremium.push(socket.id);
                    socket.emit("premium-waiting");
                    return;
                }

                const [partnerSocketId] = waitingPremium.splice(partnerIndex, 1);
                const partnerSocket = premiumIo.sockets.sockets.get(partnerSocketId);
                if (!partnerSocket || !partnerSocket.connected) {
                    socket.emit("premium-waiting");
                    waitingPremium.push(socket.id);
                    return;
                }
                activePremiumPartners.set(socket.id, partnerSocketId);
                activePremiumPartners.set(partnerSocketId, socket.id);
                randomPartnersByUser.set(user.id, partnerSocket.data.premiumUser.id);
                randomPartnersByUser.set(partnerSocket.data.premiumUser.id, user.id);
                socket.emit("premium-matched", {
                    userId: partnerSocket.data.premiumUser.id,
                    username: partnerSocket.data.premiumUser.username
                });
                partnerSocket.emit("premium-matched", {
                    userId: user.id,
                    username: user.username
                });
            });

            socket.on("premium-cancel-search", () => {
                const index = waitingPremium.indexOf(socket.id);
                if (index >= 0) waitingPremium.splice(index, 1);
            });

            socket.on("premium-leave-random", () => {
                const partnerSocketId = activePremiumPartners.get(socket.id);
                if (!partnerSocketId) return;
                activePremiumPartners.delete(socket.id);
                activePremiumPartners.delete(partnerSocketId);
                const partnerSocket = premiumIo.sockets.sockets.get(partnerSocketId);
                const partnerId = partnerSocket && partnerSocket.data.premiumUser.id;
                randomPartnersByUser.delete(user.id);
                if (partnerId && randomPartnersByUser.get(partnerId) === user.id) {
                    randomPartnersByUser.delete(partnerId);
                }
                if (partnerSocket) partnerSocket.emit("premium-match-ended");
            });

            socket.on("premium-add-random-friend", async (acknowledge) => {
                const partnerSocketId = activePremiumPartners.get(socket.id);
                const partnerSocket = partnerSocketId && io.sockets.sockets.get(partnerSocketId);
                if (!partnerSocket) {
                    if (typeof acknowledge === "function") acknowledge({ error: "No active premium match." });
                    return;
                }
                try {
                    if (await areBlocked(user.id, partnerSocket.data.premiumUser.id)) {
                        if (typeof acknowledge === "function") {
                            acknowledge({ error: "Friend requests are unavailable for this account." });
                        }
                        return;
                    }
                    const target = partnerSocket.data.premiumUser;
                    if (await areFriends(user.id, target.id)) {
                        if (typeof acknowledge === "function") {
                            acknowledge({ success: true, alreadyFriends: true });
                        }
                        return;
                    }
                    const request = await pool.query(
                        `INSERT INTO premium_friend_requests (sender_id, recipient_id)
                         VALUES ($1, $2)
                         ON CONFLICT (sender_id, recipient_id)
                         DO UPDATE SET status = 'pending', created_at = NOW(), updated_at = NOW()
                         WHERE premium_friend_requests.status = 'rejected'
                         RETURNING sender_id`,
                        [user.id, target.id]
                    );
                    if (!request.rowCount) {
                        if (typeof acknowledge === "function") {
                            acknowledge({ error: "You already sent this friend request." });
                        }
                        return;
                    }
                    partnerSocket.emit("premium-friend-request", {
                        id: user.id,
                        username: user.username
                    });
                    if (typeof acknowledge === "function") {
                        acknowledge({ success: true, requestSent: true });
                    }
                } catch (error) {
                    console.error("Could not add premium friends:", error.message);
                    if (typeof acknowledge === "function") acknowledge({ error: "Could not add friend." });
                }
            });

            socket.on("premium-send-message", async (data, acknowledge) => {
                try {
                    const friendId = String(data && data.friendId || "");
                    const body = String(data && data.message || "").trim();
                    if (!body || body.length > 2000 ||
                        await areBlocked(user.id, friendId) ||
                        (!await areFriends(user.id, friendId) && randomPartnersByUser.get(user.id) !== friendId)) {
                        if (typeof acknowledge === "function") acknowledge({ error: "Invalid message or friend." });
                        return;
                    }
                    const viewOnce = Boolean(data && data.viewOnce);
                    const id = crypto.randomUUID();
                    const result = await pool.query(
                        `INSERT INTO premium_messages
                            (id, sender_id, recipient_id, body, view_once, expires_at)
                         VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '${CHAT_TTL_HOURS} hours')
                         RETURNING id, sender_id AS "senderId", recipient_id AS "recipientId", body,
                                   view_once AS "viewOnce", viewed_at AS "viewedAt", created_at AS "createdAt",
                                   expires_at AS "expiresAt"`,
                        [id, user.id, friendId, body, viewOnce]
                    );
                    premiumIo.to(`premium-user:${user.id}`).to(`premium-user:${friendId}`)
                        .emit("premium-chat-message", result.rows[0]);
                    if (typeof acknowledge === "function") acknowledge({ success: true, id });
                } catch (error) {
                    console.error("Could not save Premium message:", error.message);
                    if (typeof acknowledge === "function") acknowledge({ error: "Could not save this message." });
                }
            });

            socket.on("premium-view-message", async (messageId, acknowledge) => {
                try {
                    const result = await pool.query(
                        `UPDATE premium_messages
                         SET viewed_at = NOW(), expires_at = NOW() + INTERVAL '${SINGLE_VIEW_TTL_SECONDS} seconds'
                         WHERE id = $1 AND recipient_id = $2 AND view_once = TRUE
                           AND viewed_at IS NULL AND expires_at > NOW()
                         RETURNING id, sender_id AS "senderId", recipient_id AS "recipientId", expires_at AS "expiresAt"`,
                        [String(messageId || ""), user.id]
                    );
                    if (!result.rowCount) {
                        if (typeof acknowledge === "function") acknowledge({ error: "This message is no longer available." });
                        return;
                    }
                    const updated = result.rows[0];
                    premiumIo.to(`premium-user:${updated.senderId}`).to(`premium-user:${updated.recipientId}`)
                        .emit("premium-message-viewed", updated);
                    if (typeof acknowledge === "function") acknowledge({ success: true, expiresAt: updated.expiresAt });
                } catch (error) {
                    console.error("Could not mark Premium message as viewed:", error.message);
                    if (typeof acknowledge === "function") acknowledge({ error: "Could not open this message." });
                }
            });

            socket.on("premium-call-signal", async (data) => {
                try {
                    const recipientId = String(data && data.recipientId || "");
                    if (!["offer", "answer", "ice", "end"].includes(data && data.type) ||
                        await areBlocked(user.id, recipientId) ||
                        !await areFriends(user.id, recipientId)) return;
                    premiumIo.to(`premium-user:${recipientId}`).emit("premium-call-signal", {
                        type: data.type,
                        senderId: user.id,
                        description: data.description || null,
                        candidate: data.candidate || null,
                        media: data.media || null
                    });
                } catch (error) {
                    console.error("Could not relay Premium call signal:", error.message);
                }
            });

            socket.on("disconnect", () => {
                const queueIndex = waitingPremium.indexOf(socket.id);
                if (queueIndex >= 0) waitingPremium.splice(queueIndex, 1);
                const partnerSocketId = activePremiumPartners.get(socket.id);
                activePremiumPartners.delete(socket.id);
                if (partnerSocketId) {
                    activePremiumPartners.delete(partnerSocketId);
                    const partnerSocket = premiumIo.sockets.sockets.get(partnerSocketId);
                    const randomPartnerId = randomPartnersByUser.get(user.id);
                    if (randomPartnerId) {
                        randomPartnersByUser.delete(user.id);
                        if (randomPartnersByUser.get(randomPartnerId) === user.id) {
                            randomPartnersByUser.delete(randomPartnerId);
                        }
                    }
                    if (partnerSocket) {
                        partnerSocket.emit("premium-match-ended");
                    }
                }
                const userSockets = socketsByUser.get(user.id);
                if (userSockets) {
                    userSockets.delete(socket.id);
                    if (!userSockets.size) socketsByUser.delete(user.id);
                }
            });
        });

        const expiryTimer = setInterval(async () => {
            try {
                const connectedUserIds = [...socketsByUser.keys()];
                if (connectedUserIds.length) {
                    const expiredUsers = await pool.query(
                        `SELECT id FROM premium_users
                         WHERE id = ANY($1::text[])
                           AND (premium_locked_at IS NOT NULL OR premium_expires_at IS NULL
                                OR premium_expires_at + INTERVAL '${PREMIUM_GRACE_HOURS} hours' <= NOW())`,
                        [connectedUserIds]
                    );
                    for (const expiredUser of expiredUsers.rows) {
                        const room = `premium-user:${expiredUser.id}`;
                        premiumIo.to(room).emit("premium-membership-expired");
                        premiumIo.in(room).disconnectSockets(true);
                    }
                }
                const expired = await pool.query(
                    `DELETE FROM premium_messages WHERE expires_at <= NOW()
                     RETURNING sender_id AS "senderId", recipient_id AS "recipientId", id,
                               media_id AS "mediaId"`
                );
                for (const message of expired.rows) {
                    premiumIo.to(`premium-user:${message.senderId}`).to(`premium-user:${message.recipientId}`)
                        .emit("premium-message-expired", { id: message.id });
                }
                const expiredMediaIds = expired.rows.map((message) => message.mediaId).filter(Boolean);
                if (expiredMediaIds.length) {
                    await pool.query("DELETE FROM premium_media WHERE id = ANY($1::text[])", [expiredMediaIds]);
                }
                await pool.query("DELETE FROM premium_password_resets WHERE expires_at <= NOW()");
                await pool.query(
                    "DELETE FROM premium_invites WHERE expires_at <= NOW() OR redeemed_by IS NOT NULL"
                );
                await pool.query(
                    "DELETE FROM premium_chat_reports WHERE created_at <= NOW() - INTERVAL '30 days'"
                );
            } catch (error) {
                console.error("Could not clean up expired Premium data:", error.message);
            }
        }, 60 * 1000);
        expiryTimer.unref();
    }
}

async function issueSession(userId, res) {
    const token = crypto.randomBytes(32).toString("hex");
    await pool.query(
        `INSERT INTO premium_sessions (token_hash, user_id, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
        [hash(token), userId]
    );
    setSessionCookie(res, token);
}

async function addFriendPair(userId, friendId) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(
            `INSERT INTO premium_friends (user_id, friend_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [userId, friendId]
        );
        await client.query(
            `INSERT INTO premium_friends (user_id, friend_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [friendId, userId]
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

async function acceptFriendInvite(tokenHash, friendId) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query(
            `SELECT u.id, u.username
             FROM premium_invites i
             JOIN premium_users u ON u.id = i.user_id
             WHERE i.token_hash = $1 AND i.expires_at > NOW()
               AND i.redeemed_by IS NULL AND i.user_id <> $2
             FOR UPDATE`,
            [tokenHash, friendId]
        );
        if (!result.rowCount) {
            await client.query("ROLLBACK");
            return null;
        }

        const inviter = result.rows[0];
        const block = await client.query(
            `SELECT 1 FROM premium_blocks
             WHERE (blocker_id = $1 AND blocked_id = $2)
                OR (blocker_id = $2 AND blocked_id = $1)
             LIMIT 1`,
            [inviter.id, friendId]
        );
        if (block.rowCount) {
            await client.query("ROLLBACK");
            return null;
        }
        await client.query(
            `INSERT INTO premium_friends (user_id, friend_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [inviter.id, friendId]
        );
        await client.query(
            `INSERT INTO premium_friends (user_id, friend_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [friendId, inviter.id]
        );
        await client.query(
            "UPDATE premium_invites SET redeemed_by = $2 WHERE token_hash = $1",
            [tokenHash, friendId]
        );
        await client.query("COMMIT");
        return inviter;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    attachPremiumRoutes,
    initializePremiumDatabase,
    normalizeProfileInput,
    detectImageType,
    detectMediaType,
    isPremiumDatabaseConfigured: Boolean(pool)
};
