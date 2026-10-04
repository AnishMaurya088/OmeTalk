const express = require("express");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*"
    }
});

const PORT = process.env.PORT || 3000;
const ADMIN_SESSION_COOKIE = "ometalk_admin_session";
const ADMIN_SESSION_TTL = 8 * 60 * 60 * 1000;
const ADMIN_LOGIN_WINDOW = 15 * 60 * 1000;
const ADMIN_MAX_LOGIN_ATTEMPTS = 5;
const ADMIN_METRICS_FILE = path.join(__dirname, "data", "admin-metrics.json");
const adminSessions = new Map();
const adminLoginAttempts = new Map();
const serverStartedAt = Date.now();

function loadAdminMetrics() {
    try {
        const stored = JSON.parse(fs.readFileSync(ADMIN_METRICS_FILE, "utf8"));
        return {
            totalConnections: Number.isSafeInteger(stored.totalConnections) ? stored.totalConnections : 0,
            totalReports: Number.isSafeInteger(stored.totalReports) ? stored.totalReports : 0,
            daily: stored.daily && typeof stored.daily === "object" ? stored.daily : {}
        };
    } catch (error) {
        if (error.code !== "ENOENT") console.error("Could not read admin metrics:", error.message);
        return { totalConnections: 0, totalReports: 0, daily: {} };
    }
}

const adminMetrics = loadAdminMetrics();

function saveAdminMetrics() {
    try {
        fs.mkdirSync(path.dirname(ADMIN_METRICS_FILE), { recursive: true });
        fs.writeFileSync(ADMIN_METRICS_FILE, JSON.stringify(adminMetrics), { mode: 0o600 });
    } catch (error) {
        console.error("Could not save admin metrics:", error.message);
    }
}

function getDailyMetrics(timestamp = Date.now()) {
    const date = new Date(timestamp).toISOString().slice(0, 10);
    if (!adminMetrics.daily[date]) {
        adminMetrics.daily[date] = { connections: 0, reports: 0 };
    }

    return adminMetrics.daily[date];
}

function recordConnection() {
    adminMetrics.totalConnections += 1;
    getDailyMetrics().connections += 1;
    saveAdminMetrics();
}

function recordReport() {
    adminMetrics.totalReports += 1;
    getDailyMetrics().reports += 1;
    saveAdminMetrics();
}

function getPeriodMetrics(range) {
    if (range === "all") {
        return {
            range: "all",
            totalConnections: adminMetrics.totalConnections,
            totalReports: adminMetrics.totalReports
        };
    }

    const days = range === "month" ? 30 : 7;
    const firstDay = new Date();
    firstDay.setUTCHours(0, 0, 0, 0);
    firstDay.setUTCDate(firstDay.getUTCDate() - days + 1);
    const startDate = firstDay.toISOString().slice(0, 10);
    const totals = Object.entries(adminMetrics.daily).reduce((result, [date, counts]) => {
        if (date >= startDate) {
            result.totalConnections += Number(counts.connections) || 0;
            result.totalReports += Number(counts.reports) || 0;
        }
        return result;
    }, { totalConnections: 0, totalReports: 0 });

    return { range, ...totals };
}

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/feedback", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "feedback.html"));
});

app.get("/contact", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "contact.html"));
});

const FEEDBACK_STORE_FILE = path.join(__dirname, "data", "feedback.json");
const DEFAULT_GOOGLE_SHEETS_FEEDBACK_URL = "https://script.google.com/macros/s/REPLACE_WITH_YOUR_DEPLOYMENT_ID/exec";
const GOOGLE_SHEETS_FEEDBACK_URL = process.env.GOOGLE_SHEETS_FEEDBACK_URL || process.env.GOOGLESHEETSFEEDBACKURL || DEFAULT_GOOGLE_SHEETS_FEEDBACK_URL;
const GOOGLE_SHEETS_FEEDBACK_TOKEN = process.env.GOOGLE_SHEETS_FEEDBACK_TOKEN || process.env.GOOGLESHEETSFEEDBACKTOKEN || "";

function readFeedbackQueue() {
    try {
        const stored = JSON.parse(fs.readFileSync(FEEDBACK_STORE_FILE, "utf8"));
        return Array.isArray(stored) ? stored : [];
    } catch (error) {
        if (error.code !== "ENOENT") console.error("Could not read feedback queue:", error.message);
        return [];
    }
}

function writeFeedbackQueue(entries) {
    try {
        fs.mkdirSync(path.dirname(FEEDBACK_STORE_FILE), { recursive: true });
        fs.writeFileSync(FEEDBACK_STORE_FILE, JSON.stringify(entries, null, 2), { mode: 0o600 });
        return true;
    } catch (error) {
        console.error("Could not save feedback queue:", error.message);
        return false;
    }
}

function sanitizeFeedbackPayload(data) {
    if (!data || typeof data !== "object") {
        return null;
    }

    const name = String(data.name || "").trim().replace(/[<>]/g, "").slice(0, 80);
    const email = String(data.email || "").trim().replace(/[<>]/g, "").slice(0, 160);
    const type = ["bug", "idea", "question", "other"].includes(data.type) ? data.type : "other";
    const ratingValue = Number(data.rating ?? data.score ?? 5);
    const rating = Number.isInteger(ratingValue) && ratingValue >= 1 && ratingValue <= 5 ? ratingValue : null;
    const message = String(data.message || "").trim().slice(0, 2000);
    const consent = Boolean(data.consent);
    const submittedAt = new Date(data.submittedAt || Date.now()).toISOString();
    const submittedAtReadable = new Date(submittedAt).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true
    });

    if (!message || message.length < 10 || rating === null) {
        return null;
    }

    return {
        name: name || "Anonymous",
        email: email || "",
        type,
        rating,
        message,
        consent,
        createdAt: submittedAt,
        submittedAt,
        submittedAtReadable
    };
}

function createFeedbackEntry(data) {
    return {
        id: crypto.randomBytes(12).toString("hex"),
        ...data,
        syncedToGoogleSheets: false
    };
}

async function syncFeedbackToGoogleSheets(entry) {
    if (!GOOGLE_SHEETS_FEEDBACK_URL || GOOGLE_SHEETS_FEEDBACK_URL.includes("REPLACE_WITH") || !GOOGLE_SHEETS_FEEDBACK_TOKEN) {
        return false;
    }

    try {
        const response = await fetch(GOOGLE_SHEETS_FEEDBACK_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json"
            },
            body: JSON.stringify({
                token: GOOGLE_SHEETS_FEEDBACK_TOKEN,
                feedback: entry
            })
        });

        const responseText = await response.text();
        let parsedBody = {};

        try {
            parsedBody = JSON.parse(responseText);
        } catch (error) {
            parsedBody = {};
        }

        if (!response.ok || parsedBody.success !== true) {
            console.warn("Google Sheets feedback sync rejected:", parsedBody.message || responseText || response.statusText);
            return false;
        }

        return true;
    } catch (error) {
        console.error("Could not sync feedback to Google Sheets:", error.message);
        return false;
    }
}

// Retry feedback left in the local queue after a previous Sheets outage.
async function syncSavedFeedbackEntries() {
    const pendingEntries = readFeedbackQueue();
    if (!pendingEntries.length) {
        return { synced: 0, pending: 0 };
    }

    const remainingEntries = [];
    let syncedCount = 0;

    for (const entry of pendingEntries) {
        const success = await syncFeedbackToGoogleSheets(entry);
        if (success) {
            syncedCount += 1;
        } else {
            remainingEntries.push(entry);
        }
    }

    if (remainingEntries.length !== pendingEntries.length) {
        writeFeedbackQueue(remainingEntries);
    }

    return {
        synced: syncedCount,
        pending: remainingEntries.length
    };
}

app.post("/api/feedback", async (req, res) => {
    const sanitized = sanitizeFeedbackPayload(req.body);
    if (!sanitized) {
        res.status(400).json({
            ok: false,
            message: "Please enter a meaningful message before submitting your feedback."
        });
        return;
    }

    const entry = createFeedbackEntry(sanitized);
    const queuedEntries = readFeedbackQueue();
    queuedEntries.push(entry);
    writeFeedbackQueue(queuedEntries);

    let sheetSyncWorked = false;
    if (GOOGLE_SHEETS_FEEDBACK_URL && !GOOGLE_SHEETS_FEEDBACK_URL.includes("REPLACE_WITH") && GOOGLE_SHEETS_FEEDBACK_TOKEN) {
        sheetSyncWorked = await syncFeedbackToGoogleSheets(entry);
        if (sheetSyncWorked) {
            const remainingEntries = readFeedbackQueue().filter((queuedEntry) => queuedEntry.id !== entry.id);
            writeFeedbackQueue(remainingEntries);
        }
    }

    const isSavedLocally = !sheetSyncWorked;

    res.status(200).json({
        ok: true,
        savedLocally: isSavedLocally,
        sheetSync: sheetSyncWorked,
        message: sheetSyncWorked
            ? "Thanks! Your feedback has been sent to the team."
            : "Your feedback was saved locally and will retry automatically when Google Sheets is available."
    });
});

function hashSecret(value) {
    return crypto.createHash("sha256").update(value).digest();
}

function secretsMatch(provided, expected) {
    return crypto.timingSafeEqual(hashSecret(provided), hashSecret(expected));
}

function getAdminSessionToken(req) {
    const cookies = (req.headers.cookie || "").split(";");
    const sessionCookie = cookies.find((cookie) =>
        cookie.trim().startsWith(`${ADMIN_SESSION_COOKIE}=`)
    );

    return sessionCookie
        ? sessionCookie.trim().slice(ADMIN_SESSION_COOKIE.length + 1)
        : null;
}

function requireAdmin(req, res, next) {
    const token = getAdminSessionToken(req);
    const expiresAt = token && adminSessions.get(token);

    if (!expiresAt || expiresAt <= Date.now()) {
        if (token) adminSessions.delete(token);
        res.status(401).json({ error: "Admin authentication required." });
        return;
    }

    next();
}

app.post("/api/admin/login", (req, res) => {
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword || adminPassword.length < 16) {
        res.status(503).json({ error: "Admin access is not configured securely." });
        return;
    }

    const clientIp = req.ip;
    const now = Date.now();
    const attempts = adminLoginAttempts.get(clientIp);
    if (attempts && attempts.resetAt > now && attempts.count >= ADMIN_MAX_LOGIN_ATTEMPTS) {
        res.status(429).json({ error: "Too many attempts. Try again later." });
        return;
    }

    const password = req.body && typeof req.body.password === "string"
        ? req.body.password.slice(0, 256)
        : "";

    if (!password || !secretsMatch(password, adminPassword)) {
        const nextAttempts = attempts && attempts.resetAt > now
            ? { count: attempts.count + 1, resetAt: attempts.resetAt }
            : { count: 1, resetAt: now + ADMIN_LOGIN_WINDOW };
        adminLoginAttempts.set(clientIp, nextAttempts);
        res.status(nextAttempts.count >= ADMIN_MAX_LOGIN_ATTEMPTS ? 429 : 401)
            .json({ error: "Invalid admin password." });
        return;
    }

    adminLoginAttempts.delete(clientIp);
    const token = crypto.randomBytes(32).toString("hex");
    adminSessions.set(token, now + ADMIN_SESSION_TTL);
    res.cookie(ADMIN_SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        maxAge: ADMIN_SESSION_TTL,
        path: "/api/admin"
    });
    res.json({ success: true });
});

app.get("/api/admin/session", (req, res) => {
    const token = getAdminSessionToken(req);
    const expiresAt = token && adminSessions.get(token);
    const authenticated = Boolean(expiresAt && expiresAt > Date.now());

    if (token && !authenticated) adminSessions.delete(token);
    res.set("Cache-Control", "no-store");
    res.json({ authenticated });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
    const token = getAdminSessionToken(req);
    if (token) adminSessions.delete(token);
    res.clearCookie(ADMIN_SESSION_COOKIE, {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        path: "/api/admin"
    });
    res.json({ success: true });
});

app.get("/api/admin/stats", requireAdmin, (req, res) => {
    res.set("Cache-Control", "no-store");
    const requestedRange = ["all", "month", "week"].includes(req.query.range)
        ? req.query.range
        : "all";
    res.json({
        liveUsers: io.sockets.sockets.size,
        ...getPeriodMetrics(requestedRange),
        serverStartedAt,
        serverUptimeSeconds: Math.floor((Date.now() - serverStartedAt) / 1000)
    });
});

// ================================================
// MATCHING SYSTEM
// ================================================

let waitingQueue = [];
const activePartners = new Map();
const activeRooms = new Map();

function getRoomId(socketA, socketB) {
    return [socketA.id, socketB.id].sort().join("-");
}

function removeFromQueue(socketId) {
    waitingQueue = waitingQueue.filter((entry) => entry.socketId !== socketId);
}

function leaveChat(socket, reason = "left") {
    removeFromQueue(socket.id);

    const partnerId = activePartners.get(socket.id);
    const roomId = activeRooms.get(socket.id);

    activePartners.delete(socket.id);
    activeRooms.delete(socket.id);
    if (roomId) socket.leave(roomId);

    if (!partnerId) return;

    activePartners.delete(partnerId);
    activeRooms.delete(partnerId);

    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) {
        if (roomId) partnerSocket.leave(roomId);
        partnerSocket.emit("partner-left", { reason });
    }
}

function matchUsers(socketA, socketB, matchOptions) {
    const roomId = getRoomId(socketA, socketB);
    const sharedInterests = (socketA.data.matchOptions.interests || []).filter((interest) =>
        socketB.data.matchOptions.interests.includes(interest)
    );

    socketA.join(roomId);
    socketB.join(roomId);
    activePartners.set(socketA.id, socketB.id);
    activePartners.set(socketB.id, socketA.id);
    activeRooms.set(socketA.id, roomId);
    activeRooms.set(socketB.id, roomId);

    socketA.emit("matched", {
        partnerId: socketB.id,
        partnerName: socketB.data.matchOptions.name,
        roomId: roomId,
        mode: matchOptions.mode,
        sharedInterests
    });

    socketB.emit("matched", {
        partnerId: socketA.id,
        partnerName: socketA.data.matchOptions.name,
        roomId: roomId,
        mode: matchOptions.mode,
        sharedInterests
    });

    console.log(`Matched ${socketA.id} with ${socketB.id}`);
}

function findPartnerFor(socket) {
    if (!socket.connected) {
        return;
    }

    removeFromQueue(socket.id);

    const matchOptions = socket.data.matchOptions || {
        mode: "video",
        interests: []
    };
    let partnerIndex = -1;
    let fallbackPartnerIndex = -1;

    // Prefer users with overlapping interests, then match users who did not set interests.
    for (let index = 0; index < waitingQueue.length; index += 1) {
        const candidate = waitingQueue[index];
        const candidateSocket = io.sockets.sockets.get(candidate.socketId);

        if (!candidateSocket || !candidateSocket.connected) {
            waitingQueue.splice(index, 1);
            index -= 1;
            continue;
        }

        const sameMode = candidate.matchOptions.mode === matchOptions.mode;
        const bothHaveInterests = candidate.matchOptions.interests.length > 0 &&
            matchOptions.interests.length > 0;
        const interestsOverlap = candidate.matchOptions.interests.some((interest) =>
            matchOptions.interests.includes(interest)
        );

        if (sameMode && bothHaveInterests && interestsOverlap) {
            partnerIndex = index;
            break;
        }

        if (sameMode && !bothHaveInterests && fallbackPartnerIndex === -1) {
            fallbackPartnerIndex = index;
        }
    }

    if (partnerIndex === -1) partnerIndex = fallbackPartnerIndex;

    if (partnerIndex === -1) {
        waitingQueue.push({ socketId: socket.id, matchOptions });
        socket.emit("waiting");
        console.log(`User added to waiting queue: ${socket.id}`);
        return;
    }

    const [queuedPartner] = waitingQueue.splice(partnerIndex, 1);
    const partnerId = queuedPartner.socketId;
    const partnerSocket = io.sockets.sockets.get(partnerId);

    if (!partnerSocket || !partnerSocket.connected) {
        findPartnerFor(socket);
        return;
    }

    matchUsers(socket, partnerSocket, matchOptions);
}

function normalizeMatchOptions(data) {
    const mode = data && data.mode === "text" ? "text" : "video";
    const interests = Array.isArray(data && data.interests)
        ? [...new Set(data.interests.slice(0, 8)
            .map((interest) => String(interest).trim().toLowerCase().slice(0, 30))
            .filter(Boolean))]
        : [];
    const name = String(data && data.name || "").trim().replace(/[<>]/g, "").slice(0, 24);

    return { mode, interests, name };
}

// ================================================
// SOCKET.IO
// ================================================

io.on("connection", (socket) => {
    recordConnection();
    console.log("User connected:", socket.id);

    socket.on("find-stranger", (data) => {
        console.log("Looking for stranger:", socket.id);

        if (waitingQueue.some((entry) => entry.socketId === socket.id) || activePartners.has(socket.id)) {
            return;
        }

        socket.data.matchOptions = normalizeMatchOptions(data);
        findPartnerFor(socket);
    });

    socket.on("send-message", (data) => {
        if (!data) return;

        const roomId = activeRooms.get(socket.id);
        const { message } = data;

        if (!roomId || !message) return;

        const cleanMessage = String(message).trim();

        if (!cleanMessage || cleanMessage.length > 1000) return;

        socket.to(roomId).emit("receive-message", {
            message: cleanMessage
        });
    });

    socket.on("typing", (isTyping) => {
        if (typeof isTyping !== "boolean") return;

        const partnerId = activePartners.get(socket.id);
        if (!partnerId) return;

        io.to(partnerId).emit("partner-typing", { isTyping });
    });

    socket.on("webrtc-offer", (data) => {
        if (!data) return;

        const { partnerId, offer } = data;
        if (!partnerId || !offer || socket.data.matchOptions.mode !== "video" ||
            activePartners.get(socket.id) !== partnerId) return;

        io.to(partnerId).emit("webrtc-offer", {
            partnerId: socket.id,
            offer: offer
        });
    });

    socket.on("webrtc-answer", (data) => {
        if (!data) return;

        const { partnerId, answer } = data;
        if (!partnerId || !answer || socket.data.matchOptions.mode !== "video" ||
            activePartners.get(socket.id) !== partnerId) return;

        io.to(partnerId).emit("webrtc-answer", {
            partnerId: socket.id,
            answer: answer
        });
    });

    socket.on("webrtc-ice-candidate", (data) => {
        if (!data) return;

        const { partnerId, candidate } = data;
        if (!partnerId || !candidate || socket.data.matchOptions.mode !== "video" ||
            activePartners.get(socket.id) !== partnerId) return;

        io.to(partnerId).emit("webrtc-ice-candidate", {
            partnerId: socket.id,
            candidate: candidate
        });
    });

    socket.on("next-stranger", () => {
        console.log("User requested next stranger:", socket.id);

        leaveChat(socket, "next");
        findPartnerFor(socket);
    });

    socket.on("leave-chat", (acknowledge) => {
        leaveChat(socket, "left");
        if (typeof acknowledge === "function") acknowledge({ success: true });
    });

    socket.on("report-stranger", (acknowledge) => {
        const partnerId = activePartners.get(socket.id);
        if (!partnerId) {
            if (typeof acknowledge === "function") acknowledge({ success: false });
            return;
        }

        recordReport();
        console.log(`Report submitted: ${socket.id} reported ${partnerId}`);
        leaveChat(socket, "reported");
        if (typeof acknowledge === "function") acknowledge({ success: true });
    });

    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);

        leaveChat(socket, "disconnected");
    });
});

server.listen(PORT, () => {
    console.log("");
    console.log("====================================");
    console.log("        OMETALK SERVER STARTED");
    console.log("====================================");
    console.log("");
    console.log(`Website: http://localhost:${PORT}`);
    console.log("");

    syncSavedFeedbackEntries()
        .then(({ synced, pending }) => {
            if (synced) console.log(`Synced ${synced} queued feedback entries.`);
            if (pending) console.warn(`${pending} feedback entries remain queued.`);
        })
        .catch((error) => console.error("Could not retry queued feedback:", error.message));
});
