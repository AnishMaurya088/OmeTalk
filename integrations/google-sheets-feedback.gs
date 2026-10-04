const SHEET_NAME = "Feedback";
const PROPERTIES = PropertiesService.getScriptProperties();

function tokensMatch(providedValue, expectedValue) {
  if (!providedValue || !expectedValue) return false;
  if (providedValue.length !== expectedValue.length) return false;

  let mismatchCount = 0;
  for (let i = 0; i < providedValue.length; i += 1) {
    if (providedValue.charCodeAt(i) !== expectedValue.charCodeAt(i)) mismatchCount += 1;
  }

  return mismatchCount === 0;
}

// Apps Script ContentService returns JSON text but does not expose HTTP status setters.
function jsonResponse(success, message) {
  return ContentService
    .createTextOutput(JSON.stringify({ success, message }))
    .setMimeType(ContentService.MimeType.JSON);
}

function safeCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).slice(0, 5000);
}

function formatSubmissionTime(dateValue) {
  const date = new Date(dateValue || Date.now());
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });
}

function getOrCreateSheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
    sheet.appendRow([
      "Timestamp",
      "Name",
      "Email",
      "Type",
      "Rating",
      "Message",
      "Consent",
      "Source"
    ]);
    sheet.getRange(1, 1, 1, 8).setFontWeight("bold");
  }

  return sheet;
}

function doPost(event) {
  try {
    const payload = event && event.postData && event.postData.contents
      ? JSON.parse(event.postData.contents)
      : {};

    if (!payload || !payload.token) {
      return jsonResponse(false, "Missing token.");
    }

    const expectedToken = PROPERTIES.getProperty("FEEDBACK_SHARED_TOKEN");
    if (!expectedToken || !tokensMatch(payload.token, expectedToken)) {
      return jsonResponse(false, "Unauthorized request.");
    }

    const feedback = payload.feedback || payload;
    const timestamp = formatSubmissionTime(feedback.submittedAt || feedback.createdAt || Date.now());
    const name = safeCell(feedback.name || "Anonymous");
    const email = safeCell(feedback.email || "");
    const type = safeCell(feedback.type || "other");
    const rating = safeCell(feedback.rating ?? 5);
    const message = safeCell(feedback.message || "");
    const consent = Boolean(feedback.consent) ? "Yes" : "No";
    const source = safeCell(feedback.source || "OmeTalk web app");

    if (!message || message.length < 10) {
      return jsonResponse(false, "Feedback message is too short.");
    }

    const sheet = getOrCreateSheet();
    const lastRow = sheet.getLastRow() + 1;
    sheet.getRange(lastRow, 1, 1, 8).setValues([[timestamp, name, email, type, rating, message, consent, source]]);

    return jsonResponse(true, "Feedback recorded successfully.");
  } catch (error) {
    return jsonResponse(false, error && error.message ? error.message : "Server error.");
  }
}
