const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  AttachmentBuilder,
} = require('discord.js');

// ============================================================
// 1. قاعدة البيانات (SQLite)
// ============================================================
const Database = require('better-sqlite3');
const db = new Database('data.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS done_counts (
    admin_id TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS active_leaves (
    user_id TEXT PRIMARY KEY,
    end_date INTEGER
  );
  CREATE TABLE IF NOT EXISTS admin_ratings (
    admin_id TEXT PRIMARY KEY,
    satisfied INTEGER DEFAULT 0,
    dissatisfied INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS presence_points (
    admin_id TEXT PRIMARY KEY,
    points INTEGER DEFAULT 0
  );
`);

// ============================================================
// 2. قراءة المتغيرات البيئية
// ============================================================
const {
  BOT_TOKEN,
  GUILD_ID,
  WAITING_CHANNEL_ID,
  ADMIN_ROLE_ID,
  CITIZEN_ROLE_ID,
} = process.env;

if (!BOT_TOKEN || !GUILD_ID || !WAITING_CHANNEL_ID || !ADMIN_ROLE_ID) {
  console.error('❌ تأكد من تعبئة المتغيرات التالية في بيئة التشغيل:');
  console.error('BOT_TOKEN, GUILD_ID, WAITING_CHANNEL_ID, ADMIN_ROLE_ID');
  process.exit(1);
}

// ============================================================
// 3. المعرفات الثابتة
// ============================================================
const RATING_CHANNEL_ID = '1529482677516898555';
const LEAVE_EMBED_CHANNEL_ID = '1529495796247167178';
const LEAVE_PANEL_CHANNEL_ID = '1529440458030321714';
const LEAVE_ROLE_ID = '1459304469127758027';
const RESIGNATION_KEEP_ROLE_ID = '1476796533168017428';
const STAFF_ROLE_IDS = ['1459304407899443396', '1459304410923532481'];
const DONE_TEXT_CHANNEL_ID = '1529933848144510976';

const ADMIN_ROOM_IDS = [
  '1499105265272754246',
  '1499105221383819497',
  '1499105170716491806',
  '1525972362246226041',
  '1499105092933128212',
  '1499084679083720805',
  '1499352796435058848',
  '1499352980120403989',
  '1499353050907938916',
  '1499352946301730899',
  '1519516030899191809',
  '1519516058682130632',
];

const WAITING_CHANNEL_IDS = [
  ...WAITING_CHANNEL_ID.split(',').map(id => id.trim()).filter(Boolean),
  '1481398869463138604',
  '1519511668823167116'
];

const PRESENCE_INTERVAL = 15 * 60 * 1000; // 15 دقيقة
const MAX_LEAVE_DAYS = 14;

// ============================================================
// 4. دوال قاعدة البيانات
// ============================================================
function loadAdminRatings() {
  const stmt = db.prepare('SELECT admin_id, satisfied, dissatisfied FROM admin_ratings');
  const rows = stmt.all();
  const map = new Map();
  for (const row of rows) {
    map.set(row.admin_id, { satisfied: row.satisfied, dissatisfied: row.dissatisfied });
  }
  return map;
}

function saveAdminRating(adminId, type) {
  const existing = adminRatings.get(adminId) || { satisfied: 0, dissatisfied: 0 };
  if (type === 'satisfied') existing.satisfied += 1;
  else existing.dissatisfied += 1;
  adminRatings.set(adminId, existing);
  db.prepare('INSERT OR REPLACE INTO admin_ratings (admin_id, satisfied, dissatisfied) VALUES (?, ?, ?)')
    .run(adminId, existing.satisfied, existing.dissatisfied);
}

function loadPresencePoints() {
  const stmt = db.prepare('SELECT admin_id, points FROM presence_points');
  const rows = stmt.all();
  const map = new Map();
  for (const row of rows) map.set(row.admin_id, row.points);
  return map;
}

function savePresencePoints(adminId, points) {
  presencePoints.set(adminId, points);
  db.prepare('INSERT OR REPLACE INTO presence_points (admin_id, points) VALUES (?, ?)')
    .run(adminId, points);
}

function loadDoneCounts() {
  const stmt = db.prepare('SELECT admin_id, count FROM done_counts');
  const rows = stmt.all();
  const map = new Map();
  for (const row of rows) map.set(row.admin_id, row.count);
  return map;
}

function saveDoneCounts() {
  db.prepare('DELETE FROM done_counts').run();
  const insert = db.prepare('INSERT INTO done_counts (admin_id, count) VALUES (?, ?)');
  const trans = db.transaction((entries) => {
    for (const [id, count] of entries) insert.run(id, count);
  });
  trans(doneCounts.entries());
}

function loadActiveLeaves() {
  const stmt = db.prepare('SELECT user_id, end_date FROM active_leaves');
  const rows = stmt.all();
  const map = new Map();
  for (const row of rows) map.set(row.user_id, { endDate: row.end_date });
  return map;
}

function saveActiveLeaves() {
  db.prepare('DELETE FROM active_leaves').run();
  const insert = db.prepare('INSERT INTO active_leaves (user_id, end_date) VALUES (?, ?)');
  const trans = db.transaction((entries) => {
    for (const [userId, data] of entries) insert.run(userId, data.endDate);
  });
  trans(activeLeaves.entries());
}

// تحميل البيانات
const doneCounts = loadDoneCounts();
const activeLeaves = loadActiveLeaves();
const adminRatings = loadAdminRatings();
const presencePoints = loadPresencePoints();
const evaluatedSessions = new Set();

// ============================================================
// 5. دوال مساعدة
// ============================================================
function hasStaffRole(member) {
  return STAFF_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId));
}

function isMutedOrDeafened(vs) {
  if (!vs) return false;
  return vs.selfMute || vs.selfDeaf || vs.serverMute || vs.serverDeaf;
}

function isDeafened(vs) {
  if (!vs) return false;
  return vs.selfDeaf || vs.serverDeaf;
}

// ============================================================
// 6. نظام الطابور
// ============================================================
const activeSessions = new Map();
const adminPresenceTimers = new Map();

function getWaitingList(guild) {
  const list = [];
  for (const waitingId of WAITING_CHANNEL_IDS) {
    const channel = guild.channels.cache.get(waitingId);
    if (!channel || !channel.members) continue;
    for (const [, member] of channel.members) {
      if (!isMutedOrDeafened(member.voice)) {
        list.push(member);
      }
    }
  }
  return list;
}

function getNextInQueue(guild) {
  const list = getWaitingList(guild);
  return list.length > 0 ? list[0] : null;
}

// ============================================================
// 7. نظام نقاط التواجد الصوتي
// ============================================================
function startPresenceTimer(adminId, guild) {
  if (adminPresenceTimers.has(adminId)) return;
  const interval = setInterval(() => {
    const member = guild.members.cache.get(adminId);
    if (!member) {
      clearInterval(interval);
      adminPresenceTimers.delete(adminId);
      return;
    }
    const voice = member.voice;
    if (!voice.channel || !ADMIN_ROOM_IDS.includes(voice.channel.id) || isDeafened(voice)) {
      clearInterval(interval);
      adminPresenceTimers.delete(adminId);
      return;
    }
    const current = presencePoints.get(adminId) || 0;
    savePresencePoints(adminId, current + 1);
    console.log(`⏱️ +1 نقطة تواجد للإداري ${member.user.tag}`);
  }, PRESENCE_INTERVAL);
  adminPresenceTimers.set(adminId, interval);
}

// ============================================================
// 8. نظام السحب التلقائي
// ============================================================
const pullLocks = new Set();

async function tryPullForAllFreeAdmins(guild) {
  for (const roomId of ADMIN_ROOM_IDS) {
    const channel = guild.channels.cache.get(roomId);
    if (!channel) continue;
    if (pullLocks.has(channel.id)) continue;

    const members = [...channel.members.values()];
    if (members.length !== 1) continue;
    const admin = members[0];
    if (!admin.roles.cache.has(ADMIN_ROLE_ID) || isDeafened(admin.voice)) continue;

    const candidate = getNextInQueue(guild);
    if (!candidate) continue;

    pullLocks.add(channel.id);
    try {
      await candidate.voice.setChannel(channel.id, 'سحب تلقائي');
      activeSessions.set(candidate.id, { adminId: admin.id, startTime: Date.now() });
      console.log(`✅ تم سحب ${candidate.user.tag} إلى ${channel.name}`);

      // رسالة للمواطن
      try {
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('🎙️ استعد لجلسة الدعم')
          .setDescription(`سيتم نقلك إلى روم الدعم (Support) بعد لحظات مع المسؤول\n<@${admin.id}>`)
          .setFooter({ text: 'جهز ملاحظاتك وأسئلتك قبل بدء الجلسة' })
          .setTimestamp();
        await candidate.user.send({ embeds: [embed] });
      } catch (e) {}

      updateWaitingBoard(guild);
      startPresenceTimer(admin.id, guild);

    } catch (err) {
      console.error(`⚠️ فشل سحب ${candidate.user.tag}:`, err.message);
    } finally {
      pullLocks.delete(channel.id);
    }
  }
}

// ============================================================
// 9. لوحة الانتظار
// ============================================================
let boardMessage = null;
const SERVER_LOGO_PATH = path.join(__dirname, 'server_logo.png');
const SERVER_LOGO_FILENAME = 'server_logo.png';

async function updateWaitingBoard(guild) {
  const waitingList = getWaitingList(guild);
  const status = waitingList.length > 0 ? '🟡 Busy' : '🟢 Available';
  const boardChannel = guild.channels.cache.get(LEAVE_EMBED_CHANNEL_ID);
  if (!boardChannel) return;

  let attachment = null;
  try {
    if (fs.existsSync(SERVER_LOGO_PATH)) {
      attachment = new AttachmentBuilder(SERVER_LOGO_PATH, { name: SERVER_LOGO_FILENAME });
    }
  } catch (e) {
    console.warn('⚠️ صورة السيرفر غير موجودة');
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📋 Live Support Board')
    .setDescription(
      `**Support Status:** ${status}\n` +
      `**Players Waiting:** ${waitingList.length}\n\n` +
      `**Current Waiting List:**\n` +
      (waitingList.length > 0
        ? waitingList.map((m, i) => `${i+1}. ${m.user}`).join('\n')
        : 'لا يوجد لاعبين في الانتظار') +
      `\n\nPlease stay in the voice channel;\nyou will be pulled automatically\nwhen an admin is available.`
    )
    .setFooter({ text: 'Live board - updates automatically' })
    .setTimestamp();

  if (attachment) {
    embed.setThumbnail(`attachment://${SERVER_LOGO_FILENAME}`);
  }

  try {
    if (boardMessage) {
      await boardMessage.edit({
        embeds: [embed],
        files: attachment ? [attachment] : []
      });
    } else {
      const msg = await boardChannel.send({
        embeds: [embed],
        files: attachment ? [attachment] : []
      });
      boardMessage = msg;
    }
  } catch (e) {
    console.error('❌ خطأ في تحديث اللوحة:', e);
  }
}

// ============================================================
// 10. العميل
// ============================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ============================================================
// 11. أحداث البوت
// ============================================================

client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 البوت شغال باسم ${c.user.tag}`);
  try {
    const commands = [
      { name: 'send_leave_panel', description: 'إرسال لوحة طلبات الإجازات والاستقالات' },
      { name: 'active_leaves', description: 'عرض قائمة الإداريين المجازين' },
      { name: 'top_done', description: 'عرض أكثر 10 إداريين إنجازاً' },
      { name: 'all_dones', description: 'عرض إحصائيات جميع الإداريين' },
      {
        name: 'add_done',
        description: 'إضافة عدد من الـ Done لإداري',
        options: [
          { name: 'admin', description: 'اختر الإداري', type: 6, required: true },
          { name: 'amount', description: 'عدد الـ Done للإضافة', type: 4, required: true }
        ]
      },
      {
        name: 'remove_done',
        description: 'خصم عدد من الـ Done من إداري',
        options: [
          { name: 'admin', description: 'اختر الإداري', type: 6, required: true },
          { name: 'amount', description: 'عدد الـ Done للخصم', type: 4, required: true }
        ]
      },
      { name: 'reset_all', description: 'تصفير جميع إحصائيات الـ Done' },
      { name: 'admin_ratings', description: 'عرض تقييمات الإداريين' },
      { name: 'presence_points', description: 'عرض نقاط التواجد الصوتي للإداريين' },
    ];
    await c.application.commands.set(commands, GUILD_ID);
    console.log('✅ تم تسجيل الأوامر.');
  } catch (error) {
    console.error('❌ خطأ في تسجيل الأوامر:', error);
  }

  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild) {
    await updateWaitingBoard(guild);
    setInterval(() => updateWaitingBoard(guild), 30000);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.guild && message.channelId === LEAVE_EMBED_CHANNEL_ID) {
    if (message.author.bot) return;
    if (!hasStaffRole(message.member)) {
      try { await message.delete(); } catch (e) {}
    }
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild || guild.id !== GUILD_ID) return;
  const userId = newState.id;

  if (WAITING_CHANNEL_IDS.includes(newState.channelId) && !WAITING_CHANNEL_IDS.includes(oldState.channelId)) {
    await updateWaitingBoard(guild);
  }
  if (WAITING_CHANNEL_IDS.includes(oldState.channelId) && !WAITING_CHANNEL_IDS.includes(newState.channelId)) {
    await updateWaitingBoard(guild);
  }

  if (ADMIN_ROOM_IDS.includes(newState.channelId) && newState.channelId !== oldState.channelId) {
    const member = guild.members.cache.get(userId);
    if (member && hasStaffRole(member)) {
      await tryPullForAllFreeAdmins(guild);
      if (!isDeafened(newState)) {
        startPresenceTimer(userId, guild);
      }
    }
  }

  if (ADMIN_ROOM_IDS.includes(oldState.channelId) || isDeafened(newState)) {
    if (adminPresenceTimers.has(userId)) {
      clearInterval(adminPresenceTimers.get(userId));
      adminPresenceTimers.delete(userId);
    }
  }

  if (activeSessions.has(userId) && newState.channelId !== oldState.channelId) {
    const { adminId, startTime } = activeSessions.get(userId);
    activeSessions.delete(userId);

    const durationSec = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(durationSec / 60);
    const secs = durationSec % 60;
    const durationText = mins > 0 ? `${mins} دقيقة و ${secs} ثانية` : `${secs} ثانية`;

    const current = (doneCounts.get(adminId) || 0) + 1;
    doneCounts.set(adminId, current);
    saveDoneCounts();

    let logMsg = null;
    try {
      const channel = guild.channels.cache.get(DONE_TEXT_CHANNEL_ID);
      if (channel) {
        const embed = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle('✅ تم إنهاء خدمة مواطن (Done)')
          .addFields(
            { name: '👤 المواطن', value: `<@${userId}>`, inline: true },
            { name: '🛡️ الإداري', value: `<@${adminId}>`, inline: true },
            { name: '📊 مجموع الـ Done', value: `\`${current}\``, inline: true },
            { name: '⏱️ المدة', value: `\`${durationText}\``, inline: true }
          )
          .setTimestamp();
        logMsg = await channel.send({ embeds: [embed] });
      }
    } catch (e) { console.error('❌ خطأ في إرسال سجل الـ Done:', e); }

    try {
      const user = await client.users.fetch(userId);
      const logId = logMsg ? logMsg.id : 'none';
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`satisfied_${adminId}_${logId}`)
          .setLabel('😊 راضي')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`dissatisfied_${adminId}_${logId}`)
          .setLabel('😞 غير راضي')
          .setStyle(ButtonStyle.Danger)
      );
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('📝 تقييم الخدمة')
        .setDescription(`تم الانتهاء من خدمتك بواسطة <@${adminId}> في مدة ${durationText}.\nهل أنت راضي عن جودة الدعم؟`)
        .setFooter({ text: 'اختر تقييمك' })
        .setTimestamp();
      await user.send({ embeds: [embed], components: [row] });
    } catch (err) {
      console.error('⚠️ تعذر إرسال رسالة التقييم:', err);
    }

    await updateWaitingBoard(guild);
  }

  await tryPullForAllFreeAdmins(guild);
});

// ============================================================
// 12. الأوامر والأزرار
// ============================================================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    const customId = interaction.customId; // تعريف مسبق لتجنب undefined

    // --------------------------------------------------------
    // أزرار التقييم (راضي / غير راضي)
    // --------------------------------------------------------
    if (interaction.isButton() && customId && (customId.startsWith('satisfied_') || customId.startsWith('dissatisfied_'))) {
      const parts = customId.split('_');
      const type = parts[0];
      const adminId = parts[1];
      const logId = parts[2];

      if (evaluatedSessions.has(logId)) {
        return interaction.reply({
          content: '⚠️ تم تقييم هذه الخدمة مسبقاً.',
          flags: MessageFlags.Ephemeral
        });
      }
      evaluatedSessions.add(logId);

      saveAdminRating(adminId, type);

      const ratingText = type === 'satisfied' ? '😊 راضي' : '😞 غير راضي';
      await interaction.update({ content: `✅ شكراً لتقييمك! (${ratingText})`, embeds: [], components: [] });

      try {
        const guild = client.guilds.cache.get(GUILD_ID);
        const channel = guild.channels.cache.get(RATING_CHANNEL_ID);
        if (channel) {
          const embed = new EmbedBuilder()
            .setColor(type === 'satisfied' ? 0x2ecc71 : 0xe74c3c)
            .setAuthor({ name: `${interaction.user.username} قيّم الخدمة`, iconURL: interaction.user.displayAvatarURL() })
            .setTitle('🌟 تقييم إداري')
            .addFields(
              { name: 'المواطن', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'الإداري', value: `<@${adminId}>`, inline: true },
              { name: 'التقييم', value: ratingText, inline: true }
            )
            .setTimestamp();
          await channel.send({ embeds: [embed] });
        }
      } catch (e) { console.error('❌ خطأ في إرسال التقييم:', e); }

      try {
        if (logId && logId !== 'none') {
          const guild = client.guilds.cache.get(GUILD_ID);
          const channel = guild.channels.cache.get(DONE_TEXT_CHANNEL_ID);
          if (channel) {
            const msg = await channel.messages.fetch(logId);
            if (msg) {
              const embed = EmbedBuilder.from(msg.embeds[0]);
              embed.addFields({ name: '⭐ التقييم', value: ratingText, inline: true });
              await msg.edit({ embeds: [embed] });
            }
          }
        }
      } catch (e) { console.error('❌ خطأ في تحديث سجل التقييم:', e); }
      return;
    }

    // --------------------------------------------------------
    // أزرار فتح المودالات
    // --------------------------------------------------------
    if (interaction.isButton() && customId === 'open_leave_modal') {
      const modal = new ModalBuilder()
        .setCustomId('leave_modal')
        .setTitle('📄 طلب إجازة');

      const durationInput = new TextInputBuilder()
        .setCustomId('leave_duration')
        .setLabel(`عدد أيام الإجازة (أقصى حد ${MAX_LEAVE_DAYS} أيام)`)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('مثال: 3')
        .setRequired(true)
        .setMaxLength(2);

      const reasonInput = new TextInputBuilder()
        .setCustomId('leave_reason')
        .setLabel('سبب الإجازة')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('اكتب سبب طلب الإجازة بالتفصيل')
        .setRequired(true)
        .setMaxLength(500);

      modal.addComponents(
        new ActionRowBuilder().addComponents(durationInput),
        new ActionRowBuilder().addComponents(reasonInput)
      );

      await interaction.showModal(modal);
      return;
    }

    if (interaction.isButton() && customId === 'open_resign_modal') {
      const modal = new ModalBuilder()
        .setCustomId('resign_modal')
        .setTitle('📝 طلب استقالة');

      const reasonInput = new TextInputBuilder()
        .setCustomId('resign_reason')
        .setLabel('سبب الاستقالة')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('اكتب سبب تقديم الاستقالة بالتفصيل')
        .setRequired(true)
        .setMaxLength(500);

      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));

      await interaction.showModal(modal);
      return;
    }

    if (interaction.isButton() && customId === 'open_break_modal') {
      const modal = new ModalBuilder()
        .setCustomId('break_modal')
        .setTitle('🔓 طلب كسر إجازة');

      const reasonInput = new TextInputBuilder()
        .setCustomId('break_reason')
        .setLabel('سبب كسر الإجازة')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('اكتب سبب كسر الإجازة بالتفصيل')
        .setRequired(true)
        .setMaxLength(500);

      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));

      await interaction.showModal(modal);
      return;
    }

    // --------------------------------------------------------
    // أزرار قبول/رفض الطلبات
    // --------------------------------------------------------
    if (interaction.isButton() && customId && (customId.startsWith('req_accept_') || customId.startsWith('req_reject_'))) {
      if (!hasStaffRole(interaction.member)) {
        return interaction.reply({
          content: '❌ هذا الإجراء خاص بأصحاب صلاحية الإدارة فقط.',
          flags: MessageFlags.Ephemeral
        });
      }

      const parts = customId.split('_');
      const decision = parts[1];
      const reqType = parts[2];
      const requesterId = parts[3];

      const isAccept = decision === 'accept';
      const decisionLabel = isAccept ? '✅ تم القبول' : '❌ تم الرفض';
      const decisionColor = isAccept ? 0x2ecc71 : 0xe74c3c;

      const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
      const fields = originalEmbed.data.fields || [];
      const statusIndex = fields.findIndex((f) => f.name.includes('الحالة') || f.name.includes('Status'));
      const statusValue = `\`\`\`\n${decisionLabel} بواسطة ${interaction.user.username}\n\`\`\``;

      if (statusIndex >= 0) {
        fields[statusIndex].value = statusValue;
      } else {
        fields.push({ name: 'الحالة', value: statusValue });
      }

      originalEmbed.setFields(fields);
      originalEmbed.setColor(decisionColor);

      const oldComponents = interaction.message.components[0].components;
      const disabledRow = new ActionRowBuilder().addComponents(
        oldComponents.map((btn) => ButtonBuilder.from(btn).setDisabled(true))
      );

      await interaction.update({ embeds: [originalEmbed], components: [disabledRow] });

      let roleActionNote = '';
      if (isAccept) {
        try {
          const targetMember = await interaction.guild.members.fetch(requesterId);

          if (reqType === 'leave') {
            await targetMember.roles.add(LEAVE_ROLE_ID, 'قبول طلب إجازة');
            roleActionNote = `\n🏷️ تم تحديث حالتك إلى: **Out of service ✈️**`;

            const durationField = originalEmbed.data.fields.find(f => f.name.includes('المدة'));
            if (durationField) {
              const match = durationField.value.match(/\d+/);
              if (match) {
                const durationDays = parseInt(match[0]);
                const endDate = Date.now() + (durationDays * 24 * 60 * 60 * 1000);
                activeLeaves.set(requesterId, { endDate });
                saveActiveLeaves();
              }
            }

          } else if (reqType === 'resign') {
            await targetMember.roles.set([RESIGNATION_KEEP_ROLE_ID], 'قبول طلب استقالة');
            roleActionNote = `\n🏷️ تم تحديث حالتك إلى: **𝗪𝗵𝗶𝘁𝗲𝗹𝗶𝘀𝘁𝗲𝗱**`;
          } else if (reqType === 'break') {
            if (targetMember.roles.cache.has(LEAVE_ROLE_ID)) {
              await targetMember.roles.remove(LEAVE_ROLE_ID, 'قبول طلب كسر إجازة');
              roleActionNote = `\n🏷️ تم سحب رتبة <@&${LEAVE_ROLE_ID}> منك (العودة من الإجازة).`;
            }
            if (activeLeaves.has(requesterId)) {
              activeLeaves.delete(requesterId);
              saveActiveLeaves();
            }
          }
        } catch (roleErr) {
          console.error('⚠️ خطأ أثناء تعديل الرتب:', roleErr);
        }
      }

      try {
        const requesterUser = await client.users.fetch(requesterId);
        const typeLabels = { leave: 'إجازة', resign: 'استقالة', break: 'كسر إجازة' };
        const typeLabel = typeLabels[reqType] || 'إجازة';

        const dmEmbed = new EmbedBuilder()
          .setTitle(isAccept ? '🎉 تم قبول طلبك' : '❌ تم رفض طلبك')
          .setColor(isAccept ? 0x2ecc71 : 0xe74c3c)
          .setDescription(
            isAccept
              ? `تهانينا! تم قبول طلب **الـ ${typeLabel}** الخاص بك.${roleActionNote}`
              : `للأسف، تم رفض طلب **الـ ${typeLabel}** الخاص بك.`
          )
          .addFields(
            { name: 'المسؤول', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'نوع الطلب', value: `طلب ${typeLabel}`, inline: true }
          )
          .setTimestamp();

        await requesterUser.send({ embeds: [dmEmbed] });
      } catch (e) {
        console.error('⚠️ تعذر إرسال الرسالة لخاص العضو.');
      }
      return;
    }

    // --------------------------------------------------------
    // المودالات
    // --------------------------------------------------------
    if (interaction.isModalSubmit()) {
      const requestsChannel = await interaction.guild.channels.fetch(LEAVE_PANEL_CHANNEL_ID);

      const buildApplicationEmbed = (typeTitle, fieldsData) => {
        return new EmbedBuilder()
          .setColor(0x2f3136)
          .setTitle(`📨 A new application has been submitted. (${typeTitle})`)
          .setDescription(`**From:** <@${interaction.user.id}>\n\`( ${interaction.user.username} )\``)
          .addFields(fieldsData)
          .setFooter({
            text: `Submitted by ${interaction.user.username}`,
            iconURL: interaction.user.displayAvatarURL({ dynamic: true })
          })
          .setTimestamp();
      };

      if (interaction.customId === 'leave_modal') {
        const durationRaw = interaction.fields.getTextInputValue('leave_duration').trim();
        const reason = interaction.fields.getTextInputValue('leave_reason').trim();
        const duration = Number(durationRaw);

        if (!Number.isInteger(duration) || duration < 1) {
          return await interaction.reply({
            content: '❌ لازم تكتب عدد أيام صحيح (رقم صحيح 1 أو أكثر).',
            flags: MessageFlags.Ephemeral
          });
        }

        if (duration > MAX_LEAVE_DAYS) {
          return await interaction.reply({
            content: `❌ ما يصير تطلب إجازة أكثر من ${MAX_LEAVE_DAYS} أيام. الرجاء إعادة المحاولة بمدة أقل.`,
            flags: MessageFlags.Ephemeral
          });
        }

        const embed = buildApplicationEmbed('طلب إجازة', [
          { name: 'المدة', value: `\`\`\`\n${duration} ${duration === 1 ? 'يوم' : 'أيام'}\n\`\`\`` },
          { name: 'سبب الإجازة', value: `\`\`\`\n${reason}\n\`\`\`` },
          { name: 'الحالة', value: `\`\`\`\n⏳ بانتظار مراجعة الإدارة\n\`\`\`` }
        ]);

        const decisionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`req_accept_leave_${interaction.user.id}`)
            .setLabel('قبول')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`req_reject_leave_${interaction.user.id}`)
            .setLabel('رفض')
            .setStyle(ButtonStyle.Danger)
        );

        await requestsChannel.send({ embeds: [embed], components: [decisionRow] });

        return await interaction.reply({
          content: '✅ تم إرسال طلب الإجازة بنجاح إلى روم المسؤولين، بانتظار مراجعة الإدارة.',
          flags: MessageFlags.Ephemeral
        });
      }

      if (interaction.customId === 'resign_modal') {
        const reason = interaction.fields.getTextInputValue('resign_reason').trim();

        const embed = buildApplicationEmbed('طلب استقالة', [
          { name: 'سبب الاستقالة', value: `\`\`\`\n${reason}\n\`\`\`` },
          { name: 'الحالة', value: `\`\`\`\n⏳ بانتظار مراجعة الإدارة\n\`\`\`` }
        ]);

        const decisionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`req_accept_resign_${interaction.user.id}`)
            .setLabel('قبول')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`req_reject_resign_${interaction.user.id}`)
            .setLabel('رفض')
            .setStyle(ButtonStyle.Danger)
        );

        await requestsChannel.send({ embeds: [embed], components: [decisionRow] });

        return await interaction.reply({
          content: '✅ تم إرسال طلب الاستقالة بنجاح إلى روم المسؤولين، بانتظار مراجعة الإدارة.',
          flags: MessageFlags.Ephemeral
        });
      }

      if (interaction.customId === 'break_modal') {
        const reason = interaction.fields.getTextInputValue('break_reason').trim();

        const embed = buildApplicationEmbed('طلب كسر إجازة', [
          { name: 'سبب كسر الإجازة', value: `\`\`\`\n${reason}\n\`\`\`` },
          { name: 'الحالة', value: `\`\`\`\n⏳ بانتظار مراجعة الإدارة\n\`\`\`` }
        ]);

        const decisionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`req_accept_break_${interaction.user.id}`)
            .setLabel('قبول')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`req_reject_break_${interaction.user.id}`)
            .setLabel('رفض')
            .setStyle(ButtonStyle.Danger)
        );

        await requestsChannel.send({ embeds: [embed], components: [decisionRow] });

        return await interaction.reply({
          content: '✅ تم إرسال طلب كسر الإجازة بنجاح إلى روم المسؤولين، بانتظار مراجعة الإدارة.',
          flags: MessageFlags.Ephemeral
        });
      }
    }

    // --------------------------------------------------------
    // الأوامر (سلاش)
    // --------------------------------------------------------
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'send_leave_panel') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بالإدارة.', flags: MessageFlags.Ephemeral });
        }

        const panelEmbed = new EmbedBuilder()
          .setTitle('📋 نظام طلبات الإجازات والاستقالات')
          .setDescription(
            [
              'اختر نوع الطلب من الأزرار تحت:',
              '',
              `📄 **طلب إجازة** — بحد أقصى ${MAX_LEAVE_DAYS} أيام.`,
              '🔓 **طلب كسر إجازة** — للعودة من الإجازة مبكراً.',
              '📝 **طلب استقالة** — لتقديم استقالتك.',
            ].join('\n')
          )
          .setColor(0xC2410C)
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('open_leave_modal')
            .setLabel('طلب إجازة')
            .setEmoji('📄')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('open_break_modal')
            .setLabel('طلب كسر إجازة')
            .setEmoji('🔓')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('open_resign_modal')
            .setLabel('طلب استقالة')
            .setEmoji('📝')
            .setStyle(ButtonStyle.Danger)
        );

        const panelChannel = await interaction.guild.channels.fetch(LEAVE_EMBED_CHANNEL_ID);
        await panelChannel.send({ embeds: [panelEmbed], components: [row] });

        return interaction.reply({ content: '✅ تم إرسال اللوحة.', flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === 'active_leaves') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بالإدارة.', flags: MessageFlags.Ephemeral });
        }

        if (activeLeaves.size === 0) {
          return interaction.reply({ content: '🌴 لا يوجد إداري في إجازة حالياً.', flags: MessageFlags.Ephemeral });
        }

        let desc = '';
        let index = 1;
        for (const [userId, data] of activeLeaves) {
          const remaining = data.endDate - Date.now();
          if (remaining <= 0) {
            activeLeaves.delete(userId);
            saveActiveLeaves();
            continue;
          }
          const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
          const hours = Math.floor((remaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
          desc += `**${index}.** <@${userId}> — متبقي: \`${days} يوم و ${hours} ساعة\`\n`;
          index++;
        }
        if (!desc) desc = '✅ جميع الإجازات انتهت.';
        const embed = new EmbedBuilder().setTitle('📋 الإجازات النشطة').setColor(0x3ba55d).setDescription(desc);
        return interaction.reply({ embeds: [embed] });
      }

      if (interaction.commandName === 'top_done') {
        if (!hasStaffRole(interaction.member)) return interaction.reply({ content: '❌ غير مصرح.', flags: MessageFlags.Ephemeral });
        if (doneCounts.size === 0) return interaction.reply({ content: '📊 لا توجد إحصائيات.', flags: MessageFlags.Ephemeral });
        const sorted = [...doneCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        const desc = sorted.map(([id, count], i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**#${i+1}**`;
          return `${medal} - <@${id}> : \`${count}\` Done`;
        }).join('\n');
        const embed = new EmbedBuilder().setTitle('🏆 توب 10 إداريين').setColor(0xffd700).setDescription(desc);
        return interaction.reply({ embeds: [embed] });
      }

      if (interaction.commandName === 'all_dones') {
        if (!hasStaffRole(interaction.member)) return interaction.reply({ content: '❌ غير مصرح.', flags: MessageFlags.Ephemeral });
        if (doneCounts.size === 0) return interaction.reply({ content: '📊 لا توجد إحصائيات.', flags: MessageFlags.Ephemeral });
        const sorted = [...doneCounts.entries()].sort((a, b) => b[1] - a[1]);
        const desc = sorted.map(([id, count], i) => `**#${i+1}** - <@${id}> : \`${count}\` Done`).join('\n');
        const embed = new EmbedBuilder().setTitle('📊 جميع الإحصائيات').setColor(0x3498db).setDescription(desc.slice(0, 4000));
        return interaction.reply({ embeds: [embed] });
      }

      if (interaction.commandName === 'add_done') {
        if (!hasStaffRole(interaction.member)) return interaction.reply({ content: '❌ غير مصرح.', flags: MessageFlags.Ephemeral });
        const admin = interaction.options.getUser('admin');
        const amount = interaction.options.getInteger('amount');
        const current = doneCounts.get(admin.id) || 0;
        doneCounts.set(admin.id, current + amount);
        saveDoneCounts();
        return interaction.reply({ content: `✅ تم إضافة ${amount} إلى <@${admin.id}>. المجموع: ${current + amount}`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === 'remove_done') {
        if (!hasStaffRole(interaction.member)) return interaction.reply({ content: '❌ غير مصرح.', flags: MessageFlags.Ephemeral });
        const admin = interaction.options.getUser('admin');
        const amount = interaction.options.getInteger('amount');
        const current = doneCounts.get(admin.id) || 0;
        const newCount = Math.max(0, current - amount);
        doneCounts.set(admin.id, newCount);
        saveDoneCounts();
        return interaction.reply({ content: `✅ تم خصم ${amount} من <@${admin.id}>. المجموع: ${newCount}`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === 'reset_all') {
        if (!hasStaffRole(interaction.member)) return interaction.reply({ content: '❌ غير مصرح.', flags: MessageFlags.Ephemeral });
        doneCounts.clear();
        saveDoneCounts();
        return interaction.reply({ content: '🧹 تم تصفير جميع الإحصائيات.', flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === 'admin_ratings') {
        if (!hasStaffRole(interaction.member)) return interaction.reply({ content: '❌ غير مصرح.', flags: MessageFlags.Ephemeral });
        const list = [...adminRatings.entries()].sort((a, b) => (b[1].satisfied + b[1].dissatisfied) - (a[1].satisfied + a[1].dissatisfied));
        const desc = list.map(([id, data]) => {
          const total = data.satisfied + data.dissatisfied;
          const percent = total > 0 ? Math.round((data.satisfied / total) * 100) : 0;
          return `<@${id}>: 😊 ${data.satisfied} | 😞 ${data.dissatisfied} | (${percent}% رضا)`;
        }).join('\n') || 'لا توجد تقييمات بعد.';
        const embed = new EmbedBuilder().setTitle('📊 تقييمات الإداريين').setColor(0x5865f2).setDescription(desc);
        return interaction.reply({ embeds: [embed] });
      }

      if (interaction.commandName === 'presence_points') {
        if (!hasStaffRole(interaction.member)) return interaction.reply({ content: '❌ غير مصرح.', flags: MessageFlags.Ephemeral });
        const list = [...presencePoints.entries()].sort((a, b) => b[1] - a[1]);
        const desc = list.map(([id, points]) => `<@${id}>: 🏆 ${points} نقطة`).join('\n') || 'لا توجد نقاط بعد.';
        const embed = new EmbedBuilder().setTitle('🎯 نقاط التواجد الصوتي').setColor(0xf1a10c).setDescription(desc);
        return interaction.reply({ embeds: [embed] });
      }
    }
  } catch (error) {
    console.error('❌ خطأ في التفاعل:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ حدث خطأ.', flags: MessageFlags.Ephemeral }).catch(() => null);
    }
  }
});

client.login(BOT_TOKEN);
