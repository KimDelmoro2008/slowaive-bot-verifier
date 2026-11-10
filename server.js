import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const {
  CLIENT_ID,
  CLIENT_SECRET,
  BOT_TOKEN,
  GUILD_ID,
  VERIFIED_ROLE_ID,
  REDIRECT_URI,
  PORT = 3000,
} = process.env;

const app = express();

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
  if (!code) return res.status(400).send("Missing code.");

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
      return res.status(400).send("Token exchange failed.");
    }

    // Get the user's identity
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();

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
      return res.status(500).send("Verified, but role assignment failed.");
    }

    res.send("Verification complete. You can close this tab.");
  } catch (err) {
    console.error(err);
    res.status(500).send("Something went wrong.");
  }
});

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
