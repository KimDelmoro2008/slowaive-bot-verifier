import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { Redis } from "@upstash/redis";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
dotenv.config();

const {
  CLIENT_ID,
  CLIENT_SECRET,
  BOT_TOKEN,
  GUILD_ID,
  VERIFIED_ROLE_ID,
  REDIRECT_URI,
  PORT = 3000,
  MIN_ACCOUNT_AGE_DAYS = "7",
  ALT_FLAG_ROLE_ID = "",
  MOD_LOG_CHANNEL_ID = "",
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
} = process.env;

const app = express();
app.set("trust proxy", true); // needed to read the real client IP behind Render's proxy
app.use(cookieParser());

// Shared limiter: 20 requests per 10 minutes per IP, applied to both routes
const verifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).send(
      renderPage({
        status: "error",
        title: "Too many attempts",
        message: "You're doing that too often. Wait a few minutes and try again.",
      })
    );
  },
});

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// Discord IDs already verified from this IP, excluding the current user
async function getIpHistory(ip) {
  const ids = await redis.smembers(`ip:${ip}`);
  return ids || [];
}

async function recordIp(ip, discordId) {
  await redis.sadd(`ip:${ip}`, discordId);
}

// Readable record per user for the Data Browser: username, ID, IP, timestamp
async function recordUser(user, ip) {
  await redis.hset(`user:${user.id}`, {
    username: user.username,
    discriminator: user.discriminator || "0",
    userId: user.id,
    ip,
    verifiedAt: new Date().toISOString(),
  });
}

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return fwd ? fwd.split(",")[0].trim() : req.socket.remoteAddress;
}

function accountAgeDays(discordId) {
  // Discord snowflake -> timestamp
  const createdAt = Number(BigInt(discordId) >> 22n) + 1420070400000;
  return (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
}

async function logToMod(message) {
  if (!MOD_LOG_CHANNEL_ID) return;
  try {
    await fetch(
      `https://discord.com/api/channels/${MOD_LOG_CHANNEL_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: message }),
      }
    );
  } catch (err) {
    console.error("Mod log failed:", err);
  }
}

function renderPage({ status, title, message, guildInviteUrl }) {
  const accent =
    status === "ok" ? "#23a55a" : status === "warn" ? "#f0b232" : "#f23f42";

  // Success gets a drawn checkmark; everything else gets a static glyph.
  // Keeping the glyph set small and semantic rather than decorative icon soup.
  const iconMarkup =
    status === "ok"
      ? `<svg class="icon-svg" viewBox="0 0 52 52" aria-hidden="true">
          <circle class="icon-ring" cx="26" cy="26" r="23" fill="none" stroke-width="3"/>
          <path class="icon-check" fill="none" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" d="M15 27l7 7 16-16"/>
        </svg>`
      : status === "warn"
      ? `<svg class="icon-svg" viewBox="0 0 52 52" aria-hidden="true">
          <circle class="icon-ring" cx="26" cy="26" r="23" fill="none" stroke-width="3"/>
          <line x1="26" y1="16" x2="26" y2="29" stroke-width="4" stroke-linecap="round"/>
          <circle cx="26" cy="36" r="2.4" fill="currentColor" stroke="none"/>
        </svg>`
      : `<svg class="icon-svg" viewBox="0 0 52 52" aria-hidden="true">
          <circle class="icon-ring" cx="26" cy="26" r="23" fill="none" stroke-width="3"/>
          <path stroke-width="4" stroke-linecap="round" d="M18 18l16 16M34 18L18 34"/>
        </svg>`;

  const action =
    status === "ok"
      ? `<a class="btn" href="${guildInviteUrl || "discord://"}">Return to Discord</a>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<style>
  :root {
    --bg: #313338;
    --card: #2b2d31;
    --text: #f2f3f5;
    --muted: #949ba4;
    --accent: ${accent};
    --btn-bg: #4e5058;
    --btn-bg-hover: #6d6f78;
    color-scheme: dark;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      --bg: #f2f3f5;
      --card: #ffffff;
      --text: #060607;
      --muted: #5c5e66;
      --btn-bg: #e3e5e8;
      --btn-bg-hover: #d4d7dc;
    }
  }
  * { box-sizing: border-box; }
  html, body {
    height: 100%;
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: "gg sans", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    padding-top: calc(24px + env(safe-area-inset-top, 0px));
    padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px));
  }
  .card {
    background: var(--card);
    border-radius: 8px;
    padding: 40px 32px 32px;
    max-width: 360px;
    width: 100%;
    text-align: center;
    box-shadow: 0 8px 16px rgba(0,0,0,0.16);
  }
  .icon-svg {
    width: 52px;
    height: 52px;
    margin: 0 0 20px;
    color: var(--accent);
    overflow: visible;
  }
  .icon-ring {
    stroke: var(--accent);
    stroke-dasharray: 145;
    stroke-dashoffset: 145;
    animation: ring 0.5s ease-out forwards;
  }
  .icon-check {
    stroke: var(--accent);
    stroke-dasharray: 34;
    stroke-dashoffset: 34;
    animation: check 0.35s ease-out 0.4s forwards;
  }
  @keyframes ring { to { stroke-dashoffset: 0; } }
  @keyframes check { to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .icon-ring, .icon-check { animation: none; stroke-dashoffset: 0; }
  }
  h1 {
    font-size: 20px;
    font-weight: 700;
    margin: 0 0 8px;
    line-height: 1.3;
  }
  p {
    font-size: 15px;
    color: var(--muted);
    margin: 0;
    line-height: 1.5;
  }
  .btn {
    display: inline-block;
    margin-top: 24px;
    padding: 10px 20px;
    border-radius: 4px;
    background: var(--btn-bg);
    color: var(--text);
    text-decoration: none;
    font-size: 14px;
    font-weight: 500;
    transition: background 0.15s ease;
  }
  .btn:hover { background: var(--btn-bg-hover); }
  .btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
</head>
<body>
  <main class="card" role="status" aria-live="polite">
    ${iconMarkup}
    <h1>${title}</h1>
    <p>${message}</p>
    ${action}
  </main>
</body>
</html>`;
}

// Step 1: send member here to start verification
app.get("/verify", verifyLimiter, (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 5 * 60 * 1000, // 5 minutes to complete the flow
  });

  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify guilds.join");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

// Step 2: Discord redirects back here with a code
app.get("/callback", verifyLimiter, async (req, res) => {
  const { code, state } = req.query;
  const savedState = req.cookies.oauth_state;
  res.clearCookie("oauth_state");

  if (!code)
    return res.status(400).send(
      renderPage({
        status: "error",
        title: "Missing code",
        message: "This link is invalid. Start over from the #verify channel.",
      })
    );

  if (!state || !savedState || state !== savedState) {
    return res.status(400).send(
      renderPage({
        status: "error",
        title: "Invalid request",
        message: "This verification link expired or was tampered with. Start over from #verify.",
      })
    );
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error(tokenData);
      return res.status(400).send(
        renderPage({
          status: "error",
          title: "Verification failed",
          message: "Could not exchange the authorization code. Try again from #verify.",
        })
      );
    }

    // Get the user's identity
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();

    // --- Anti-alt check 1: account age ---
    const ageDays = accountAgeDays(user.id);
    if (ageDays < Number(MIN_ACCOUNT_AGE_DAYS)) {
      await logToMod(
        `🚫 Blocked verification: **${user.username}** (${user.id}) — account is ${ageDays.toFixed(1)} days old (min ${MIN_ACCOUNT_AGE_DAYS}).`
      );
      return res.status(403).send(
        renderPage({
          status: "error",
          title: "Account too new",
          message: `Your Discord account must be at least ${MIN_ACCOUNT_AGE_DAYS} days old to verify here.`,
        })
      );
    }

    // --- Anti-alt check 2: duplicate IP ---
    const ip = getClientIp(req);
    const existing = await getIpHistory(ip);
    const isSuspectedAlt = existing.length > 0 && !existing.includes(user.id);

    await recordIp(ip, user.id);
    await recordUser(user, ip);

    if (isSuspectedAlt) {
      await logToMod(
        `⚠️ Possible alt: **${user.username}** (${user.id}) shares an IP with ${existing.length} other verified account(s): ${existing.join(", ")}`
      );
    }

    // Add them to the guild if not already a member (requires guilds.join scope)
    await fetch(
      `https://discord.com/api/guilds/${GUILD_ID}/members/${user.id}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bot ${BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ access_token: tokenData.access_token }),
      }
    );

    // Assign the verified role
    const roleRes = await fetch(
      `https://discord.com/api/guilds/${GUILD_ID}/members/${user.id}/roles/${VERIFIED_ROLE_ID}`,
      {
        method: "PUT",
        headers: { Authorization: `Bot ${BOT_TOKEN}` },
      }
    );

    if (!roleRes.ok) {
      const err = await roleRes.text();
      console.error("Role assign failed:", err);
      return res.status(500).send(
        renderPage({
          status: "warn",
          title: "Almost there",
          message: "You're verified, but the role couldn't be assigned. Ping a mod for help.",
        })
      );
    }

    // Tag suspected alts with a separate role for mods to review
    if (isSuspectedAlt && ALT_FLAG_ROLE_ID) {
      await fetch(
        `https://discord.com/api/guilds/${GUILD_ID}/members/${user.id}/roles/${ALT_FLAG_ROLE_ID}`,
        { method: "PUT", headers: { Authorization: `Bot ${BOT_TOKEN}` } }
      );
    }

    res.send(
      renderPage({
        status: "ok",
        title: "Verification complete",
        message: "You're all set. You can close this tab and head back to Discord.",
      })
    );
  } catch (err) {
    console.error(err);
    res.status(500).send(
      renderPage({
        status: "error",
        title: "Something went wrong",
        message: "An unexpected error occurred. Try again from #verify.",
      })
    );
  }
});

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
