const test = require("node:test");
const assert = require("node:assert/strict");
const { detectImageType, detectMediaType, normalizeProfileInput } = require("../premium-server");

function validProfile(overrides = {}) {
    return {
        displayName: "  Anish ",
        bio: " Hello there ",
        country: "India",
        language: "Hindi",
        interests: ["Music", "Travel"],
        profilePrivate: false,
        ...overrides
    };
}

test("normalizes profile fields and removes duplicate interests", () => {
    assert.deepEqual(normalizeProfileInput(validProfile({
        interests: ["Music", "music", "Travel"]
    })), {
        displayName: "Anish",
        bio: "Hello there",
        country: "India",
        language: "Hindi",
        interests: ["music", "Travel"],
        profilePrivate: false
    });
});

test("accepts profile fields at their documented length limits", () => {
    const profile = normalizeProfileInput(validProfile({
        displayName: "a".repeat(50),
        bio: "b".repeat(160),
        country: "c".repeat(80),
        language: "d".repeat(50),
        interests: Array.from({ length: 10 }, (_, index) => `i${index}`),
        profilePrivate: true
    }));
    assert.ok(profile);
    assert.equal(profile.interests.length, 10);
    assert.equal(profile.profilePrivate, true);
});

test("rejects malformed or oversized profile updates", () => {
    assert.equal(normalizeProfileInput(null), null);
    assert.equal(normalizeProfileInput([]), null);
    assert.equal(normalizeProfileInput(validProfile({ displayName: "a".repeat(51) })), null);
    assert.equal(normalizeProfileInput(validProfile({ bio: "b".repeat(161) })), null);
    assert.equal(normalizeProfileInput(validProfile({ country: "c".repeat(81) })), null);
    assert.equal(normalizeProfileInput(validProfile({ language: "d".repeat(51) })), null);
    assert.equal(normalizeProfileInput(validProfile({
        interests: Array.from({ length: 11 }, (_, index) => `i${index}`)
    })), null);
    assert.equal(normalizeProfileInput(validProfile({ interests: ["x".repeat(33)] })), null);
    assert.equal(normalizeProfileInput(validProfile({ profilePrivate: "false" })), null);
});

test("detects image formats from their file signatures", () => {
    assert.equal(detectImageType(Buffer.from("89504e470d0a1a0a", "hex")), "image/png");
    assert.equal(detectImageType(Buffer.from("ffd8ff", "hex")), "image/jpeg");
    assert.equal(detectImageType(Buffer.from("524946460000000057454250", "hex")), "image/webp");
    assert.equal(detectImageType(Buffer.from("not an image")), null);
});

test("accepts photo attachments only when their image signature matches", () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    assert.equal(detectMediaType(png, "image/png"), "image/png");
    assert.equal(detectMediaType(png, "image/jpeg"), "image/png");
    assert.equal(detectMediaType(Buffer.from("<svg/>"), "image/svg+xml"), null);
});
