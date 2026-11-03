# Ometalk

Ometalk is an anonymous random text and video chat MVP with browser-to-browser calling.
It also includes an optional account-based Premium area; free anonymous chat remains available without signing in.

## Features

- Anonymous random text or video matching, with optional shared-interest matching
- Real-time messages and typing indicator using Socket.IO
- WebRTC video/audio with camera and microphone controls
- Tap or click either video preview to make it the main view
- Leave and report actions
- Password-protected admin dashboard at `/admin` with live user, connection, and report aggregates
- Premium accounts with visible usernames, premium stranger matching, persistent friends, and text chats
- Editable Premium profiles with a 2 MB JPG/PNG/WebP photo, bio, country, language, interests, and friends-only visibility
- Persistent friend requests with accept/reject, friend removal, and block/unblock controls
- Premium signup collects a private name and date of birth, requires an age of 18+, and suggests available unique usernames
- Premium photo/audio/video clip messages (up to 25 MB) and voice/video calls with WebRTC
- Messages that expire 24 hours after sending; single-view text or media expires one minute after opening
- Manual QR/UPI payments for one-month and three-month Premium plans, with screenshot/UTR verification by admin
- Admin-created percentage coupons, payment history, account deletion requests, and membership lock controls
- Report-only moderation: admins can review reported-chat text after entering an audited access reason; video/audio calls are never recorded

## Tech stack

- Node.js and Express
- Socket.IO
- WebRTC
- PostgreSQL for Premium accounts, friendships, payments, coupons, and expiring messages
- HTML, CSS, and browser JavaScript

## Run locally

Install dependencies and start the server:

```sh
npm ci
npm start
```

Run the JavaScript syntax checks before deployment:

```sh
npm run check
```

The app uses port `3000` by default and reads the optional `PORT` environment variable. Camera and microphone access require localhost or HTTPS.

## Premium setup

The free anonymous chat works without a database. Premium accounts and manual payments require PostgreSQL:

- `DATABASE_URL` — PostgreSQL connection string. The app creates its Premium tables on startup.
- `DATABASE_KEEPALIVE_INTERVAL_MS` — optional interval for a `SELECT 1` PostgreSQL keepalive. Defaults to `0` (disabled); set to `180000` for a 3-minute interval only on an always-on server. This does not prevent a free Render web service from sleeping, and keeping Neon active can use its monthly compute allowance faster.
- `APP_BASE_URL` — public HTTPS site URL used to build password reset links in production.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM` — SMTP settings for password reset emails. SMTP authentication fields may both be omitted if the server allows unauthenticated relay.

On startup, a Premium account can be created at `/premium`. Signup checks the age from the entered date of birth; name and date of birth are stored privately. Users can edit their profile and choose whether it is public or friends-only. Private profile details and photos are limited to friends, and date of birth is never included in public profile responses. Profile photos are limited to 2 MB and stored in PostgreSQL for this MVP; use object storage at larger scale. Username suggestions are checked against existing accounts, and a database constraint enforces uniqueness. Passwords must be at least 6 characters. The sign-in page offers a one-time reset link sent to the account email; it expires after 30 minutes and resetting the password signs out active sessions. Configure SMTP and, in production, `APP_BASE_URL` to enable it. Google sign-in and email verification are not implemented yet.

Friend requests are stored in PostgreSQL. Users can accept or reject requests, remove friends, and block or unblock accounts; blocking removes the friendship and prevents further Premium matching, messaging, and calls between those accounts. These new tables and profile columns are created additively on application startup and do not delete existing account data.

## Features not implemented yet

The current release does not include Google sign-in, email verification, Stories, private Snaps, chat streaks, Memories/highlights, push notifications, account search/followers, advanced match filters, admin role/permission management, or admin 2FA. Do not treat those items as available until their code, required provider configuration, and end-to-end tests are added.

The admin uploads the Premium UPI payment QR at `/admin`. Members choose one month (₹299) or three months (₹699), can apply a coupon, then submit their UTR and a JPG/PNG/WebP payment screenshot (up to 5 MB). Pending requests do not expire and only one can be pending per account. Admin verifies the proof, enters the actual amount received, and selects the plan to activate. Membership starts immediately if expired, or extends from the current expiry if it is still active. A 24-hour grace period follows the expiry timestamp. The account page shows membership status and payment history; members can sign out or request permanent account deletion. Admin can lock/unlock memberships and process deletion requests. Deleting an account permanently removes its profile, payment proof/history, messages, and friend links.

Free-chat ad serving is not enabled yet because an ad network/publisher account has not been selected. Add the chosen provider only to free-chat placements; keep Premium pages ad-free. Ad networks may require approval and a verified domain before ads can earn revenue.

Free accounts can join anonymous random text or video chats; ads are deferred until an ad provider is chosen. Premium members can find a random Premium stranger, add each other as friends, and chat or voice/video call with friends later. A signed-in Premium member can also send an invitation link to a free random-chat partner; the recipient can create an account to establish the friend connection and subscribe later. Friendship remains after a conversation ends. Text, audio, and video messages are removed 24 hours after they are sent. A single-view message is removed one minute after the recipient opens it. Single-view cannot prevent screenshots or screen recording. Audio/video clips are stored in PostgreSQL for this MVP; use object storage for larger-scale deployment, and make sure database backups and retention policies also match your privacy requirements.

Free and Premium users can report a conversation using a moderation category. Only reported conversations are available to admins; there is no unrestricted chat browser. A free-chat report stores at most the latest 100 text messages, the selected category, and anonymous display names for up to 30 days. Premium reports store the relevant unexpired text transcript and attachment type metadata for up to 30 days; attachment media itself is not exposed in the moderation dashboard. Admins must give a reason before opening a transcript, and each access and resolution is logged. Video/audio calls are not recorded or available to admins. These reported-chat records are stored in the local `data/moderation-reports.json` file for free chat and in PostgreSQL for Premium; configure persistent storage and backups if reports must survive host restarts.

The PostgreSQL URL and SMTP credentials must be configured in the hosting provider's secret environment settings. Do not commit real credentials. Video/voice calling uses public STUN servers; a TURN service is still recommended for reliable calls behind restrictive networks.

To enable the admin dashboard, set `ADMIN_PASSWORD` in the process environment. Use a strong value of at least 16 characters; never commit the real password. The example values in `.env.example` are placeholders and are not loaded automatically.

PowerShell example:

```powershell
$env:ADMIN_PASSWORD = "replace-with-your-own-strong-password"
npm start
```

## Render deployment

The included `render.yaml` can be used to create a Render Blueprint from this repository. Set `ADMIN_PASSWORD`, `DATABASE_URL`, SMTP settings, and `APP_BASE_URL` in the Render service environment. Upload the QR image in `/admin` after deployment.

For the feedback form, also add these Render secrets:

- `GOOGLE_SHEETS_FEEDBACK_URL` — the deployed Google Apps Script Web App URL
- `GOOGLE_SHEETS_FEEDBACK_TOKEN` — the same shared token saved in the Apps Script project properties as `FEEDBACK_SHARED_TOKEN`

The admin dashboard stores only aggregate daily counts in `data/admin-metrics.json`. Free hosting filesystems may be temporary, so use a persistent disk or database if those counts must survive host restarts and redeploys.

## Feedback form to Google Sheets

1. Open Google Apps Script and create a new project.
2. Paste the script from `integrations/google-sheets-feedback.gs`.
3. In the script editor, open Project Settings > Script properties and add:
   - `FEEDBACK_SHARED_TOKEN` = a long random secret string
4. Deploy the script as a Web App:
   - Execute as: Me
   - Who has access: Anyone
5. Copy the Web App URL and set it as `GOOGLE_SHEETS_FEEDBACK_URL` in Render or your local environment.
6. Set `GOOGLE_SHEETS_FEEDBACK_TOKEN` in the app environment to exactly the same value as `FEEDBACK_SHARED_TOKEN`.
7. Submit a test form and check the Google Sheet named `Feedback`.

The app keeps unsent feedback entries in `data/feedback.json` and retries them automatically on startup, so submissions are not lost when Google Sheets is temporarily unavailable.

## Limitations

- The 18+ check uses the user's entered date of birth; it is not proof-of-identity verification.
- Reports are aggregate counts only; there is no review queue or moderation workflow yet.
- WebRTC currently uses public STUN servers. A TURN service is needed for reliable calls across restrictive networks.
- This is an early MVP and should not be treated as a fully moderated public chat service.