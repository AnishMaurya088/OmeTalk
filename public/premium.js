const authView = document.getElementById("authView");
const accountView = document.getElementById("accountView");
const authForm = document.getElementById("authForm");
const authTabs = document.getElementById("authTabs");
const forgotPasswordForm = document.getElementById("forgotPasswordForm");
const resetPasswordForm = document.getElementById("resetPasswordForm");
const forgotPasswordButton = document.getElementById("forgotPasswordButton");
const resetEmailInput = document.getElementById("resetEmailInput");
const sendResetLinkButton = document.getElementById("sendResetLinkButton");
const forgotPasswordStatus = document.getElementById("forgotPasswordStatus");
const backToSignInButton = document.getElementById("backToSignInButton");
const newPasswordInput = document.getElementById("newPasswordInput");
const confirmPasswordInput = document.getElementById("confirmPasswordInput");
const resetPasswordButton = document.getElementById("resetPasswordButton");
const resetPasswordStatus = document.getElementById("resetPasswordStatus");
const activePasswordResetToken = new URLSearchParams(window.location.search).get("resetToken");
const loginTab = document.getElementById("loginTab");
const registerTab = document.getElementById("registerTab");
const fullNameInput = document.getElementById("fullNameInput");
const fullNameLabel = document.getElementById("fullNameLabel");
const dateOfBirthInput = document.getElementById("dateOfBirthInput");
const dateOfBirthLabel = document.getElementById("dateOfBirthLabel");
const dateOfBirthHint = document.getElementById("dateOfBirthHint");
const registrationPrivacyHint = document.getElementById("registrationPrivacyHint");
const usernameInput = document.getElementById("usernameInput");
const usernameLabel = document.getElementById("usernameLabel");
const suggestUsernameButton = document.getElementById("suggestUsernameButton");
const usernameHint = document.getElementById("usernameHint");
const emailInput = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");
const passwordHint = document.getElementById("passwordHint");
const authSubmit = document.getElementById("authSubmit");
const authStatus = document.getElementById("authStatus");
const upgradeCard = document.getElementById("upgradeCard");
const premiumApp = document.getElementById("premiumApp");
const paymentRequestForm = document.getElementById("paymentRequestForm");
const couponInput = document.getElementById("couponInput");
const couponStatus = document.getElementById("couponStatus");
const planSelect = document.getElementById("planSelect");
const applyCouponButton = document.getElementById("applyCouponButton");
const paymentAmountHint = document.getElementById("paymentAmountHint");
const paymentRequestButton = document.getElementById("paymentRequestButton");
const paymentRequestStatus = document.getElementById("paymentRequestStatus");
const paymentQrImage = document.getElementById("paymentQrImage");
const paymentQrStatus = document.getElementById("paymentQrStatus");
const paymentHistoryBody = document.getElementById("paymentHistoryBody");
const deletionRequestStatus = document.getElementById("deletionRequestStatus");
const deleteAccountRequestButton = document.getElementById("deleteAccountRequestButton");
const cancelDeletionRequestButton = document.getElementById("cancelDeletionRequestButton");
const friendsList = document.getElementById("friendsList");
const premiumMessages = document.getElementById("premiumMessages");
const premiumMessageForm = document.getElementById("premiumMessageForm");
const premiumMessageInput = document.getElementById("premiumMessageInput");
const currentMessageSendButton = premiumMessageForm.querySelector("button[type='submit']");
const singleViewCheckbox = document.getElementById("singleViewCheckbox");
const mediaFileInput = document.getElementById("mediaFileInput");
const sendMediaButton = document.getElementById("sendMediaButton");
const mediaStatus = document.getElementById("mediaStatus");

let isRegistering = false;
let usernameSuggestionTimer = null;
let usernameSuggestions = [];
let usernameSuggestionsFor = "";
let usernameSuggestionIndex = 0;
let usernameSuggestionRequest = 0;
let usernameTouched = false;
let currentUser = null;
let premiumConfig = null;
let appliedCoupon = null;
let premiumSocket = null;
let activeRecipient = null;
let activeRandomMatch = false;
let peerConnection = null;
let localMedia = null;
let activeCallRecipient = null;
let hasPendingPaymentRequest = false;
let paymentQrAvailable = false;
let expiryTimers = new Map();
let friendsById = new Map();
let pendingCallIceCandidates = [];
let mediaObjectUrls = new Map();

const rtcConfiguration = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
    ]
};

async function api(url, options = {}) {
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
    const result = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw new Error(result.error || "The request could not be completed.");
    return result;
}

function setStatus(element, message, type = "") {
    element.textContent = message;
    element.classList.toggle("error", type === "error");
    element.classList.toggle("success", type === "success");
}

function setAuthMode(registering) {
    isRegistering = registering;
    loginTab.classList.toggle("active", !registering);
    registerTab.classList.toggle("active", registering);
    loginTab.setAttribute("aria-selected", String(!registering));
    registerTab.setAttribute("aria-selected", String(registering));
    fullNameInput.hidden = !registering;
    fullNameLabel.hidden = !registering;
    fullNameInput.required = registering;
    dateOfBirthInput.hidden = !registering;
    dateOfBirthLabel.hidden = !registering;
    dateOfBirthInput.required = registering;
    dateOfBirthHint.hidden = !registering;
    registrationPrivacyHint.hidden = !registering;
    usernameInput.hidden = !registering;
    usernameLabel.hidden = !registering;
    usernameInput.required = registering;
    suggestUsernameButton.hidden = !registering;
    usernameHint.hidden = !registering;
    passwordHint.hidden = !registering;
    passwordInput.autocomplete = registering ? "new-password" : "current-password";
    passwordInput.minLength = registering ? 6 : 1;
    forgotPasswordButton.hidden = registering;
    authSubmit.textContent = registering ? "Create account" : "Sign in";
    if (registering) {
        const latestAdultBirthDate = new Date();
        latestAdultBirthDate.setUTCFullYear(latestAdultBirthDate.getUTCFullYear() - 18);
        dateOfBirthInput.max = latestAdultBirthDate.toISOString().slice(0, 10);
        usernameTouched = false;
        usernameSuggestions = [];
        usernameSuggestionsFor = "";
    }
    setStatus(authStatus, "");
}

async function loadUsernameSuggestions(fullName) {
    const requestId = ++usernameSuggestionRequest;
    const requestedName = fullName.trim();
    if (!requestedName) return;
    setStatus(usernameHint, "Finding available usernames…");
    try {
        const result = await api("/api/premium/username-suggestions", {
            method: "POST",
            body: JSON.stringify({ fullName: requestedName })
        });
        if (requestId !== usernameSuggestionRequest) return;
        usernameSuggestions = result.suggestions;
        usernameSuggestionsFor = requestedName;
        usernameSuggestionIndex = 0;
        if (!usernameSuggestions.length) {
            setStatus(usernameHint, "No suggestions available. Try a different username.", "error");
            return;
        }
        if (!usernameTouched) {
            usernameInput.value = usernameSuggestions[0];
            setStatus(usernameHint, `Available suggestion: ${usernameInput.value}. You can edit it.`);
        } else {
            setStatus(usernameHint, `Found available suggestions. Your chosen username will be checked when you create the account.`);
        }
    } catch (error) {
        if (requestId === usernameSuggestionRequest) {
            setStatus(usernameHint, error.message, "error");
        }
    }
}

fullNameInput.addEventListener("input", () => {
    clearTimeout(usernameSuggestionTimer);
    usernameSuggestionRequest += 1;
    usernameSuggestions = [];
    usernameSuggestionsFor = "";
    if (!fullNameInput.value.trim()) {
        setStatus(usernameHint, "Username must be unique. You can edit the suggestion.");
        return;
    }
    usernameSuggestionTimer = setTimeout(() => loadUsernameSuggestions(fullNameInput.value), 300);
});

usernameInput.addEventListener("input", () => {
    usernameTouched = true;
});

suggestUsernameButton.addEventListener("click", async () => {
    clearTimeout(usernameSuggestionTimer);
    const fullName = fullNameInput.value.trim();
    if (!fullName) {
        setStatus(usernameHint, "Enter your name first to get suggestions.", "error");
        fullNameInput.focus();
        return;
    }
    if (usernameSuggestionsFor !== fullName || !usernameSuggestions.length) {
        await loadUsernameSuggestions(fullName);
        return;
    }
    usernameSuggestionIndex = (usernameSuggestionIndex + 1) % usernameSuggestions.length;
    usernameInput.value = usernameSuggestions[usernameSuggestionIndex];
    usernameTouched = false;
    setStatus(usernameHint, `Available suggestion: ${usernameInput.value}. You can edit it.`);
});

loginTab.addEventListener("click", () => setAuthMode(false));
registerTab.addEventListener("click", () => setAuthMode(true));

forgotPasswordButton.addEventListener("click", () => {
    resetEmailInput.value = emailInput.value.trim();
    authTabs.hidden = true;
    authForm.hidden = true;
    forgotPasswordForm.hidden = false;
    setStatus(forgotPasswordStatus, "");
});

backToSignInButton.addEventListener("click", () => {
    forgotPasswordForm.hidden = true;
    authTabs.hidden = false;
    authForm.hidden = false;
    setAuthMode(false);
});

forgotPasswordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    sendResetLinkButton.disabled = true;
    setStatus(forgotPasswordStatus, "Sending reset link…");
    try {
        const result = await api("/api/premium/forgot-password", {
            method: "POST",
            body: JSON.stringify({ email: resetEmailInput.value })
        });
        setStatus(forgotPasswordStatus, result.message, "success");
    } catch (error) {
        setStatus(forgotPasswordStatus, error.message, "error");
    } finally {
        sendResetLinkButton.disabled = false;
    }
});

resetPasswordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (newPasswordInput.value !== confirmPasswordInput.value) {
        setStatus(resetPasswordStatus, "The passwords do not match.", "error");
        return;
    }
    resetPasswordButton.disabled = true;
    setStatus(resetPasswordStatus, "Updating password…");
    try {
        await api("/api/premium/reset-password", {
            method: "POST",
            body: JSON.stringify({
                token: activePasswordResetToken,
                password: newPasswordInput.value
            })
        });
        window.history.replaceState(null, "", window.location.pathname);
        newPasswordInput.value = "";
        confirmPasswordInput.value = "";
        resetPasswordForm.hidden = true;
        authTabs.hidden = false;
        authForm.hidden = false;
        setAuthMode(false);
        setStatus(authStatus, "Password updated. Sign in with your new password.", "success");
    } catch (error) {
        setStatus(resetPasswordStatus, error.message, "error");
    } finally {
        resetPasswordButton.disabled = false;
    }
});

authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    authSubmit.disabled = true;
    setStatus(authStatus, isRegistering ? "Creating account…" : "Signing in…");
    try {
        await api(isRegistering ? "/api/premium/register" : "/api/premium/login", {
            method: "POST",
            body: JSON.stringify({
                email: emailInput.value,
                fullName: fullNameInput.value,
                dateOfBirth: dateOfBirthInput.value,
                username: usernameInput.value,
                password: passwordInput.value
            })
        });
        passwordInput.value = "";
        fullNameInput.value = "";
        dateOfBirthInput.value = "";
        usernameInput.value = "";
        await loadAccount();
    } catch (error) {
        setStatus(authStatus, error.message, "error");
    } finally {
        authSubmit.disabled = false;
    }
});

document.getElementById("signOutButton").addEventListener("click", signOut);
document.getElementById("premiumLogoutButton").addEventListener("click", signOut);

async function signOut() {
    if (premiumSocket) premiumSocket.disconnect();
    closeCall(false);
    try {
        await api("/api/premium/logout", { method: "POST" });
    } catch (error) {
        console.error("Could not sign out:", error);
    }
    currentUser = null;
    activeRecipient = null;
    document.getElementById("reportConversationButton").hidden = true;
    accountView.hidden = true;
    authView.hidden = false;
    setStatus(authStatus, "You have signed out.", "success");
}

async function loadAccount() {
    try {
        currentUser = await api("/api/premium/me");
    } catch (error) {
        if (error.message.includes("Sign in")) {
            authView.hidden = false;
            accountView.hidden = true;
            return;
        }
        throw error;
    }

    authView.hidden = true;
    accountView.hidden = false;
    const invitationMessage = await acceptPendingInvite();
    document.getElementById("accountUsername").textContent = currentUser.username;
    const active = currentUser.premiumActive;
    const expiresAt = currentUser.premiumExpiresAt ? new Date(currentUser.premiumExpiresAt) : null;
    let membershipMessage = "Your account is ready. Choose a plan to activate Premium.";
    if (currentUser.premiumLocked) {
        membershipMessage = "Your Premium access is locked. Contact admin or submit a renewal payment request.";
    } else if (active && expiresAt && expiresAt <= new Date()) {
        membershipMessage = `Your plan expired. 24-hour grace access ends ${new Date(currentUser.graceExpiresAt).toLocaleString()}.`;
    } else if (active && expiresAt) {
        const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86400000));
        membershipMessage = `Premium active · ${currentUser.premiumPlan || "Premium"} · ${daysLeft} day(s) remaining · expires ${expiresAt.toLocaleString()}.`;
    } else if (expiresAt) {
        membershipMessage = `Your Premium plan expired on ${expiresAt.toLocaleString()}. Renew to unlock Premium again.`;
    }
    document.getElementById("membershipStatus").textContent =
        membershipMessage + (invitationMessage ? ` ${invitationMessage}` : "");
    upgradeCard.hidden = false;
    premiumApp.hidden = !active;
    cancelDeletionRequestButton.hidden = !currentUser.deletionRequest ||
        currentUser.deletionRequest.status !== "pending";
    deleteAccountRequestButton.disabled = cancelDeletionRequestButton.hidden === false;
    setStatus(deletionRequestStatus, currentUser.deletionRequest &&
        currentUser.deletionRequest.status === "pending"
        ? `Deletion requested ${new Date(currentUser.deletionRequest.requestedAt).toLocaleString()}. Admin will review it.`
        : "");
    await loadPremiumConfig();
    await loadPaymentHistory();
    if (active) {
        await loadFriends();
        connectPremiumSocket();
    }
}

async function acceptPendingInvite() {
    const currentUrl = new URL(window.location.href);
    const token = currentUrl.searchParams.get("invite");
    if (!token) return "";
    try {
        const result = await api("/api/premium/invites/accept", {
            method: "POST",
            body: JSON.stringify({ token })
        });
        return `You and ${result.friend.username} are now friends.`;
    } catch (error) {
        return `Invitation: ${error.message}`;
    } finally {
        currentUrl.searchParams.delete("invite");
        window.history.replaceState({}, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
    }
}

async function loadPremiumConfig() {
    premiumConfig = await api("/api/premium/config");
    planSelect.replaceChildren();
    for (const plan of premiumConfig.plans) {
        const option = document.createElement("option");
        option.value = plan.id;
        option.textContent = `${plan.label} — ₹${plan.priceInr}`;
        planSelect.appendChild(option);
    }
    updatePaymentAmountHint();
    paymentQrImage.onerror = () => {
        paymentQrAvailable = false;
        paymentQrImage.hidden = true;
        paymentRequestButton.disabled = true;
        setStatus(paymentQrStatus, "Payment QR is not available yet. Please check back later.", "error");
    };
    paymentQrImage.onload = () => {
        paymentQrAvailable = true;
        paymentQrImage.hidden = false;
        paymentRequestButton.disabled = hasPendingPaymentRequest;
        setStatus(paymentQrStatus, "");
    };
    paymentQrImage.src = `/api/premium/payment-qr?updated=${Date.now()}`;
}

function getSelectedPlan() {
    return premiumConfig && premiumConfig.plans.find((plan) => plan.id === planSelect.value);
}

function updatePaymentAmountHint() {
    const plan = getSelectedPlan();
    if (!plan) return;
    const discount = appliedCoupon && appliedCoupon.planId === plan.id ? appliedCoupon.discountPercent : 0;
    const due = discount
        ? Math.max(1, Math.round(plan.priceInr * (100 - discount) / 100))
        : plan.priceInr;
    paymentAmountHint.textContent = `Amount due: ₹${due}${discount ? ` (${discount}% coupon discount applied)` : ""}.`;
}

planSelect.addEventListener("change", () => {
    appliedCoupon = null;
    setStatus(couponStatus, "");
    updatePaymentAmountHint();
});

couponInput.addEventListener("input", () => {
    appliedCoupon = null;
    setStatus(couponStatus, "");
    updatePaymentAmountHint();
});

applyCouponButton.addEventListener("click", async () => {
    const code = couponInput.value.trim();
    if (!code) {
        appliedCoupon = null;
        setStatus(couponStatus, "Enter a coupon code first.", "error");
        updatePaymentAmountHint();
        return;
    }
    if (!getSelectedPlan()) {
        setStatus(couponStatus, "Select a plan first.", "error");
        return;
    }
    setStatus(couponStatus, "Checking coupon…");
    try {
        appliedCoupon = await api("/api/premium/coupons/validate", {
            method: "POST",
            body: JSON.stringify({ code, planId: planSelect.value })
        });
        couponInput.value = appliedCoupon.code;
        setStatus(couponStatus, `Coupon applied. You save ${appliedCoupon.discountPercent}%.`, "success");
        updatePaymentAmountHint();
    } catch (error) {
        appliedCoupon = null;
        setStatus(couponStatus, error.message, "error");
        updatePaymentAmountHint();
    }
});

paymentRequestForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (appliedCoupon && appliedCoupon.planId !== planSelect.value) {
        appliedCoupon = null;
        setStatus(couponStatus, "Plan changed. Apply the coupon again.", "error");
        updatePaymentAmountHint();
        return;
    }
    const body = new FormData();
    body.set("planId", planSelect.value);
    body.set("utr", document.getElementById("paymentUtrInput").value.trim());
    body.set("couponCode", appliedCoupon ? appliedCoupon.code : "");
    body.set("proof", document.getElementById("paymentProofInput").files[0]);
    paymentRequestButton.disabled = true;
    setStatus(paymentRequestStatus, "Submitting payment request…");
    try {
        const result = await api("/api/premium/payment-requests", { method: "POST", body });
        setStatus(paymentRequestStatus,
            `Request submitted. Amount: ₹${result.requestedAmountInr}. Admin will verify your payment; Premium starts after approval.`,
            "success");
        paymentRequestForm.reset();
        appliedCoupon = null;
        setStatus(couponStatus, "");
        updatePaymentAmountHint();
        await loadPaymentHistory();
    } catch (error) {
        setStatus(paymentRequestStatus, error.message, "error");
    } finally {
        paymentRequestButton.disabled = hasPendingPaymentRequest || !paymentQrAvailable;
    }
});

async function loadPaymentHistory() {
    const { payments } = await api("/api/premium/payment-history");
    paymentHistoryBody.replaceChildren();
    hasPendingPaymentRequest = payments.some((payment) => payment.status === "pending");
    paymentRequestButton.disabled = hasPendingPaymentRequest;
    if (hasPendingPaymentRequest) {
        setStatus(paymentRequestStatus, "Your payment request is pending admin verification. New requests are disabled until it is reviewed.");
    } else {
        setStatus(paymentRequestStatus, "");
    }
    if (!payments.length) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 6;
        cell.textContent = "No payment requests or payments yet.";
        row.appendChild(cell);
        paymentHistoryBody.appendChild(row);
        return;
    }
    for (const payment of payments) {
        const row = document.createElement("tr");
        const createdAt = payment.createdAt ? new Date(payment.createdAt).toLocaleString() : "—";
        const plan = premiumConfig && premiumConfig.plans.find((item) =>
            item.id === (payment.approvedPlan || payment.requestedPlan));
        const status = payment.status === "approved" || payment.status === "paid"
            ? "Verified"
            : payment.status === "rejected" ? "Rejected" : "Pending verification";
        const cells = [
            createdAt,
            plan ? plan.label : payment.requestedPlan === "legacy" ? "Previous plan" : payment.requestedPlan,
            payment.verifiedAmountInr === null ? `₹${payment.requestedAmountInr}` :
                `₹${payment.verifiedAmountInr}`,
            payment.couponCode ? `${payment.couponCode} (${payment.discountPercent}%)` : "—",
            payment.adminNote ? `${status} · ${payment.adminNote}` : status,
            payment.planExpiresAt ? new Date(payment.planExpiresAt).toLocaleDateString() : "—"
        ];
        for (const value of cells) {
            const cell = document.createElement("td");
            cell.textContent = value;
            row.appendChild(cell);
        }
        paymentHistoryBody.appendChild(row);
    }
}

deleteAccountRequestButton.addEventListener("click", async () => {
    if (!window.confirm("Send a request to permanently delete your account and its data? Admin will review it.")) return;
    deleteAccountRequestButton.disabled = true;
    try {
        const result = await api("/api/premium/account-deletion-requests", {
            method: "POST",
            body: JSON.stringify({})
        });
        setStatus(deletionRequestStatus, result.message, "success");
        cancelDeletionRequestButton.hidden = false;
    } catch (error) {
        setStatus(deletionRequestStatus, error.message, "error");
        deleteAccountRequestButton.disabled = false;
    }
});

cancelDeletionRequestButton.addEventListener("click", async () => {
    try {
        await api("/api/premium/account-deletion-requests", { method: "DELETE" });
        cancelDeletionRequestButton.hidden = true;
        deleteAccountRequestButton.disabled = false;
        setStatus(deletionRequestStatus, "Deletion request cancelled.", "success");
    } catch (error) {
        setStatus(deletionRequestStatus, error.message, "error");
    }
});

async function loadFriends() {
    const result = await api("/api/premium/friends");
    friendsById = new Map(result.friends.map((friend) => [friend.id, friend]));
    renderFriends();
}

function renderFriends() {
    friendsList.replaceChildren();
    if (!friendsById.size) {
        const empty = document.createElement("p");
        empty.className = "empty-friends";
        empty.textContent = "No friends yet. Find a Premium stranger or add someone by username.";
        friendsList.appendChild(empty);
        return;
    }
    for (const friend of friendsById.values()) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "friend-item";
        button.classList.toggle("active", activeRecipient && activeRecipient.id === friend.id);
        button.textContent = friend.username;
        button.addEventListener("click", () => selectRecipient(friend, false));
        friendsList.appendChild(button);
    }
}

function connectPremiumSocket() {
    if (premiumSocket) premiumSocket.disconnect();
    premiumSocket = io("/premium", { withCredentials: true });

    premiumSocket.on("connect_error", (error) => {
        setStatus(document.getElementById("matchStatus"), error.message || "Premium connection failed.", "error");
    });
    premiumSocket.on("premium-waiting", () => {
        setStatus(document.getElementById("matchStatus"), "Looking for a Premium stranger…");
    });
    premiumSocket.on("premium-matched", async (match) => {
        activeRandomMatch = true;
        await selectRecipient({ id: match.userId, username: match.username }, true);
        document.getElementById("addMatchedFriendButton").hidden = false;
        document.getElementById("addMatchedFriendButton").textContent = "Add friend";
        setStatus(document.getElementById("matchStatus"), `Connected with ${match.username}.`);
    });
    premiumSocket.on("premium-friend-added", async (friend) => {
        friendsById.set(friend.id, { id: friend.id, username: friend.username });
        renderFriends();
        if (activeRecipient && activeRecipient.id === friend.id) {
            activeRandomMatch = false;
            document.getElementById("addMatchedFriendButton").hidden = true;
            document.getElementById("conversationStatus").textContent = "Friend chat · messages expire after 24 hours.";
            setMessageEntryEnabled(true);
        }
    });
    premiumSocket.on("premium-match-ended", () => {
        if (!activeRandomMatch) return;
        activeRandomMatch = false;
        setStatus(document.getElementById("matchStatus"), "The Premium stranger left.");
        document.getElementById("addMatchedFriendButton").hidden = true;
        premiumMessageInput.disabled = true;
        currentMessageSendButton.disabled = true;
    });
    premiumSocket.on("premium-membership-expired", async () => {
        setStatus(document.getElementById("matchStatus"), "Your Premium membership expired. Renew to continue using Premium.");
        closeCall(false);
        premiumSocket.disconnect();
        premiumSocket = null;
        try {
            await loadAccount();
        } catch (error) {
            setStatus(document.getElementById("matchStatus"), error.message, "error");
        }
    });
    premiumSocket.on("premium-chat-message", (message) => {
        if (activeRecipient &&
            (message.senderId === activeRecipient.id || message.recipientId === activeRecipient.id)) {
            renderMessage(message);
        }
    });
    premiumSocket.on("premium-message-viewed", (message) => {
        const element = document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
        if (element) {
            const body = element.querySelector(".message-body");
            if (body && message.senderId === currentUser.id) {
                body.textContent = "Opened · this message will disappear shortly.";
            }
            scheduleExpiry(message.id, message.expiresAt);
        }
    });
    premiumSocket.on("premium-message-expired", ({ id }) => removeMessage(id));
    premiumSocket.on("premium-call-signal", handleCallSignal);
}

document.getElementById("randomMatchButton").addEventListener("click", () => {
    if (!premiumSocket || !premiumSocket.connected) {
        setStatus(document.getElementById("matchStatus"), "Premium chat is not connected.", "error");
        return;
    }
    if (activeRecipient && activeRandomMatch) premiumSocket.emit("premium-leave-random");
    else premiumSocket.emit("premium-cancel-search");
    closeCall(true);
    activeRecipient = null;
    activeRandomMatch = false;
    document.getElementById("reportConversationButton").hidden = true;
    premiumSocket.emit("premium-find-stranger");
    document.getElementById("conversationTitle").textContent = "Finding a Premium stranger…";
    document.getElementById("conversationStatus").textContent = "Your chat will remain available until you leave; messages expire individually.";
    document.getElementById("addMatchedFriendButton").hidden = true;
    setMessageEntryEnabled(false);
    clearMessages();
    setStatus(document.getElementById("matchStatus"), "Searching for someone…");
});

document.getElementById("addMatchedFriendButton").addEventListener("click", () => {
    if (!premiumSocket || !activeRandomMatch) return;
    const button = document.getElementById("addMatchedFriendButton");
    button.disabled = true;
    premiumSocket.emit("premium-add-random-friend", async (result) => {
        button.disabled = false;
        if (!result || !result.success) {
            setStatus(document.getElementById("matchStatus"), result && result.error || "Could not add friend.", "error");
            return;
        }
        activeRandomMatch = false;
        button.hidden = true;
        await loadFriends();
        setStatus(document.getElementById("matchStatus"), "You are now friends. Your friend list stays after chat expiry.", "success");
    });
});

document.getElementById("reportConversationButton").addEventListener("click", async () => {
    if (!activeRecipient) return;
    const category = window.prompt(
        "Choose a report category: harassment, sexual content, spam, impersonation, or other.",
        "harassment"
    );
    if (category === null) return;
    try {
        await api(`/api/premium/reports/${encodeURIComponent(activeRecipient.id)}`, {
            method: "POST",
            body: JSON.stringify({ category: category.trim().toLowerCase() })
        });
        setStatus(document.getElementById("matchStatus"), "Reported conversation submitted for safety review.", "success");
    } catch (error) {
        setStatus(document.getElementById("matchStatus"), error.message, "error");
    }
});

document.getElementById("addFriendForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = document.getElementById("friendUsernameInput").value.trim();
    const status = document.getElementById("friendStatus");
    try {
        await api("/api/premium/friends/request", {
            method: "POST",
            body: JSON.stringify({ username })
        });
        document.getElementById("friendUsernameInput").value = "";
        setStatus(status, "Friend added.", "success");
        await loadFriends();
    } catch (error) {
        setStatus(status, error.message, "error");
    }
});

async function selectRecipient(friend, randomMatch) {
    activeRecipient = friend;
    activeRandomMatch = randomMatch;
    document.getElementById("reportConversationButton").hidden = false;
    closeCall(true);
    document.getElementById("conversationTitle").textContent = friend.username;
    document.getElementById("conversationStatus").textContent = randomMatch
        ? "Premium random chat · messages expire individually after 24 hours."
        : "Friend chat · messages expire individually after 24 hours.";
    document.getElementById("addMatchedFriendButton").hidden = !randomMatch;
    setMessageEntryEnabled(true);
    clearMessages();
    renderFriends();
    try {
        const result = await api(`/api/premium/messages/${encodeURIComponent(friend.id)}`);
        result.messages.forEach(renderMessage);
    } catch (error) {
        addSystemNote(error.message);
    }
}

function setMessageEntryEnabled(enabled) {
    premiumMessageInput.disabled = !enabled;
    currentMessageSendButton.disabled = !enabled;
    mediaFileInput.disabled = !enabled;
    sendMediaButton.disabled = !enabled || !mediaFileInput.files.length;
    document.getElementById("audioCallButton").disabled = !enabled || !friendsById.has(activeRecipient && activeRecipient.id);
    document.getElementById("videoCallButton").disabled = !enabled || !friendsById.has(activeRecipient && activeRecipient.id);
}

mediaFileInput.addEventListener("change", () => {
    const file = mediaFileInput.files[0];
    sendMediaButton.disabled = !activeRecipient || !file;
    setStatus(mediaStatus, file ? `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB` : "");
});

sendMediaButton.addEventListener("click", async () => {
    const file = mediaFileInput.files[0];
    if (!activeRecipient || !file) return;
    if (file.size > 25 * 1024 * 1024) {
        setStatus(mediaStatus, "Audio/video messages are limited to 25 MB.", "error");
        return;
    }

    sendMediaButton.disabled = true;
    setStatus(mediaStatus, "Uploading media…");
    const payload = new FormData();
    payload.append("media", file);
    payload.append("caption", premiumMessageInput.value.trim());
    payload.append("viewOnce", String(singleViewCheckbox.checked));
    try {
        const response = await fetch(`/api/premium/media/${encodeURIComponent(activeRecipient.id)}`, {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            body: payload
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not upload this media.");
        renderMessage(result);
        mediaFileInput.value = "";
        premiumMessageInput.value = "";
        singleViewCheckbox.checked = false;
        setStatus(mediaStatus, "Media sent.", "success");
    } catch (error) {
        setStatus(mediaStatus, error.message, "error");
    } finally {
        sendMediaButton.disabled = !activeRecipient || !mediaFileInput.files.length;
    }
});

premiumMessageForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = premiumMessageInput.value.trim();
    if (!message || !activeRecipient || !premiumSocket) return;
    premiumSocket.emit("premium-send-message", {
        friendId: activeRecipient.id,
        message,
        viewOnce: singleViewCheckbox.checked
    }, (result) => {
        if (result && result.error) addSystemNote(result.error);
    });
    premiumMessageInput.value = "";
    singleViewCheckbox.checked = false;
    premiumMessageInput.focus();
});

function renderMessage(message) {
    if (document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) return;
    const item = document.createElement("article");
    item.className = "premium-message";
    item.dataset.messageId = message.id;
    item.classList.toggle("mine", message.senderId === currentUser.id);

    const body = document.createElement("div");
    body.className = "message-body";
    if (message.viewOnce && message.senderId !== currentUser.id && !message.viewedAt) {
        body.textContent = message.mediaId ? "Single-view audio/video" : "Single-view text message";
        const openButton = document.createElement("button");
        openButton.type = "button";
        openButton.className = "view-once-button";
        openButton.textContent = "Open once";
        openButton.addEventListener("click", () => {
            if (message.mediaId) {
                openSingleViewMedia(message, body, openButton);
                return;
            }
            if (!premiumSocket) return;
            premiumSocket.emit("premium-view-message", message.id, (result) => {
                if (!result || !result.success) {
                    removeMessage(message.id);
                    return;
                }
                body.textContent = message.body;
                openButton.remove();
                scheduleExpiry(message.id, result.expiresAt);
            });
        });
        item.append(body, openButton);
    } else if (message.viewOnce && message.viewedAt) {
        body.textContent = message.senderId === currentUser.id
            ? "Single-view message · opened"
            : "Opened · this message will disappear shortly.";
        item.appendChild(body);
        scheduleExpiry(message.id, message.expiresAt);
    } else {
        appendMessageContent(body, message);
        item.appendChild(body);
        scheduleExpiry(message.id, message.expiresAt);
    }

    const time = document.createElement("time");
    time.dateTime = message.createdAt;
    time.textContent = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    item.appendChild(time);
    premiumMessages.appendChild(item);
    premiumMessages.scrollTop = premiumMessages.scrollHeight;
}

function appendMessageContent(container, message, mediaUrl) {
    if (message.body) {
        const caption = document.createElement("div");
        caption.textContent = message.body;
        container.appendChild(caption);
    }
    if (!message.mediaId) return;
    const player = document.createElement(message.mediaType && message.mediaType.startsWith("video/")
        ? "video"
        : "audio");
    player.className = "premium-media-player";
    player.controls = true;
    if (player.tagName === "VIDEO") player.playsInline = true;
    player.src = mediaUrl || `/api/premium/media/${encodeURIComponent(message.mediaId)}`;
    container.appendChild(player);
}

async function openSingleViewMedia(message, container, openButton) {
    openButton.disabled = true;
    try {
        const response = await fetch(`/api/premium/media/${encodeURIComponent(message.mediaId)}`, {
            credentials: "same-origin",
            cache: "no-store"
        });
        if (!response.ok) {
            const result = await response.json();
            throw new Error(result.error || "This media is no longer available.");
        }
        const objectUrl = URL.createObjectURL(await response.blob());
        mediaObjectUrls.set(message.id, objectUrl);
        container.replaceChildren();
        appendMessageContent(container, message, objectUrl);
        openButton.remove();
        scheduleExpiry(message.id, response.headers.get("X-Message-Expires-At") || message.expiresAt);
    } catch (error) {
        setStatus(mediaStatus, error.message, "error");
        removeMessage(message.id);
    }
}

function scheduleExpiry(id, expiresAt) {
    if (expiryTimers.has(id)) clearTimeout(expiryTimers.get(id));
    const delay = Math.max(0, new Date(expiresAt).getTime() - Date.now());
    expiryTimers.set(id, window.setTimeout(() => removeMessage(id), delay));
}

function removeMessage(id) {
    const element = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
    if (element) element.remove();
    if (expiryTimers.has(id)) {
        clearTimeout(expiryTimers.get(id));
        expiryTimers.delete(id);
    }
    const objectUrl = mediaObjectUrls.get(id);
    if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        mediaObjectUrls.delete(id);
    }
}

function clearMessages() {
    for (const timer of expiryTimers.values()) clearTimeout(timer);
    expiryTimers.clear();
    for (const objectUrl of mediaObjectUrls.values()) URL.revokeObjectURL(objectUrl);
    mediaObjectUrls.clear();
    premiumMessages.replaceChildren();
}

function addSystemNote(text) {
    const note = document.createElement("p");
    note.className = "empty-state";
    note.textContent = text;
    premiumMessages.appendChild(note);
}

function startCall(media) {
    if (!activeRecipient || !friendsById.has(activeRecipient.id)) return;
    if (!premiumSocket || !premiumSocket.connected) return;
    beginCall(activeRecipient.id, media, null);
}

document.getElementById("audioCallButton").addEventListener("click", () => startCall("audio"));
document.getElementById("videoCallButton").addEventListener("click", () => startCall("video"));
document.getElementById("endCallButton").addEventListener("click", () => closeCall(true));
document.getElementById("toggleCallMicButton").addEventListener("click", () => {
    const track = localMedia && localMedia.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    document.getElementById("toggleCallMicButton").textContent = track.enabled ? "Mute mic" : "Unmute mic";
});
document.getElementById("toggleCallCameraButton").addEventListener("click", () => {
    const track = localMedia && localMedia.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    document.getElementById("toggleCallCameraButton").textContent = track.enabled
        ? "Turn camera off"
        : "Turn camera on";
});
document.getElementById("minimizeCallButton").addEventListener("click", () => {
    const callArea = document.getElementById("callArea");
    const minimized = callArea.classList.toggle("minimized");
    document.getElementById("minimizeCallButton").textContent = minimized ? "Expand video" : "Minimize video";
});

async function beginCall(recipientId, media, offer) {
    if (peerConnection) closeCall(false);
    activeCallRecipient = recipientId;
    pendingCallIceCandidates = [];
    const callArea = document.getElementById("callArea");
    callArea.hidden = false;
    callArea.classList.remove("minimized");
    document.getElementById("endCallButton").hidden = false;
    document.getElementById("toggleCallMicButton").hidden = false;
    document.getElementById("toggleCallCameraButton").hidden = media !== "video";
    document.getElementById("minimizeCallButton").hidden = media !== "video";
    document.getElementById("callPlaceholder").textContent = media === "audio" ? "Voice call connecting…" : "Video call connecting…";
    try {
        localMedia = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: media === "video"
        });
        document.getElementById("callLocalVideo").srcObject = media === "video" ? localMedia : null;
        peerConnection = new RTCPeerConnection(rtcConfiguration);
        localMedia.getTracks().forEach((track) => peerConnection.addTrack(track, localMedia));
        peerConnection.ontrack = (event) => {
            document.getElementById("callRemoteVideo").srcObject = event.streams[0];
            document.getElementById("callPlaceholder").hidden = true;
        };
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                premiumSocket.emit("premium-call-signal", {
                    type: "ice",
                    recipientId,
                    candidate: event.candidate
                });
            }
        };
        peerConnection.onconnectionstatechange = () => {
            const state = peerConnection && peerConnection.connectionState;
            if (state === "connected") document.getElementById("callPlaceholder").textContent = "Connected";
            if (state === "failed" || state === "disconnected") {
                document.getElementById("callPlaceholder").hidden = false;
                document.getElementById("callPlaceholder").textContent = "Call connection lost.";
            }
        };

        if (offer) {
            await peerConnection.setRemoteDescription(offer);
            await flushCallIceCandidates();
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            premiumSocket.emit("premium-call-signal", {
                type: "answer",
                recipientId,
                description: peerConnection.localDescription
            });
        } else {
            const callOffer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(callOffer);
            premiumSocket.emit("premium-call-signal", {
                type: "offer",
                recipientId,
                description: peerConnection.localDescription,
                media
            });
        }
    } catch (error) {
        console.error("Could not start Premium call:", error);
        addSystemNote(error.name === "NotAllowedError"
            ? "Allow camera/microphone access to make this call."
            : "Could not start the call on this device.");
        closeCall(false);
    }
}

async function handleCallSignal(data) {
    if (!currentUser || data.senderId === currentUser.id) return;
    if (data.type === "offer") {
        const friend = friendsById.get(data.senderId);
        if (!friend) return;
        const shouldAnswer = window.confirm(`${friend.username} is calling. Answer?`);
        if (!shouldAnswer) {
            premiumSocket.emit("premium-call-signal", { type: "end", recipientId: data.senderId });
            return;
        }
        await selectRecipient(friend, false);
        await beginCall(data.senderId, data.media === "audio" ? "audio" : "video", data.description);
    } else if (data.type === "answer" && peerConnection && activeCallRecipient === data.senderId) {
        await peerConnection.setRemoteDescription(data.description);
        await flushCallIceCandidates();
    } else if (data.type === "ice" && peerConnection && activeCallRecipient === data.senderId) {
        if (!peerConnection.remoteDescription) {
            pendingCallIceCandidates.push(data.candidate);
        } else {
            try {
                await peerConnection.addIceCandidate(data.candidate);
            } catch (error) {
                console.error("Could not add call ICE candidate:", error);
            }
        }
    } else if (data.type === "end" && activeCallRecipient === data.senderId) {
        closeCall(false);
    }
}

async function flushCallIceCandidates() {
    const candidates = pendingCallIceCandidates;
    pendingCallIceCandidates = [];
    for (const candidate of candidates) {
        try {
            await peerConnection.addIceCandidate(candidate);
        } catch (error) {
            console.error("Could not add queued call ICE candidate:", error);
        }
    }
}

function closeCall(notify) {
    if (notify && activeCallRecipient && premiumSocket) {
        premiumSocket.emit("premium-call-signal", { type: "end", recipientId: activeCallRecipient });
    }
    if (peerConnection) {
        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.close();
        peerConnection = null;
    }
    if (localMedia) {
        localMedia.getTracks().forEach((track) => track.stop());
        localMedia = null;
    }
    document.getElementById("callRemoteVideo").srcObject = null;
    document.getElementById("callLocalVideo").srcObject = null;
    document.getElementById("callPlaceholder").hidden = false;
    document.getElementById("callArea").hidden = true;
    document.getElementById("callArea").classList.remove("minimized");
    document.getElementById("endCallButton").hidden = true;
    document.getElementById("toggleCallMicButton").hidden = true;
    document.getElementById("toggleCallCameraButton").hidden = true;
    document.getElementById("minimizeCallButton").hidden = true;
    document.getElementById("toggleCallMicButton").textContent = "Mute mic";
    document.getElementById("toggleCallCameraButton").textContent = "Turn camera off";
    document.getElementById("minimizeCallButton").textContent = "Minimize video";
    activeCallRecipient = null;
    pendingCallIceCandidates = [];
}

if (activePasswordResetToken) {
    authTabs.hidden = true;
    authForm.hidden = true;
    forgotPasswordForm.hidden = true;
    resetPasswordForm.hidden = false;
} else {
    loadAccount().catch((error) => {
        console.error("Could not load Premium account:", error);
        setStatus(authStatus, error.message, "error");
    });
}

window.setInterval(async () => {
    if (!currentUser) return;
    try {
        const latestUser = await api("/api/premium/me");
        const membershipChanged =
            latestUser.premiumActive !== currentUser.premiumActive ||
            latestUser.premiumLocked !== currentUser.premiumLocked ||
            latestUser.premiumExpiresAt !== currentUser.premiumExpiresAt ||
            latestUser.deletionRequest?.status !== currentUser.deletionRequest?.status;
        if (membershipChanged) {
            await loadAccount();
        } else if (!paymentQrAvailable) {
            paymentQrImage.src = `/api/premium/payment-qr?updated=${Date.now()}`;
        }
    } catch (error) {
        if (error.message.includes("Sign in")) {
            currentUser = null;
            accountView.hidden = true;
            authView.hidden = false;
            setStatus(authStatus, "Your account is no longer available. Please sign in again.", "error");
            return;
        }
        console.error("Could not refresh Premium account status:", error);
    }
}, 60 * 1000);
