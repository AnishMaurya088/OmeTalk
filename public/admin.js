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

let refreshTimer = null;

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
        refreshTimer = window.setInterval(loadStats, 10000);
    } catch (error) {
        loginStatus.textContent = "Could not reach the admin service.";
    } finally {
        loginButton.disabled = false;
    }
});

refreshButton.addEventListener("click", loadStats);
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
        refreshTimer = window.setInterval(loadStats, 10000);
    })
    .catch(() => {});