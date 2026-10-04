const socket = io();

const welcomeScreen = document.getElementById("welcomeScreen");
const chatScreen = document.getElementById("chatScreen");
const startBtn = document.getElementById("startBtn");
const nextBtn = document.getElementById("nextBtn");
const leaveBtn = document.getElementById("leaveBtn");
const reportBtn = document.getElementById("reportBtn");
const interestsInput = document.getElementById("interestsInput");
const profileNameInput = document.getElementById("profileName");
const partnerName = document.getElementById("partnerName");
const ageConsent = document.getElementById("ageConsent");
const interestChips = [...document.querySelectorAll(".interest-chip")];
const chatModeInputs = [...document.querySelectorAll('input[name="chatMode"]')];
const modeHint = document.getElementById("modeHint");
const modeStory = document.getElementById("modeStory");
const modeStoryKicker = document.getElementById("modeStoryKicker");
const modeStoryAccent = document.getElementById("modeStoryAccent");
const modeStoryRest = document.getElementById("modeStoryRest");
const modeStoryDescription = document.getElementById("modeStoryDescription");
const modeStoryPoints = [
    document.getElementById("modePointOne"),
    document.getElementById("modePointTwo"),
    document.getElementById("modePointThree")
];
const messageForm = document.getElementById("messageForm");
const messageInput = document.getElementById("messageInput");
const messages = document.getElementById("messages");
const chatStatus = document.getElementById("chatStatus");
const onlineText = document.getElementById("onlineText");
const homePage = document.querySelector(".home-page");
const appContainer = document.querySelector(".app-container");
const startChatLinks = [...document.querySelectorAll(".start-chat-link")];
const backHomeBtn = document.getElementById("backHomeBtn");
const faqDialog = document.getElementById("faqDialog");
const premiumDialog = document.getElementById("premiumDialog");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const remotePlaceholder = document.getElementById("remotePlaceholder");
const videoArea = document.querySelector(".video-area");
const strangerVideoContainer = document.querySelector(".stranger-video-container");
const myVideoContainer = document.querySelector(".my-video-container");
const cameraBtn = document.getElementById("cameraBtn");
const micBtn = document.getElementById("micBtn");
const videoLayoutBtn = document.getElementById("videoLayoutBtn");
const typingIndicator = document.getElementById("typingIndicator");

let currentPartnerId = null;
let currentRoomId = null;
let isSearching = false;
let peerConnection = null;
let localStream = null;
let currentMode = "video";
let pendingIceCandidates = [];
let typingTimeout = null;
let isTyping = false;
let isVideoMinimized = false;

const rtcConfiguration = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
    ]
};

function resetToWelcomeState() {
    welcomeScreen.classList.remove("hidden");
    chatScreen.classList.add("hidden");
    startBtn.disabled = !ageConsent.checked;
    nextBtn.disabled = true;
    messageInput.disabled = true;
    partnerName.textContent = "Stranger";
    chatStatus.textContent = "Ready";
    remotePlaceholder.classList.remove("hidden");
    remoteVideo.srcObject = null;
}

socket.on("connect", () => {
    console.log("Connected to server:", socket.id);
    onlineText.textContent = "Connected";
    resetToWelcomeState();
});

socket.on("disconnect", () => {
    console.log("Disconnected from server");
    onlineText.textContent = "Disconnected";
    chatStatus.textContent = "Connection lost";
    closePeerConnection();
    stopCamera();
    stopTyping();
    currentPartnerId = null;
    currentRoomId = null;
    isSearching = false;
});

ageConsent.addEventListener("change", () => {
    startBtn.disabled = !ageConsent.checked || !socket.connected;
});

interestsInput.addEventListener("input", updateInterestChipStates);

interestChips.forEach((chip) => {
    chip.setAttribute("aria-pressed", "false");
    chip.addEventListener("click", () => {
        const interests = getSelectedInterests();
        const interest = chip.dataset.interest;
        const existingIndex = interests.indexOf(interest);

        if (existingIndex !== -1) {
            interests.splice(existingIndex, 1);
        } else if (interests.length < 8) {
            interests.push(interest);
        }

        interestsInput.value = interests.join(", ");
        updateInterestChipStates();
    });
});

chatModeInputs.forEach((input) => {
    input.addEventListener("change", () => {
        const mode = input.value;
        modeHint.textContent = input.value === "video"
            ? "Video chat selected. Camera and microphone are needed to connect."
            : "Text chat selected. No camera or microphone needed to connect.";
        updateModeStory(mode);
    });
});

strangerVideoContainer.addEventListener("click", () => {
    if (isVideoMinimized) {
        toggleVideoLayout();
        return;
    }
    setVideoFocus("stranger");
});
myVideoContainer.addEventListener("click", () => {
    if (isVideoMinimized) {
        toggleVideoLayout();
        return;
    }
    setVideoFocus("self");
});
strangerVideoContainer.addEventListener("keydown", (event) => handleVideoViewKeydown(event, "stranger"));
myVideoContainer.addEventListener("keydown", (event) => handleVideoViewKeydown(event, "self"));
if (videoLayoutBtn) {
    videoLayoutBtn.addEventListener("click", toggleVideoLayout);
}
messageInput.addEventListener("input", updateTypingState);
setVideoFocus("stranger");

function updateModeStory(mode) {
    const isVideo = mode === "video";
    const story = isVideo
        ? {
            kicker: "VIDEO CHAT",
            accent: "Meet",
            rest: "face to face, anywhere.",
            description: "Live video turns a quick hello into a real conversation.",
            points: ["Live face-to-face", "Camera and mic controls", "Leave whenever you like"]
        }
        : {
            kicker: "TEXT CHAT",
            accent: "Say hello",
            rest: "then see where it goes.",
            description: "Start with a message and let a good conversation find its rhythm.",
            points: ["No camera needed", "Find shared interests", "Chat at your own pace"]
        };

    modeStory.dataset.mode = mode;
    modeStoryKicker.textContent = story.kicker;
    modeStoryAccent.textContent = story.accent;
    modeStoryAccent.classList.toggle("blue-word", !isVideo);
    modeStoryAccent.classList.toggle("pink-word", isVideo);
    modeStoryRest.textContent = story.rest;
    modeStoryDescription.textContent = story.description;
    modeStoryPoints.forEach((point, index) => {
        point.textContent = story.points[index];
    });
}

startChatLinks.forEach((button) => {
    button.addEventListener("click", () => {
        const modeInput = chatModeInputs.find((input) => input.value === button.dataset.mode);
        if (modeInput) {
            modeInput.checked = true;
            modeInput.dispatchEvent(new Event("change", { bubbles: true }));
        }

        homePage.classList.add("hidden");
        appContainer.classList.remove("hidden");
        welcomeScreen.classList.remove("hidden");
        chatScreen.classList.add("hidden");
        window.scrollTo({ top: 0, behavior: "smooth" });
    });
});

backHomeBtn.addEventListener("click", () => {
    appContainer.classList.add("hidden");
    homePage.classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
});

document.getElementById("faqOpenBtn").addEventListener("click", () => faqDialog.showModal());
document.getElementById("footerFaqBtn").addEventListener("click", () => faqDialog.showModal());
document.getElementById("faqCloseBtn").addEventListener("click", () => faqDialog.close());
document.getElementById("premiumOpenBtn").addEventListener("click", () => premiumDialog.showModal());
document.getElementById("premiumCloseBtn").addEventListener("click", () => premiumDialog.close());

startBtn.addEventListener("click", async () => {
    await startSearching();
});

nextBtn.addEventListener("click", async () => {
    if (isSearching) return;

    stopTyping();
    isSearching = true;
    currentPartnerId = null;
    currentRoomId = null;

    closePeerConnection();
    remoteVideo.srcObject = null;
    remotePlaceholder.classList.remove("hidden");

    clearMessages();
    addSystemMessage("Finding a new stranger...");
    chatStatus.textContent = "Searching...";
    messageInput.disabled = true;
    nextBtn.disabled = true;

    socket.emit("next-stranger");
});

leaveBtn.addEventListener("click", () => {
    stopTyping();
    socket.emit("leave-chat");
    currentPartnerId = null;
    currentRoomId = null;
    isSearching = false;

    closePeerConnection();
    stopCamera();
    remoteVideo.srcObject = null;
    remotePlaceholder.classList.remove("hidden");
    messageInput.disabled = true;
    nextBtn.disabled = false;

    clearMessages();
    addSystemMessage("You left the chat.");
    addSystemMessage("Click Start Chat to meet someone new.");

    chatStatus.textContent = "Ready";
    chatScreen.classList.remove("text-mode");

    welcomeScreen.classList.remove("hidden");
    chatScreen.classList.add("hidden");
    startBtn.disabled = !ageConsent.checked;
});

reportBtn.addEventListener("click", () => {
    if (!currentPartnerId || reportBtn.disabled) return;

    reportBtn.disabled = true;
    socket.emit("report-stranger", (result) => {
        if (!result || !result.success) {
            reportBtn.disabled = false;
            addSystemMessage("Unable to submit report. The chat may have ended.");
            return;
        }

        currentPartnerId = null;
        currentRoomId = null;
        stopTyping();
        messageInput.disabled = true;
        nextBtn.disabled = false;
        chatStatus.textContent = "Report submitted";
        addSystemMessage("Report submitted. You can find another stranger with Next.");
    });
});

async function startSearching() {
    if (isSearching || !ageConsent.checked || !socket.connected) return;

    isSearching = true;
    const selectedMode = document.querySelector('input[name="chatMode"]:checked');
    if (!selectedMode) {
        isSearching = false;
        return;
    }

    currentMode = selectedMode.value;
    welcomeScreen.classList.add("hidden");
    chatScreen.classList.remove("hidden");
    chatScreen.classList.toggle("text-mode", currentMode === "text");
    startBtn.disabled = true;
    nextBtn.disabled = true;
    messageInput.disabled = true;

    clearMessages();
    addSystemMessage(currentMode === "video"
        ? "Starting camera and microphone..."
        : "Looking for a text chat...");
    chatStatus.textContent = currentMode === "video" ? "Starting camera..." : "Searching...";

    const cameraStarted = currentMode === "text" || await startCamera();

    if (!cameraStarted) {
        isSearching = false;
        stopCamera();
        chatStatus.textContent = "Camera/Microphone unavailable";
        welcomeScreen.classList.remove("hidden");
        chatScreen.classList.add("hidden");
        startBtn.disabled = !ageConsent.checked;
        return;
    }

    clearMessages();
    addSystemMessage("Looking for a stranger...");
    chatStatus.textContent = "Searching...";

    const interests = getSelectedInterests();
    const name = profileNameInput.value.trim();

    socket.emit("find-stranger", { mode: currentMode, interests, name });
}

async function startCamera() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });

        localVideo.srcObject = localStream;
        localVideo.play().catch(() => {});
        updateMediaButtons();
        return true;
    } catch (error) {
        console.error("Camera/Microphone error:", error);

        if (error.name === "NotAllowedError") {
            alert("Please allow camera and microphone permission in your browser.");
        } else if (error.name === "NotFoundError") {
            alert("Camera or microphone was not found on this device.");
        } else {
            alert("Unable to access camera and microphone.");
        }

        return false;
    }
}

socket.on("waiting", () => {
    console.log("Waiting for stranger...");
    chatStatus.textContent = "Waiting for a stranger...";
    addSystemMessage("Waiting for a stranger to join...");
});

socket.on("matched", async (data) => {
    console.log("Matched with:", data);

    currentPartnerId = data.partnerId;
    currentRoomId = data.roomId;
    partnerName.textContent = data.partnerName || "Stranger";
    currentMode = data.mode || currentMode;
    isSearching = false;

    chatScreen.classList.toggle("text-mode", currentMode === "text");
    chatStatus.textContent = currentMode === "text"
        ? "Connected to stranger by text"
        : "Connected to stranger";
    nextBtn.disabled = false;
    reportBtn.disabled = false;
    messageInput.disabled = false;
    if (window.matchMedia("(min-width: 801px)").matches) {
        messageInput.focus();
    }

    clearMessages();
    addSystemMessage("You are now connected to a stranger.");
    if (Array.isArray(data.sharedInterests) && data.sharedInterests.length > 0) {
        addSystemMessage("You both like: " + data.sharedInterests.join(", "));
    }

    if (currentMode === "text") return;

    await createPeerConnection();

    if (socket.id < currentPartnerId) {
        console.log("I will create WebRTC offer.");
        await createOffer();
    }
});

async function createPeerConnection() {
    closePeerConnection();
    pendingIceCandidates = [];

    peerConnection = new RTCPeerConnection(rtcConfiguration);

    if (localStream) {
        localStream.getTracks().forEach((track) => {
            peerConnection.addTrack(track, localStream);
        });
    }

    peerConnection.ontrack = (event) => {
        console.log("Remote media received");

        if (event.streams && event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
        }

        remoteVideo.play().catch(() => {});
        remotePlaceholder.classList.add("hidden");
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate && currentPartnerId) {
            socket.emit("webrtc-ice-candidate", {
                partnerId: currentPartnerId,
                candidate: event.candidate
            });
        }
    };

    peerConnection.onconnectionstatechange = () => {
        console.log("WebRTC connection:", peerConnection.connectionState);

        if (peerConnection.connectionState === "connected") {
            chatStatus.textContent = "Video connected";
        }

        if (peerConnection.connectionState === "disconnected") {
            chatStatus.textContent = "Video disconnected";
        }

        if (peerConnection.connectionState === "failed") {
            chatStatus.textContent = "Video connection failed";
        }
    };
}

async function createOffer() {
    if (!peerConnection) return;

    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        socket.emit("webrtc-offer", {
            partnerId: currentPartnerId,
            offer: offer
        });

        console.log("WebRTC offer sent");
    } catch (error) {
        console.error("Offer error:", error);
    }
}

socket.on("webrtc-offer", async (data) => {
    console.log("WebRTC offer received");
    if (data.partnerId !== currentPartnerId || currentMode !== "video") return;

    if (!peerConnection) {
        await createPeerConnection();
    }

    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        await addPendingIceCandidates();

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        socket.emit("webrtc-answer", {
            partnerId: data.partnerId,
            answer: answer
        });

        console.log("WebRTC answer sent");
    } catch (error) {
        console.error("Offer handling error:", error);
    }
});

socket.on("webrtc-answer", async (data) => {
    console.log("WebRTC answer received");

    if (!peerConnection || data.partnerId !== currentPartnerId) return;

    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        await addPendingIceCandidates();
        console.log("Remote description added");
    } catch (error) {
        console.error("Answer handling error:", error);
    }
});

socket.on("webrtc-ice-candidate", async (data) => {
    if (!peerConnection || data.partnerId !== currentPartnerId) return;

    if (!peerConnection.remoteDescription) {
        // ICE may arrive before the remote SDP; queue it until that description is set.
        pendingIceCandidates.push(data.candidate);
        return;
    }

    try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (error) {
        console.error("ICE candidate error:", error);
    }
});

async function addPendingIceCandidates() {
    const candidates = pendingIceCandidates;
    pendingIceCandidates = [];

    for (const candidate of candidates) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
            console.error("Queued ICE candidate error:", error);
        }
    }
}

messageForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const message = messageInput.value.trim();
    if (!message) {
        stopTyping();
        return;
    }
    if (!currentRoomId) {
        stopTyping();
        addSystemMessage("You are not connected to a stranger.");
        return;
    }

    stopTyping();
    addMyMessage(message);

    socket.emit("send-message", {
        roomId: currentRoomId,
        message: message
    });

    messageInput.value = "";
    messageInput.focus();
});

socket.on("receive-message", (data) => {
    console.log("Message received:", data.message);
    addStrangerMessage(data.message);
});

socket.on("partner-typing", (data) => {
    const partnerIsTyping = Boolean(data && data.isTyping && currentRoomId);
    typingIndicator.textContent = partnerIsTyping ? "Stranger is typing..." : "";
    typingIndicator.classList.toggle("visible", partnerIsTyping);
});

socket.on("partner-left", () => {
    console.log("Partner disconnected");

    currentPartnerId = null;
    currentRoomId = null;
    isSearching = false;
    stopTyping();
    typingIndicator.textContent = "";
    typingIndicator.classList.remove("visible");

    closePeerConnection();
    remoteVideo.srcObject = null;
    remotePlaceholder.classList.remove("hidden");
    reportBtn.disabled = true;

    chatStatus.textContent = "Stranger disconnected";
    messageInput.disabled = true;
    nextBtn.disabled = false;

    addSystemMessage("The stranger has left the chat.");
    addSystemMessage("Click Next to find someone else.");
});

if (cameraBtn) {
    cameraBtn.addEventListener("click", () => {
        if (!localStream) return;

        const videoTracks = localStream.getVideoTracks();
        if (videoTracks.length === 0) return;

        const videoTrack = videoTracks[0];
        videoTrack.enabled = !videoTrack.enabled;
        updateMediaButtons();
    });
}

if (micBtn) {
    micBtn.addEventListener("click", () => {
        if (!localStream) return;

        const audioTracks = localStream.getAudioTracks();
        if (audioTracks.length === 0) return;

        const audioTrack = audioTracks[0];
        audioTrack.enabled = !audioTrack.enabled;
        updateMediaButtons();
    });
}

function updateMediaButtons() {
    if (!localStream) return;

    const videoTracks = localStream.getVideoTracks();
    const audioTracks = localStream.getAudioTracks();

    if (cameraBtn && videoTracks.length > 0) {
        const videoEnabled = videoTracks[0].enabled;
        cameraBtn.setAttribute("aria-pressed", String(videoEnabled));
        cameraBtn.setAttribute("aria-label", videoEnabled ? "Camera on" : "Camera off");
        cameraBtn.title = videoEnabled ? "Turn camera off" : "Turn camera on";
        cameraBtn.classList.toggle("is-off", !videoEnabled);
    }

    if (micBtn && audioTracks.length > 0) {
        const audioEnabled = audioTracks[0].enabled;
        micBtn.setAttribute("aria-pressed", String(audioEnabled));
        micBtn.setAttribute("aria-label", audioEnabled ? "Microphone on" : "Microphone off");
        micBtn.title = audioEnabled ? "Turn microphone off" : "Turn microphone on";
        micBtn.classList.toggle("is-off", !audioEnabled);
    }
}

function toggleVideoLayout() {
    isVideoMinimized = !isVideoMinimized;
    videoArea.classList.toggle("minimized", isVideoMinimized);
    if (videoLayoutBtn) {
        videoLayoutBtn.setAttribute("aria-pressed", String(isVideoMinimized));
        videoLayoutBtn.setAttribute("aria-label", isVideoMinimized ? "Maximize video" : "Minimize video");
        videoLayoutBtn.title = isVideoMinimized ? "Maximize video" : "Minimize video";
    }
}

function setVideoFocus(focus) {
    const selfIsLarge = focus === "self";
    videoArea.classList.toggle("self-focused", selfIsLarge);
    myVideoContainer.setAttribute("aria-pressed", String(selfIsLarge));
    strangerVideoContainer.setAttribute("aria-pressed", String(!selfIsLarge));
    myVideoContainer.setAttribute("aria-label", selfIsLarge
        ? "Your video is the main view"
        : "Make your video the main view");
    strangerVideoContainer.setAttribute("aria-label", selfIsLarge
        ? "Make stranger video the main view"
        : "Stranger video is the main view");
}

function handleVideoViewKeydown(event, focus) {
    if (event.key !== "Enter" && event.key !== " ") return;

    event.preventDefault();
    setVideoFocus(focus);
}

function updateTypingState() {
    if (!currentRoomId) return;

    const hasMessage = messageInput.value.trim().length > 0;
    if (hasMessage && !isTyping) {
        isTyping = true;
        socket.emit("typing", true);
    }

    clearTimeout(typingTimeout);
    if (!hasMessage) {
        stopTyping();
        return;
    }

    typingTimeout = setTimeout(stopTyping, 1200);
}

function stopTyping() {
    clearTimeout(typingTimeout);
    typingTimeout = null;

    if (isTyping) {
        socket.emit("typing", false);
        isTyping = false;
    }
}

function getSelectedInterests() {
    return [...new Set(interestsInput.value
        .split(",")
        .map((interest) => interest.trim().toLowerCase())
        .filter(Boolean))].slice(0, 8);
}

function updateInterestChipStates() {
    const interests = getSelectedInterests();

    interestChips.forEach((chip) => {
        const isSelected = interests.includes(chip.dataset.interest);
        chip.setAttribute("aria-pressed", String(isSelected));
    });
}

function closePeerConnection() {
    if (peerConnection) {
        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.close();
        peerConnection = null;
    }

    pendingIceCandidates = [];
}

function stopCamera() {
    if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
        localStream = null;
    }

    localVideo.srcObject = null;
    if (cameraBtn) {
        cameraBtn.classList.remove("is-off");
        cameraBtn.setAttribute("aria-pressed", "true");
        cameraBtn.setAttribute("aria-label", "Camera on");
        cameraBtn.title = "Turn camera off";
    }
    if (micBtn) {
        micBtn.classList.remove("is-off");
        micBtn.setAttribute("aria-pressed", "true");
        micBtn.setAttribute("aria-label", "Microphone on");
        micBtn.title = "Turn microphone off";
    }
}

function addMyMessage(message) {
    const messageElement = document.createElement("div");
    messageElement.className = "message my-message";
    messageElement.textContent = message;
    messages.appendChild(messageElement);
    scrollToBottom();
}

function addStrangerMessage(message) {
    const messageElement = document.createElement("div");
    messageElement.className = "message stranger-message";
    messageElement.textContent = message;
    messages.appendChild(messageElement);
    scrollToBottom();
}

function addSystemMessage(message) {
    const messageElement = document.createElement("div");
    messageElement.className = "system-message";
    messageElement.textContent = message;
    messages.appendChild(messageElement);
    scrollToBottom();
}

function clearMessages() {
    messages.innerHTML = "";
}

function scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
}


