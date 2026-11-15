import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";

export const kick = {
  data: new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member from the server")
    .addUserOption((o) =>
      o.setName("user").setDescription("Member to kick").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("reason").setDescription("Reason for the kick")
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
  async execute(interaction) {
    const user = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason") || "No reason provided";

    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member)
      return interaction.reply({ content: "That user isn't in this server.", ephemeral: true });
    if (!member.kickable)
      return interaction.reply({
        content: "I can't kick that member — check role hierarchy.",
        ephemeral: true,
      });

    await member.kick(reason);
    await interaction.reply(`Kicked **${user.tag}** — ${reason}`);
  },
};

export const ban = {
  data: new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member from the server")
    .addUserOption((o) =>
      o.setName("user").setDescription("Member to ban").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("reason").setDescription("Reason for the ban")
    )
    .addIntegerOption((o) =>
      o
        .setName("delete_days")
        .setDescription("Delete this many days of their messages (0-7)")
        .setMinValue(0)
        .setMaxValue(7)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  async execute(interaction) {
    const user = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason") || "No reason provided";
    const deleteDays = interaction.options.getInteger("delete_days") || 0;

    try {
      await interaction.guild.members.ban(user.id, {
        reason,
        deleteMessageSeconds: deleteDays * 86400,
      });
      await interaction.reply(`Banned **${user.tag}** — ${reason}`);
    } catch {
      await interaction.reply({
        content: "I couldn't ban that user — check role hierarchy or permissions.",
        ephemeral: true,
      });
    }
  },
};

export const mute = {
  data: new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Timeout a member for a set duration")
    .addUserOption((o) =>
      o.setName("user").setDescription("Member to mute").setRequired(true)
    )
    .addIntegerOption((o) =>
      o
        .setName("minutes")
        .setDescription("Duration in minutes (max 40320 = 28 days)")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(40320)
    )
    .addStringOption((o) =>
      o.setName("reason").setDescription("Reason for the mute")
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  async execute(interaction) {
    const user = interaction.options.getUser("user");
    const minutes = interaction.options.getInteger("minutes");
    const reason = interaction.options.getString("reason") || "No reason provided";

    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member)
      return interaction.reply({ content: "That user isn't in this server.", ephemeral: true });
    if (!member.moderatable)
      return interaction.reply({
        content: "I can't timeout that member — check role hierarchy.",
        ephemeral: true,
      });

    await member.timeout(minutes * 60 * 1000, reason);
    await interaction.reply(`Muted **${user.tag}** for ${minutes} minute(s) — ${reason}`);
  },
};

export const unmute = {
  data: new SlashCommandBuilder()
    .setName("unmute")
    .setDescription("Remove an active timeout from a member")
    .addUserOption((o) =>
      o.setName("user").setDescription("Member to unmute").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  async execute(interaction) {
    const user = interaction.options.getUser("user");
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member)
      return interaction.reply({ content: "That user isn't in this server.", ephemeral: true });

    await member.timeout(null);
    await interaction.reply(`Removed timeout from **${user.tag}**.`);
  },
};

export const warn = {
  data: new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Log a warning against a member")
    .addUserOption((o) =>
      o.setName("user").setDescription("Member to warn").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("reason").setDescription("Reason for the warning").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  async execute(interaction, { redis }) {
    const user = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");

    const key = `warns:${interaction.guild.id}:${user.id}`;
    const entry = JSON.stringify({
      reason,
      by: interaction.user.tag,
      at: new Date().toISOString(),
    });
    await redis.rpush(key, entry);

    await interaction.reply(`Warned **${user.tag}** — ${reason}`);
  },
};

export const altcheck = {
  data: new SlashCommandBuilder()
    .setName("altcheck")
    .setDescription("Show accounts linked to a member via shared IP")
    .addUserOption((o) =>
      o.setName("user").setDescription("Member to check").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  async execute(interaction, { redis }) {
    const user = interaction.options.getUser("user");
    const alts = await redis.hgetall(`alts:${user.id}`);

    if (!alts || Object.keys(alts).length === 0)
      return interaction.reply({
        content: `No linked accounts found for **${user.tag}**.`,
        ephemeral: true,
      });

    const lines = Object.entries(alts).map(
      ([altId, altName]) => `${altName} — \`${altId}\``
    );

    await interaction.reply({
      content: `**Accounts linked to ${user.tag} (${user.id}):**\n${lines.join("\n")}`,
      ephemeral: true,
    });
  },
};

export const warnings = {
  data: new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("List warnings logged against a member")
    .addUserOption((o) =>
      o.setName("user").setDescription("Member to check").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  async execute(interaction, { redis }) {
    const user = interaction.options.getUser("user");
    const key = `warns:${interaction.guild.id}:${user.id}`;
    const raw = await redis.lrange(key, 0, -1);

    if (!raw || raw.length === 0)
      return interaction.reply({ content: `${user.tag} has no warnings.`, ephemeral: true });

    const lines = raw.map((r, i) => {
      const w = typeof r === "string" ? JSON.parse(r) : r;
      return `${i + 1}. ${w.reason} — by ${w.by} (${new Date(w.at).toLocaleDateString()})`;
    });

    await interaction.reply({
      content: `**Warnings for ${user.tag}:**\n${lines.join("\n")}`,
      ephemeral: true,
    });
  },
};
