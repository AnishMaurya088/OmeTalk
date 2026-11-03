const loginView = document.getElementById("loginView");
const dashboardView = document.getElementById("dashboardView");
const loginForm = document.getElementById("loginForm");
const adminPassword = document.getElementById("adminPassword");
const loginButton = document.getElementById("loginButton");
const loginStatus = document.getElementById("loginStatus");
const serviceState = document.getElementById("serviceState");
const updatedAt = document.getElementById("updatedAt");
const refreshButton = document.getElementById("refreshButton");
const logoutButton = document.getElementById("logoutButton");
const rangeFilter = document.getElementById("rangeFilter");
const couponCreateForm = document.getElementById("couponCreateForm");
const couponAdminStatus = document.getElementById("couponAdminStatus");
const couponTableBody = document.getElementById("couponTableBody");
const premiumMembersBody = document.getElementById("premiumMembersBody");
const paymentRequestsBody = document.getElementById("paymentRequestsBody");
const paymentRequestsSummary = document.getElementById("paymentRequestsSummary");
const deletionRequestsBody = document.getElementById("deletionRequestsBody");
const qrUploadForm = document.getElementById("qrUploadForm");
const qrAdminStatus = document.getElementById("qrAdminStatus");
const removeQrButton = document.getElementById("removeQrButton");
const reportsBody = document.getElementById("reportsBody");
const reportsStatus = document.getElementById("reportsStatus");
const reportDetail = document.getElementById("reportDetail");
const reportTranscript = document.getElementById("reportTranscript");
const reportAuditLog = document.getElementById("reportAuditLog");
const reportReviewStatus = document.getElementById("reportReviewStatus");
let selectedReportId = null;
let selectedReportSource = null;

let refreshTimer = null;

async function refreshDashboard() {
    await Promise.all([loadStats(), loadPremiumAdmin(), loadReports()]);
}

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginButton.disabled = true;
    loginStatus.textContent = "Checking credentials...";

    try {
        const response = await fetch("/api/admin/login", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: adminPassword.value })
        });

        const result = await response.json();

        if (!response.ok) {
            loginStatus.textContent = result.error || "Sign in failed.";
            return;
        }

        adminPassword.value = "";
        loginView.hidden = true;
        dashboardView.hidden = false;
        serviceState.textContent = "Authenticated";
        await loadStats();
        await loadPremiumAdmin();
        await loadReports();
        refreshTimer = window.setInterval(refreshDashboard, 30000);
    } catch (error) {
        loginStatus.textContent = "Could not reach the admin service.";
    } finally {
        loginButton.disabled = false;
    }
});

refreshButton.addEventListener("click", refreshDashboard);
document.getElementById("refreshReportsButton").addEventListener("click", loadReports);
document.getElementById("closeReportDetailButton").addEventListener("click", () => {
    reportDetail.hidden = true;
    selectedReportId = null;
    selectedReportSource = null;
});
document.getElementById("resolveReportButton").addEventListener("click", async () => {
    if (!selectedReportId) return;
    const button = document.getElementById("resolveReportButton");
    button.disabled = true;
    reportReviewStatus.textContent = "Saving review…";
    try {
        const reportsPath = selectedReportSource === "premium"
            ? "/api/admin/premium/reports"
            : "/api/admin/reports";
        await adminApi(`${reportsPath}/${encodeURIComponent(selectedReportId)}`, {
            method: "PATCH",
            body: JSON.stringify({
                status: "resolved",
                note: document.getElementById("reportReviewNote").value
            })
        });
        reportReviewStatus.textContent = "Report marked resolved.";
        await loadReports();
    } catch (error) {
        reportReviewStatus.textContent = error.message;
    } finally {
        button.disabled = false;
    }
});
reportsBody.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-report-id]");
    if (!button) return;
    const reason = window.prompt("Why do you need to access this reported conversation? This reason will be recorded in the audit log.");
    if (reason === null) return;
    if (reason.trim().length < 10) {
        reportsStatus.textContent = "Enter at least 10 characters for the access reason.";
        return;
    }
    reportsStatus.textContent = "Opening reported conversation…";
    try {
        const result = await adminApi(
            `${button.dataset.reportSource === "premium" ? "/api/admin/premium/reports" : "/api/admin/reports"}/${encodeURIComponent(button.dataset.reportId)}?reason=${encodeURIComponent(reason.trim())}`
        );
        selectedReportId = result.report.id;
        selectedReportSource = button.dataset.reportSource;
        const title = document.getElementById("reportDetailTitle");
        const meta = document.getElementById("reportDetailMeta");
        title.textContent = `Reported chat · ${result.report.category}`;
        meta.textContent = `Reported ${new Date(result.report.createdAt).toLocaleString()} · ${result.report.reporterName || "Anonymous"} reported ${result.report.reportedName || "Anonymous"} · ${(result.report.accessLog || []).length} audited access event(s)`;
        reportTranscript.replaceChildren();
        if (!result.report.transcript.length) {
            const empty = document.createElement("li");
            empty.textContent = "No text messages were captured in this conversation.";
            reportTranscript.appendChild(empty);
        } else {
            result.report.transcript.forEach((entry) => {
                const item = document.createElement("li");
                const time = document.createElement("time");
                const sentAt = entry.sentAt || entry.createdAt;
                time.dateTime = sentAt;
                time.textContent = `${entry.senderName || "Anonymous"} · ${new Date(sentAt).toLocaleString()}`;
                const text = document.createElement("span");
                text.textContent = entry.message || entry.body || "";
                item.append(time, text);
                if (entry.mediaType) {
                    const media = document.createElement("span");
                    media.textContent = ` [reported attachment: ${entry.mediaType}]`;
                    item.appendChild(media);
                }
                reportTranscript.appendChild(item);
            });
        }
        reportAuditLog.replaceChildren();
        const auditEntries = [
            ...(result.report.accessLog || []).map((entry) => ({
                at: entry.accessedAt,
                action: "Transcript opened",
                detail: entry.reason
            })),
            ...(result.report.auditLog || []).map((entry) => ({
                at: entry.at,
                action: entry.action,
                detail: entry.note
            }))
        ].sort((left, right) => new Date(left.at) - new Date(right.at));
        if (!auditEntries.length) {
            const item = document.createElement("li");
            item.textContent = "No audit events recorded.";
            reportAuditLog.appendChild(item);
        } else {
            auditEntries.forEach((entry) => {
                const item = document.createElement("li");
                item.textContent = `${new Date(entry.at).toLocaleString()} · ${entry.action}${entry.detail ? ` · ${entry.detail}` : ""}`;
                reportAuditLog.appendChild(item);
            });
        }
        document.getElementById("reportReviewNote").value = result.report.reviewNote || "";
        document.getElementById("resolveReportButton").hidden = result.report.status === "resolved";
        reportReviewStatus.textContent = "";
        reportDetail.hidden = false;
        reportDetail.scrollIntoView({ behavior: "smooth", block: "start" });
        reportsStatus.textContent = "Transcript access recorded.";
    } catch (error) {
        reportsStatus.textContent = error.message;
    }
});
rangeFilter.addEventListener("change", loadStats);

logoutButton.addEventListener("click", async () => {
    window.clearInterval(refreshTimer);
    await fetch("/api/admin/logout", {
        method: "POST",
        credentials: "same-origin"
    });
    dashboardView.hidden = true;
    loginView.hidden = false;
    loginStatus.textContent = "You have signed out.";
    serviceState.textContent = "Private dashboard";
    couponTableBody.replaceChildren();
    premiumMembersBody.replaceChildren();
    paymentRequestsBody.replaceChildren();
    paymentRequestsSummary.textContent = "Payment request summary will appear here.";
    deletionRequestsBody.replaceChildren();
    reportsBody.replaceChildren();
    reportDetail.hidden = true;
    selectedReportId = null;
    selectedReportSource = null;
    selectedReportSource = null;
});

async function loadStats() {
    refreshButton.disabled = true;

    try {
        const response = await fetch(`/api/admin/stats?range=${encodeURIComponent(rangeFilter.value)}`, {
            credentials: "same-origin",
            cache: "no-store"
        });

        if (response.status === 401) {
            window.clearInterval(refreshTimer);
            dashboardView.hidden = true;
            loginView.hidden = false;
            serviceState.textContent = "Sign in required";
            loginStatus.textContent = "Your admin session expired. Sign in again.";
            return;
        }

        if (!response.ok) throw new Error("Stats request failed");

        const stats = await response.json();
        document.getElementById("liveUsers").textContent = stats.liveUsers.toLocaleString();
        document.getElementById("totalConnections").textContent = stats.totalConnections.toLocaleString();
        document.getElementById("totalReports").textContent = stats.totalReports.toLocaleString();
        const rangeLabel = rangeFilter.options[rangeFilter.selectedIndex].text;
        document.getElementById("connectionRangeLabel").textContent = rangeLabel;
        document.getElementById("reportRangeLabel").textContent = rangeLabel;
        document.getElementById("serverUptime").textContent = formatUptime(stats.serverUptimeSeconds);
        updatedAt.textContent = `Updated ${new Date().toLocaleTimeString()}`;
        serviceState.textContent = "Authenticated · Live";
    } catch (error) {
        serviceState.textContent = "Service unavailable";
        updatedAt.textContent = "Could not refresh statistics.";
    } finally {
        refreshButton.disabled = false;
    }
}

couponCreateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const expiryValue = document.getElementById("couponExpiryInput").value;
    const button = couponCreateForm.querySelector("button[type='submit']");
    button.disabled = true;
    couponAdminStatus.textContent = "Creating coupon…";
    try {
        const result = await adminApi("/api/admin/premium/coupons", {
            method: "POST",
            body: JSON.stringify({
                code: document.getElementById("couponCodeInput").value.trim(),
                discountPercent: Number(document.getElementById("couponDiscountInput").value),
                maxRedemptions: Number(document.getElementById("couponUsesInput").value),
                expiresAt: expiryValue ? new Date(expiryValue).toISOString() : null
            })
        });
        couponAdminStatus.textContent = `Created ${result.code}.`;
        couponCreateForm.reset();
        document.getElementById("couponDiscountInput").value = "10";
        document.getElementById("couponUsesInput").value = "100";
        await loadCoupons();
    } catch (error) {
        couponAdminStatus.textContent = error.message;
    } finally {
        button.disabled = false;
    }
});

qrUploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = qrUploadForm.querySelector("button[type='submit']");
    button.disabled = true;
    qrAdminStatus.textContent = "Uploading QR…";
    try {
        const body = new FormData();
        body.set("qr", document.getElementById("qrImageInput").files[0]);
        await adminApi("/api/admin/premium/payment-qr", { method: "POST", body });
        qrUploadForm.reset();
        qrAdminStatus.textContent = "Payment QR uploaded.";
    } catch (error) {
        qrAdminStatus.textContent = error.message;
    } finally {
        button.disabled = false;
    }
});

removeQrButton.addEventListener("click", async () => {
    if (!window.confirm("Remove the payment QR? Users will not be able to submit payments until another QR is uploaded.")) return;
    try {
        await adminApi("/api/admin/premium/payment-qr", { method: "DELETE" });
        qrAdminStatus.textContent = "Payment QR removed.";
    } catch (error) {
        qrAdminStatus.textContent = error.message;
    }
});

paymentRequestsBody.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const requestId = button.dataset.requestId;
    try {
        if (button.dataset.action === "approve") {
            const row = button.closest("tr");
            const planId = row.querySelector("[data-field='plan']").value;
            const verifiedAmountInr = Number(row.querySelector("[data-field='amount']").value);
            if (!window.confirm("Confirm that you checked this UTR and payment screenshot?")) return;
            await adminApi(`/api/admin/premium/payment-requests/${encodeURIComponent(requestId)}/approve`, {
                method: "POST",
                body: JSON.stringify({ planId, verifiedAmountInr })
            });
        } else if (button.dataset.action === "reject") {
            const note = window.prompt("Optional reason for rejecting this payment:", "") || "";
            await adminApi(`/api/admin/premium/payment-requests/${encodeURIComponent(requestId)}/reject`, {
                method: "POST",
                body: JSON.stringify({ note })
            });
        }
        await loadPremiumAdmin();
    } catch (error) {
        window.alert(error.message);
    }
});

deletionRequestsBody.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action='delete-account']");
    if (!button) return;
    if (!window.confirm(`Permanently delete ${button.dataset.username}'s account, friends, messages, and payment history? This cannot be undone.`)) return;
    try {
        await adminApi(`/api/admin/premium/deletion-requests/${encodeURIComponent(button.dataset.requestId)}`, {
            method: "DELETE"
        });
        await loadPremiumAdmin();
    } catch (error) {
        window.alert(error.message);
    }
});

premiumMembersBody.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const userId = button.dataset.userId;
    try {
        if (button.dataset.action === "grant") {
            const days = window.prompt("How many Premium days should be granted?", "30");
            if (days === null) return;
            await adminApi(`/api/admin/premium/members/${encodeURIComponent(userId)}/grant`, {
                method: "POST",
                body: JSON.stringify({ days: Number(days) })
            });
        } else if (button.dataset.action === "revoke" &&
            window.confirm("Revoke this user's Premium access?")) {
            await adminApi(`/api/admin/premium/members/${encodeURIComponent(userId)}/revoke`, {
                method: "POST"
            });
        } else if (button.dataset.action === "lock" &&
            window.confirm("Lock this user's Premium access now?")) {
            await adminApi(`/api/admin/premium/members/${encodeURIComponent(userId)}/lock`, {
                method: "POST",
                body: JSON.stringify({ reason: "Locked by admin" })
            });
        } else if (button.dataset.action === "unlock") {
            await adminApi(`/api/admin/premium/members/${encodeURIComponent(userId)}/unlock`, {
                method: "POST"
            });
        }
        await loadPremiumAdmin();
    } catch (error) {
        window.alert(error.message);
    }
});

async function adminApi(url, options = {}) {
    const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
    const response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        ...options,
        headers: {
            ...(options.body && !isFormData ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {})
        }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Admin request failed.");
    return result;
}

async function loadPremiumAdmin() {
    await Promise.all([
        loadCoupons(),
        loadMembers(),
        loadPaymentRequests(),
        loadDeletionRequests(),
        loadQrStatus()
    ]);
}

async function loadReports() {
    try {
        const [anonymousResult, premiumResult] = await Promise.allSettled([
            adminApi("/api/admin/reports"),
            adminApi("/api/admin/premium/reports")
        ]);
        if (anonymousResult.status === "rejected" && premiumResult.status === "rejected") {
            throw new Error(`${anonymousResult.reason.message} ${premiumResult.reason.message}`);
        }
        const anonymousReports = anonymousResult.status === "fulfilled"
            ? anonymousResult.value.reports.map((report) => ({ ...report, source: "free" }))
            : [];
        const premiumReports = premiumResult.status === "fulfilled"
            ? premiumResult.value.reports.map((report) => ({ ...report, source: "premium" }))
            : [];
        const reports = [...anonymousReports, ...premiumReports]
            .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
        reportsBody.replaceChildren();
        const pending = reports.filter((report) => report.status === "pending").length;
        reportsStatus.textContent = `${pending} pending · ${reports.length} reports retained` +
            (premiumResult.status === "rejected" ? " · Premium report storage unavailable until PostgreSQL is configured." : "");
        if (!reports.length) {
            addTableMessage(reportsBody, 7, "No reported conversations are available.");
            return;
        }
        reports.forEach((report) => {
            const row = document.createElement("tr");
            appendCell(row, `${report.category} · ${report.source}`);
            appendCell(row, report.reportedName);
            appendCell(row, report.reporterName);
            appendCell(row, new Date(report.createdAt).toLocaleString());
            appendCell(row, String(report.messageCount));
            appendCell(row, report.status);
            const actionCell = document.createElement("td");
            const button = document.createElement("button");
            button.type = "button";
            button.className = "table-action";
            button.dataset.reportId = report.id;
            button.dataset.reportSource = report.source;
            button.textContent = "Review";
            actionCell.appendChild(button);
            row.appendChild(actionCell);
            reportsBody.appendChild(row);
        });
    } catch (error) {
        reportsStatus.textContent = error.message;
        addTableMessage(reportsBody, 7, error.message);
    }
}

async function loadQrStatus() {
    try {
        const result = await adminApi("/api/admin/premium/payment-qr");
        qrAdminStatus.textContent = result.configured
            ? `QR configured${result.updatedAt ? ` · updated ${new Date(result.updatedAt).toLocaleString()}` : ""}.`
            : "No payment QR uploaded yet.";
    } catch (error) {
        qrAdminStatus.textContent = error.message;
    }
}

async function loadCoupons() {
    try {
        const { coupons } = await adminApi("/api/admin/premium/coupons");
        couponTableBody.replaceChildren();
        if (!coupons.length) {
            addTableMessage(couponTableBody, 4, "No coupons created yet.");
            return;
        }
        coupons.forEach((coupon) => {
            const row = document.createElement("tr");
            appendCell(row, coupon.code);
            appendCell(row, `${coupon.discountPercent}%`);
            appendCell(row, `${coupon.redemptionCount} / ${coupon.maxRedemptions}`);
            appendCell(row, coupon.expiresAt ? new Date(coupon.expiresAt).toLocaleString() : "No expiry");
            couponTableBody.appendChild(row);
        });
    } catch (error) {
        addTableMessage(couponTableBody, 4, error.message);
    }
}

async function loadPaymentRequests() {
    try {
        const { requests } = await adminApi("/api/admin/premium/payment-requests");
        paymentRequestsBody.replaceChildren();
        const pendingCount = requests.filter((request) => request.status === "pending").length;
        paymentRequestsSummary.textContent = `${pendingCount} pending · requests do not expire · ${requests.length} total shown`;
        if (!requests.length) {
            addTableMessage(paymentRequestsBody, 8, "No manual payment requests yet.");
            return;
        }
        requests.forEach((request) => {
            const row = document.createElement("tr");
            appendCell(row, `${request.username}\n${request.email}`);
            appendCell(row, planLabel(request.requestedPlan));
            const amount = request.discountPercent
                ? `₹${request.requestedAmountInr} · ${request.couponCode || "coupon"} (${request.discountPercent}% off)`
                : `₹${request.requestedAmountInr}`;
            appendCell(row, amount);
            const proofCell = document.createElement("td");
            proofCell.textContent = `${request.utr} `;
            const proof = document.createElement("a");
            proof.className = "payment-proof-link";
            proof.href = `/api/admin/premium/payment-requests/${encodeURIComponent(request.id)}/proof`;
            proof.target = "_blank";
            proof.rel = "noopener noreferrer";
            proof.textContent = "Screenshot";
            proofCell.appendChild(proof);
            row.appendChild(proofCell);
            appendCell(row, new Date(request.createdAt).toLocaleString());
            const planCell = document.createElement("td");
            const planSelect = document.createElement("select");
            planSelect.className = "payment-review-control payment-plan-control";
            planSelect.dataset.field = "plan";
            for (const plan of [
                { id: "month_1", label: "1 month · ₹299" },
                { id: "month_3", label: "3 months · ₹699" }
            ]) {
                const option = document.createElement("option");
                option.value = plan.id;
                option.textContent = plan.label;
                option.selected = plan.id === request.requestedPlan;
                planSelect.appendChild(option);
            }
            planSelect.disabled = request.status !== "pending";
            planCell.appendChild(planSelect);
            row.appendChild(planCell);
            const amountCell = document.createElement("td");
            const amountInput = document.createElement("input");
            amountInput.className = "payment-review-control";
            amountInput.type = "number";
            amountInput.min = "1";
            amountInput.max = "1000000";
            amountInput.step = "1";
            amountInput.value = String(request.verifiedAmountInr || request.requestedAmountInr);
            amountInput.dataset.field = "amount";
            amountInput.disabled = request.status !== "pending";
            amountCell.appendChild(amountInput);
            row.appendChild(amountCell);
            const actions = document.createElement("td");
            if (request.status === "pending") {
                const approve = createActionButton("approve", request.id, "Verify & activate", "success");
                const reject = createActionButton("reject", request.id, "Reject", "danger");
                actions.append(approve, reject);
            } else {
                actions.textContent = `${request.status}${request.verifiedAmountInr
                    ? ` · ₹${request.verifiedAmountInr} verified` : ""}`;
            }
            row.appendChild(actions);
            paymentRequestsBody.appendChild(row);
        });
    } catch (error) {
        paymentRequestsSummary.textContent = error.message;
        addTableMessage(paymentRequestsBody, 8, error.message);
    }
}

async function loadDeletionRequests() {
    try {
        const { requests } = await adminApi("/api/admin/premium/deletion-requests");
        deletionRequestsBody.replaceChildren();
        if (!requests.length) {
            addTableMessage(deletionRequestsBody, 5, "No pending account deletion requests.");
            return;
        }
        requests.forEach((request) => {
            const row = document.createElement("tr");
            appendCell(row, request.username);
            appendCell(row, request.email);
            appendCell(row, request.reason || "—");
            appendCell(row, new Date(request.requestedAt).toLocaleString());
            const actions = document.createElement("td");
            const remove = createActionButton("delete-account", request.id, "Delete account", "danger");
            remove.dataset.username = request.username;
            actions.appendChild(remove);
            row.appendChild(actions);
            deletionRequestsBody.appendChild(row);
        });
    } catch (error) {
        addTableMessage(deletionRequestsBody, 5, error.message);
    }
}

async function loadMembers() {
    try {
        const { members } = await adminApi("/api/admin/premium/members");
        premiumMembersBody.replaceChildren();
        if (!members.length) {
            addTableMessage(premiumMembersBody, 6, "No Premium accounts registered yet.");
            return;
        }
        members.forEach((member) => {
            const row = document.createElement("tr");
            appendCell(row, member.username);
            appendCell(row, member.email);
            appendCell(row, planLabel(member.premiumPlan));
            const expiry = member.premiumExpiresAt ? new Date(member.premiumExpiresAt) : null;
            appendCell(row, expiry ? expiry.toLocaleString() : "Not active");
            const graceExpiry = expiry ? new Date(expiry.getTime() + 24 * 60 * 60 * 1000) : null;
            const status = member.premiumLockedAt
                ? "Locked"
                : graceExpiry && graceExpiry > new Date()
                    ? expiry > new Date() ? "Active" : "Grace period"
                    : "Expired";
            appendCell(row, status);
            const actions = document.createElement("td");
            const grant = document.createElement("button");
            grant.type = "button";
            grant.className = "table-action";
            grant.dataset.action = "grant";
            grant.dataset.userId = member.id;
            grant.textContent = "Grant";
            actions.appendChild(grant);
            const access = createActionButton(member.premiumLockedAt ? "unlock" : "lock",
                member.id, member.premiumLockedAt ? "Unlock" : "Lock",
                member.premiumLockedAt ? "success" : "danger");
            access.dataset.userId = member.id;
            actions.appendChild(access);
            if (expiry && graceExpiry > new Date()) {
                const revoke = createActionButton("revoke", member.id, "Revoke", "danger");
                revoke.dataset.userId = member.id;
                actions.appendChild(revoke);
            }
            row.appendChild(actions);
            premiumMembersBody.appendChild(row);
        });
    } catch (error) {
        addTableMessage(premiumMembersBody, 6, error.message);
    }
}

function planLabel(planId) {
    if (planId === "month_1") return "1 month";
    if (planId === "month_3") return "3 months";
    return planId === "legacy" ? "Previous plan" : planId || "Not active";
}

function createActionButton(action, id, label, style) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `table-action${style ? ` ${style}` : ""}`;
    button.dataset.action = action;
    button.dataset.requestId = id;
    button.textContent = label;
    return button;
}

function appendCell(row, value) {
    const cell = document.createElement("td");
    cell.textContent = value;
    row.appendChild(cell);
}

function addTableMessage(body, columns, message) {
    body.replaceChildren();
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = columns;
    cell.textContent = message;
    row.appendChild(cell);
    body.appendChild(row);
}

function formatUptime(totalSeconds) {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

fetch("/api/admin/session", { credentials: "same-origin", cache: "no-store" })
    .then((response) => {
        if (!response.ok) throw new Error("Session check failed");
        return response.json();
    })
    .then((session) => {
        if (!session.authenticated) return;
        loginView.hidden = true;
        dashboardView.hidden = false;
        serviceState.textContent = "Authenticated · Live";
        loadStats();
        loadPremiumAdmin();
        loadReports();
        refreshTimer = window.setInterval(refreshDashboard, 30000);
    })
    .catch(() => {});