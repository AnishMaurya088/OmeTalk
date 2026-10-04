const feedbackForm = document.getElementById("feedbackForm");
const feedbackStatus = document.getElementById("feedbackStatus");
const submitButton = document.getElementById("submitFeedbackBtn");

function setFeedbackStatus(message, type = "") {
    feedbackStatus.textContent = message;
    feedbackStatus.className = "status-text";
    if (type) {
        feedbackStatus.classList.add(type);
    }
}

feedbackForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const payload = {
        name: document.getElementById("feedbackName").value,
        email: document.getElementById("feedbackEmail").value,
        type: document.getElementById("feedbackType").value,
        rating: Number(document.getElementById("feedbackRating").value),
        message: document.getElementById("feedbackMessage").value,
        consent: document.getElementById("feedbackConsent").checked,
        submittedAt: new Date().toISOString()
    };

    if (!payload.message || payload.message.trim().length < 10) {
        setFeedbackStatus("Please write at least 10 characters so the team can understand your feedback.", "error");
        return;
    }

    if (!Number.isInteger(payload.rating) || payload.rating < 1 || payload.rating > 5) {
        setFeedbackStatus("Please choose a rating from 1 to 5.", "error");
        return;
    }

    if (!payload.consent) {
        setFeedbackStatus("Please confirm that you agree to share the feedback before sending it.", "error");
        return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "Sending...";
    setFeedbackStatus("Sending your feedback...");

    try {
        const response = await fetch("/api/feedback", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (!response.ok || !result.ok) {
            setFeedbackStatus(result.message || "We couldn't send your feedback. Please try again later.", "error");
            return;
        }

        if (!result.sheetSync) {
            setFeedbackStatus("We couldn't send your feedback. Please try again later.", "error");
            return;
        }

        setFeedbackStatus("Thanks! Your feedback was sent to the team.", "success");
        feedbackForm.reset();
    } catch (error) {
        setFeedbackStatus("We couldn't send your feedback. Please try again later.", "error");
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = "Send feedback";
    }
});
