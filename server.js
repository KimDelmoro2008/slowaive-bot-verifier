import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { Redis } from "@upstash/redis";
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

function renderPage({ status, title, message }) {
  const accent = status === "ok" ? "#57f287" : status === "warn" ? "#faa61a" : "#ed4245";
  const icon = status === "ok" ? "✓" : status === "warn" ? "!" : "×";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root {
    --bg: #313338;
    --card: #2b2d31;
    --text: #f2f3f5;
    --muted: #b5bac1;
    --accent: ${accent};
    color-scheme: dark;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      --bg: #f2f3f5;
      --card: #ffffff;
      --text: #060607;
      --muted: #5c5e66;
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
  }
  .card {
    background: var(--card);
    border-radius: 12px;
    padding: 40px 36px;
    max-width: 380px;
    width: 100%;
    text-align: center;
    box-shadow: 0 8px 24px rgba(0,0,0,0.24);
  }
  .icon {
    width: 56px;
    height: 56px;
    margin: 0 auto 20px;
    border-radius: 50%;
    border: 3px solid var(--accent);
    color: var(--accent);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 26px;
    font-weight: 700;
  }
  h1 {
    font-size: 18px;
    margin: 0 0 8px;
  }
  p {
    font-size: 14px;
    color: var(--muted);
    margin: 0;
    line-height: 1.5;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

// Step 1: send member here to start verification
app.get("/verify", (req, res) => {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify guilds.join");
  res.redirect(url.toString());
});

// Step 2: Discord redirects back here with a code
app.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (!code)
    return res.status(400).send(
      renderPage({
        status: "error",
        title: "Missing code",
        message: "This link is invalid. Start over from the #verify channel.",
      })
    );

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
