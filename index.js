require('dotenv').config();
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
  PermissionFlagsBits,
  AttachmentBuilder,
} = require('discord.js');

// ===== قاعدة بيانات SQLite =====
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
  CREATE TABLE IF NOT EXISTS presence_points (
    admin_id TEXT PRIMARY KEY,
    points INTEGER DEFAULT 0,
    last_update INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id TEXT,
    citizen_id TEXT,
    rating INTEGER,
    comment TEXT,
    timestamp INTEGER
  );
  CREATE TABLE IF NOT EXISTS queue (
    position INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE,
    join_time INTEGER
  );
`);

// ===== المتغيرات البيئية =====
const {
  BOT_TOKEN,
  GUILD_ID,
  WAITING_CHANNEL_ID,
  ADMIN_ROLE_ID,
  SUPPORT_CATEGORY_ID,
  LOG_CHANNEL_ID,
  BOARD_CHANNEL_ID,
} = process.env;

if (!BOT_TOKEN || !GUILD_ID || !WAITING_CHANNEL_ID || !ADMIN_ROLE_ID) {
  console.error('❌ تأكد من تعبئة جميع المتغيرات في ملف .env');
  process.exit(1);
}

// ===== إعدادات ثابتة =====
const STAFF_ROLE_IDS = ['1459304407899443396', '1459304410923532481'];
const SUPPORT_ROOM_IDS = [
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
const WAITING_IDS = WAITING_CHANNEL_ID.split(',').map(id => id.trim()).filter(Boolean);
const POINTS_INTERVAL = 15 * 60 * 1000; // 15 دقيقة
const RATING_COOLDOWN = 30 * 60 * 1000; // 30 دقيقة بين التقييمات

// ===== دوال قاعدة البيانات =====
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

function loadPresencePoints() {
  const stmt = db.prepare('SELECT admin_id, points, last_update FROM presence_points');
  const rows = stmt.all();
  const map = new Map();
  for (const row of rows) map.set(row.admin_id, { points: row.points, lastUpdate: row.last_update });
  return map;
}

function savePresencePoints() {
  db.prepare('DELETE FROM presence_points').run();
  const insert = db.prepare('INSERT INTO presence_points (admin_id, points, last_update) VALUES (?, ?, ?)');
  const trans = db.transaction((entries) => {
    for (const [id, data] of entries) insert.run(id, data.points, data.lastUpdate);
  });
  trans(presencePoints.entries());
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

function addRating(adminId, citizenId, rating, comment = '') {
  const stmt = db.prepare('INSERT INTO ratings (admin_id, citizen_id, rating, comment, timestamp) VALUES (?, ?, ?, ?, ?)');
  stmt.run(adminId, citizenId, rating, comment, Date.now());
}

function getAdminRatings(adminId) {
  const stmt = db.prepare('SELECT rating FROM ratings WHERE admin_id = ?');
  const rows = stmt.all(adminId);
  if (rows.length === 0) return { avg: 0, count: 0 };
  const sum = rows.reduce((a, r) => a + r.rating, 0);
  return { avg: sum / rows.length, count: rows.length };
}

function getQueue() {
  const stmt = db.prepare('SELECT user_id, join_time FROM queue ORDER BY position ASC');
  return stmt.all();
}

function addToQueue(userId) {
  const exists = db.prepare('SELECT user_id FROM queue WHERE user_id = ?').get(userId);
  if (exists) return false;
  const stmt = db.prepare('INSERT INTO queue (user_id, join_time) VALUES (?, ?)');
  stmt.run(userId, Date.now());
  return true;
}

function removeFromQueue(userId) {
  const stmt = db.prepare('DELETE FROM queue WHERE user_id = ?');
  stmt.run(userId);
}

function getQueuePosition(userId) {
  const stmt = db.prepare('SELECT position FROM queue WHERE user_id = ?');
  const row = stmt.get(userId);
  return row ? row.position : null;
}

// ===== تحميل البيانات =====
const doneCounts = loadDoneCounts();
const presencePoints = loadPresencePoints();
const activeLeaves = loadActiveLeaves();
const evaluatedLogs = new Set();

// ===== دوال مساعدة =====
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

function ratingStarsBar(rating) {
  return '⭐'.repeat(rating) + '☆'.repeat(5 - rating);
}

function ratingColor(rating) {
  if (rating >= 4) return 0x2ecc71;
  if (rating >= 2) return 0xf1a10c;
  return 0xed4245;
}

function ratingLabel(rating) {
  const labels = { 1: 'ضعيف جداً', 2: 'ضعيف', 3: 'متوسط', 4: 'جيد', 5: 'ممتاز' };
  return labels[rating] || '';
}

// ===== دوال البورد =====
async function updateBoard(guild) {
  const channel = guild.channels.cache.get(BOARD_CHANNEL_ID);
  if (!channel) return;
  const queue = getQueue();
  const waitingCount = queue.length;
  const waitingNames = queue.map((q, i) => `${i + 1}. <@${q.user_id}>`).join('\n') || 'لا يوجد أحد';

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('# 🎙️ نظام الدعم الصوتي')
    .setDescription(`**حالة الدعم:** ${waitingCount > 0 ? '🟢 مشغول' : '🟢 متاح'}\n**اللاعبين في الانتظار:** ${waitingCount}`)
    .addFields(
      { name: '📋 قائمة الانتظار', value: waitingNames, inline: false },
      { name: '⏳ تنبيه', value: 'يرجى البقاء في روم الانتظار، سيتم سحبك تلقائياً عند توفر إداري.', inline: false }
    )
    .setFooter({ text: 'يتم التحديث تلقائياً - ' + new Date().toLocaleString() });

  const messages = await channel.messages.fetch({ limit: 10 });
  const botMsg = messages.find(m => m.author.bot && m.embeds.length > 0);
  if (botMsg) {
    await botMsg.edit({ embeds: [embed] });
  } else {
    await channel.send({ embeds: [embed] });
  }
}

// ===== العميل =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const pullLocks = new Set();
const activeSessions = new Map();
const presenceTimers = new Map();

// ============================================================
// الأحداث
// ============================================================

// تسجيل الأوامر
client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 البوت شغال باسم ${c.user.tag}`);
  try {
    const commands = [
      { name: 'queue', description: 'عرض قائمة الانتظار الحالية' },
      { name: 'board', description: 'إرسال لوحة الدعم في الروم المخصص' },
      { name: 'leave', description: 'طلب إجازة (للإداريين فقط)' },
      { name: 'resign', description: 'طلب استقالة (للإداريين فقط)' },
      { name: 'break_leave', description: 'طلب كسر إجازة (للإداريين فقط)' },
      { name: 'active_leaves', description: 'عرض الإداريين في إجازة' },
      { name: 'done_stats', description: 'عرض إحصائيات الـ Done' },
      { name: 'points', description: 'عرض نقاط التواجد الخاصة بك' },
      { name: 'points_leaderboard', description: 'عرض ترتيب النقاط' },
      { name: 'add_done', description: 'إضافة Done لإداري', options: [{ name: 'admin', type: 6, required: true }, { name: 'amount', type: 4, required: true }] },
      { name: 'remove_done', description: 'خصم Done من إداري', options: [{ name: 'admin', type: 6, required: true }, { name: 'amount', type: 4, required: true }] },
      { name: 'reset_all', description: 'تصفير جميع الإحصائيات' },
    ];
    await c.application.commands.set(commands, GUILD_ID);
    console.log('✅ تم تسجيل الأوامر.');
  } catch (error) {
    console.error('❌ خطأ في تسجيل الأوامر:', error);
  }

  // تحديث البورد كل 30 ثانية
  setInterval(() => {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) updateBoard(guild);
  }, 30000);
});

// حركة الصوت (الطابور، السحب، النقاط، التقييم)
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild || guild.id !== GUILD_ID) return;
  const userId = newState.id;
  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;

  // ===== 1. إدارة الطابور =====
  // دخول إلى روم الانتظار
  if (newChannelId && WAITING_IDS.includes(newChannelId) && !oldChannelId) {
    const member = await guild.members.fetch(userId);
    if (!member.roles.cache.has(ADMIN_ROLE_ID)) {
      addToQueue(userId);
      console.log(`➕ تم إضافة ${member.user.tag} إلى الطابور`);
      await updateBoard(guild);
    }
  }
  // خروج من روم الانتظار
  if (oldChannelId && WAITING_IDS.includes(oldChannelId) && !newChannelId) {
    removeFromQueue(userId);
    console.log(`➖ تم إزالة ${userId} من الطابور`);
    await updateBoard(guild);
  }

  // ===== 2. السحب التلقائي =====
  if (newChannelId && SUPPORT_ROOM_IDS.includes(newChannelId)) {
    const channel = guild.channels.cache.get(newChannelId);
    const members = [...channel.members.values()];
    if (members.length === 1 && members[0].roles.cache.has(ADMIN_ROLE_ID)) {
      const queue = getQueue();
      if (queue.length > 0) {
        const next = queue[0];
        const citizen = await guild.members.fetch(next.user_id);
        if (citizen && citizen.voice.channel && WAITING_IDS.includes(citizen.voice.channel.id)) {
          try {
            await citizen.voice.setChannel(newChannelId, 'سحب تلقائي إلى الدعم');
            removeFromQueue(citizen.id);
            activeSessions.set(citizen.id, { adminId: members[0].id, startTime: Date.now() });
            console.log(`✅ تم سحب ${citizen.user.tag} إلى ${channel.name}`);

            // إرسال إشعار للمواطن
            try {
              const embed = new EmbedBuilder()
                .setColor(0x5865f2)
                .setTitle('🎙️ تم سحبك إلى الدعم')
                .setDescription(`تم سحبك إلى روم الدعم **${channel.name}** مع الإداري <@${members[0].id}>.\nجهّز ملاحظاتك وأسئلتك، وابدأ الجلسة.`);
              await citizen.send({ embeds: [embed] });
            } catch (e) {}

            await updateBoard(guild);
          } catch (err) {
            console.error(`⚠️ فشل سحب ${citizen.user.tag}:`, err.message);
          }
        }
      }
    }
  }

  // ===== 3. نظام نقاط التواجد =====
  if (newChannelId && SUPPORT_ROOM_IDS.includes(newChannelId)) {
    const member = await guild.members.fetch(userId);
    if (member.roles.cache.has(ADMIN_ROLE_ID) && !isMutedOrDeafened(newState)) {
      if (!presenceTimers.has(userId)) {
        const timer = setInterval(() => {
          const data = presencePoints.get(userId) || { points: 0, lastUpdate: Date.now() };
          data.points += 1;
          data.lastUpdate = Date.now();
          presencePoints.set(userId, data);
          savePresencePoints();
          console.log(`⭐ تم إضافة نقطة للإداري ${member.user.tag}`);
        }, POINTS_INTERVAL);
        presenceTimers.set(userId, timer);
      }
    }
  }
  if (oldChannelId && SUPPORT_ROOM_IDS.includes(oldChannelId) && (!newChannelId || !SUPPORT_ROOM_IDS.includes(newChannelId))) {
    if (presenceTimers.has(userId)) {
      clearInterval(presenceTimers.get(userId));
      presenceTimers.delete(userId);
      console.log(`⏹️ توقفت نقاط التواجد للإداري ${userId}`);
    }
  }

  // ===== 4. إنهاء الجلسة وتسجيل الـ Done والتقييم =====
  if (activeSessions.has(userId) && newChannelId !== oldChannelId) {
    const { adminId, startTime } = activeSessions.get(userId);
    activeSessions.delete(userId);

    const durationSec = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(durationSec / 60);
    const secs = durationSec % 60;
    const durationText = mins > 0 ? `${mins} دقيقة و ${secs} ثانية` : `${secs} ثانية`;

    const current = (doneCounts.get(adminId) || 0) + 1;
    doneCounts.set(adminId, current);
    saveDoneCounts();

    // إرسال سجل الـ Done
    let logMsg = null;
    try {
      const channel = guild.channels.cache.get(LOG_CHANNEL_ID);
      if (channel) {
        const embed = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle('✅ تم إنهاء خدمة مواطن (Done)')
          .addFields(
            { name: '👤 المواطن', value: `<@${userId}>`, inline: true },
            { name: '🛡️ الإداري', value: `<@${adminId}>`, inline: true },
            { name: '📊 مجموع الـ Done', value: `\`${current}\``, inline: true },
            { name: '⏱️ المدة', value: `\`${durationText}\``, inline: true },
            { name: '⭐ التقييم', value: '⏳ بانتظار تقييم المواطن...', inline: false }
          )
          .setTimestamp();
        logMsg = await channel.send({ embeds: [embed] });
      }
    } catch (e) { console.error('❌ خطأ في إرسال سجل الـ Done:', e); }

    // إرسال رسالة تقييم خاصة للمواطن
    try {
      const user = await client.users.fetch(userId);
      const logId = logMsg ? logMsg.id : 'none';
      const row = new ActionRowBuilder().addComponents(
        [1,2,3,4,5].map(r => new ButtonBuilder()
          .setCustomId(`rate_${r}_${adminId}_${logId}`)
          .setLabel(`${r}⭐`)
          .setStyle(r === 5 ? ButtonStyle.Success : ButtonStyle.Secondary))
      );
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('📝 تقييم الخدمة')
        .setDescription(`تم الانتهاء من خدمتك بواسطة <@${adminId}> في مدة ${durationText}.\nقيم المساعدة:`);
      await user.send({ embeds: [embed], components: [row] });
    } catch (err) {
      if (logMsg) {
        try {
          const embed = EmbedBuilder.from(logMsg.embeds[0]);
          const fields = embed.data.fields;
          fields[4].value = '❌ الخاص مغلق (لم يتم التقييم)';
          embed.setFields(fields);
          await logMsg.edit({ embeds: [embed] });
        } catch (e) {}
      }
    }
  }
});

// ============================================================
// التفاعلات
// ============================================================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ===== أزرار التقييم =====
    if (interaction.isButton() && interaction.customId.startsWith('rate_')) {
      const parts = interaction.customId.split('_');
      const rating = parseInt(parts[1]);
      const adminId = parts[2];
      const logId = parts[3];
      const stars = ratingStarsBar(rating);

      if (evaluatedLogs.has(logId)) {
        return interaction.reply({ content: '⚠️ تم تقييم هذه الخدمة مسبقاً.', ephemeral: true });
      }
      evaluatedLogs.add(logId);

      // حفظ التقييم في قاعدة البيانات
      addRating(adminId, interaction.user.id, rating);

      await interaction.update({ content: `✅ شكراً لتقييمك! (${stars})`, embeds: [], components: [] });

      // إرسال التقييم إلى روم اللوق
      try {
        const guild = client.guilds.cache.get(GUILD_ID);
        const channel = guild.channels.cache.get(LOG_CHANNEL_ID);
        if (channel) {
          const embed = new EmbedBuilder()
            .setColor(ratingColor(rating))
            .setAuthor({ name: `${interaction.user.username} قيّم الخدمة`, iconURL: interaction.user.displayAvatarURL() })
            .setTitle('🌟 تقييم إداري')
            .addFields(
              { name: 'المواطن', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'الإداري', value: `<@${adminId}>`, inline: true },
              { name: '⭐ التقييم', value: `${stars}\n\`${rating}/5\` — ${ratingLabel(rating)}`, inline: false }
            )
            .setTimestamp();
          await channel.send({ embeds: [embed] });
        }
      } catch (e) { console.error('❌ خطأ في إرسال التقييم:', e); }

      // تحديث سجل الـ Done
      try {
        if (logId && logId !== 'none') {
          const guild = client.guilds.cache.get(GUILD_ID);
          const channel = guild.channels.cache.get(LOG_CHANNEL_ID);
          if (channel) {
            const msg = await channel.messages.fetch(logId);
            if (msg) {
              const embed = EmbedBuilder.from(msg.embeds[0]);
              const fields = embed.data.fields;
              fields[4].value = stars;
              embed.setFields(fields);
              await msg.edit({ embeds: [embed] });
            }
          }
        }
      } catch (e) { console.error('❌ خطأ في تحديث سجل التقييم:', e); }
      return;
    }

    // ===== زر إنهاء الجلسة =====
    if (interaction.isButton() && interaction.customId === 'end_session') {
      const member = interaction.member;
      if (!hasStaffRole(member)) {
        return interaction.reply({ content: '❌ هذا الزر خاص بالإداريين فقط.', ephemeral: true });
      }
      const voiceChannel = member.voice.channel;
      if (!voiceChannel || !SUPPORT_ROOM_IDS.includes(voiceChannel.id)) {
        return interaction.reply({ content: '❌ يجب أن تكون في روم دعم لإنهاء الجلسة.', ephemeral: true });
      }
      const citizens = [...voiceChannel.members.values()].filter(m => !hasStaffRole(m));
      if (citizens.length === 0) {
        return interaction.reply({ content: '⚠️ لا يوجد مواطن في روم الدعم لإنهاء جلساته.', ephemeral: true });
      }
      for (const citizen of citizens) {
        try {
          await citizen.voice.setChannel(null, 'إنهاء الجلسة من قبل الإداري');
          // سيتم تسجيل الـ Done تلقائياً عبر حدث VoiceStateUpdate
        } catch (e) {
          console.error('❌ فشل إخراج المواطن:', e);
        }
      }
      await interaction.reply({ content: `✅ تم إنهاء الجلسة وإخراج ${citizens.length} مواطن.`, ephemeral: true });
      return;
    }

    // ===== الأوامر =====
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      // 1. عرض الطابور
      if (commandName === 'queue') {
        const queue = getQueue();
        if (queue.length === 0) {
          return interaction.reply({ content: '📭 لا يوجد أحد في قائمة الانتظار حالياً.', ephemeral: true });
        }
        const list = queue.map((q, i) => `${i + 1}. <@${q.user_id}>`).join('\n');
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📋 قائمة الانتظار')
          .setDescription(list)
          .setFooter({ text: `إجمالي المنتظرين: ${queue.length}` });
        return interaction.reply({ embeds: [embed] });
      }

      // 2. إرسال البورد
      if (commandName === 'board') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر للإدارة فقط.', ephemeral: true });
        }
        await updateBoard(interaction.guild);
        return interaction.reply({ content: '✅ تم تحديث لوحة الدعم.', ephemeral: true });
      }

      // 3. طلب إجازة
      if (commandName === 'leave') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر للإدارة فقط.', ephemeral: true });
        }
        // فتح مودال
        const modal = new ModalBuilder()
          .setCustomId('leave_modal')
          .setTitle('📄 طلب إجازة');
        const durationInput = new TextInputBuilder()
          .setCustomId('leave_duration')
          .setLabel('عدد الأيام (أقصى 14)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('مثال: 3')
          .setRequired(true)
          .setMaxLength(2);
        const reasonInput = new TextInputBuilder()
          .setCustomId('leave_reason')
          .setLabel('السبب')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('اكتب سبب الإجازة')
          .setRequired(true)
          .setMaxLength(500);
        modal.addComponents(
          new ActionRowBuilder().addComponents(durationInput),
          new ActionRowBuilder().addComponents(reasonInput)
        );
        return await interaction.showModal(modal);
      }

      // 4. طلب استقالة
      if (commandName === 'resign') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر للإدارة فقط.', ephemeral: true });
        }
        const modal = new ModalBuilder()
          .setCustomId('resign_modal')
          .setTitle('📝 طلب استقالة');
        const reasonInput = new TextInputBuilder()
          .setCustomId('resign_reason')
          .setLabel('السبب')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('اكتب سبب الاستقالة')
          .setRequired(true)
          .setMaxLength(500);
        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        return await interaction.showModal(modal);
      }

      // 5. طلب كسر إجازة
      if (commandName === 'break_leave') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر للإدارة فقط.', ephemeral: true });
        }
        const modal = new ModalBuilder()
          .setCustomId('break_modal')
          .setTitle('🔓 طلب كسر إجازة');
        const reasonInput = new TextInputBuilder()
          .setCustomId('break_reason')
          .setLabel('السبب')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('اكتب سبب كسر الإجازة')
          .setRequired(true)
          .setMaxLength(500);
        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        return await interaction.showModal(modal);
      }

      // 6. عرض الإجازات النشطة
      if (commandName === 'active_leaves') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر للإدارة فقط.', ephemeral: true });
        }
        if (activeLeaves.size === 0) {
          return interaction.reply({ content: '🌴 لا يوجد إداري في إجازة حالياً.', ephemeral: true });
        }
        let desc = '';
        for (const [userId, data] of activeLeaves.entries()) {
          const remaining = data.endDate - Date.now();
          if (remaining <= 0) {
            activeLeaves.delete(userId);
            saveActiveLeaves();
            continue;
          }
          const days = Math.floor(remaining / (1000*60*60*24));
          const hours = Math.floor((remaining % (1000*60*60*24)) / (1000*60*60));
          desc += `<@${userId}> — متبقي ${days} يوم و ${hours} ساعة\n`;
        }
        const embed = new EmbedBuilder()
          .setColor(0x3ba55d)
          .setTitle('🌴 الإجازات النشطة')
          .setDescription(desc || '✅ جميع الإجازات انتهت.')
          .setTimestamp();
        return interaction.reply({ embeds: [embed] });
      }

      // 7. إحصائيات الـ Done
      if (commandName === 'done_stats') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر للإدارة فقط.', ephemeral: true });
        }
        if (doneCounts.size === 0) {
          return interaction.reply({ content: '📊 لا توجد إحصائيات مسجلة.', ephemeral: true });
        }
        const sorted = [...doneCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        const desc = sorted.map(([id, count], i) => `**#${i+1}** <@${id}> — \`${count}\``).join('\n');
        const embed = new EmbedBuilder()
          .setColor(0xffd700)
          .setTitle('🏆 توب 10 إداريين (Done)')
          .setDescription(desc);
        return interaction.reply({ embeds: [embed] });
      }

      // 8. نقاط التواجد الخاصة
      if (commandName === 'points') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر للإدارة فقط.', ephemeral: true });
        }
        const data = presencePoints.get(interaction.user.id);
        const points = data ? data.points : 0;
        const avgRating = getAdminRatings(interaction.user.id);
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📊 نقاط التواجد')
          .setDescription(`لديك **${points}** نقطة تواجد.\nمتوسط تقييمك: **${avgRating.avg.toFixed(1)}/5** من ${avgRating.count} تقييم.`);
        return interaction.reply({ embeds: [embed] });
      }

      // 9. ترتيب النقاط
      if (commandName === 'points_leaderboard') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر للإدارة فقط.', ephemeral: true });
        }
        const sorted = [...presencePoints.entries()].sort((a, b) => b[1].points - a[1].points).slice(0, 10);
        if (sorted.length === 0) {
          return interaction.reply({ content: '📊 لا توجد نقاط مسجلة.', ephemeral: true });
        }
        const desc = sorted.map(([id, data], i) => `**#${i+1}** <@${id}> — \`${data.points}\` نقطة`).join('\n');
        const embed = new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle('🏅 ترتيب نقاط التواجد')
          .setDescription(desc);
        return interaction.reply({ embeds: [embed] });
      }

      // 10. إضافة Done (للإدارة العليا)
      if (commandName === 'add_done') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ صلاحية الإدارة مطلوبة.', ephemeral: true });
        }
        const admin = interaction.options.getUser('admin');
        const amount = interaction.options.getInteger('amount');
        const current = doneCounts.get(admin.id) || 0;
        doneCounts.set(admin.id, current + amount);
        saveDoneCounts();
        return interaction.reply({ content: `✅ تم إضافة ${amount} إلى <@${admin.id}> (المجموع: ${current + amount})`, ephemeral: true });
      }

      // 11. خصم Done
      if (commandName === 'remove_done') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ صلاحية الإدارة مطلوبة.', ephemeral: true });
        }
        const admin = interaction.options.getUser('admin');
        const amount = interaction.options.getInteger('amount');
        const current = doneCounts.get(admin.id) || 0;
        const newCount = Math.max(0, current - amount);
        doneCounts.set(admin.id, newCount);
        saveDoneCounts();
        return interaction.reply({ content: `✅ تم خصم ${amount} من <@${admin.id}> (المجموع: ${newCount})`, ephemeral: true });
      }

      // 12. تصفير الكل
      if (commandName === 'reset_all') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ صلاحية الإدارة مطلوبة.', ephemeral: true });
        }
        doneCounts.clear();
        saveDoneCounts();
        presencePoints.clear();
        savePresencePoints();
        db.prepare('DELETE FROM ratings').run();
        return interaction.reply({ content: '🧹 تم تصفير جميع الإحصائيات.', ephemeral: true });
      }
    }

    // ===== المودالات =====
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'leave_modal') {
        const duration = parseInt(interaction.fields.getTextInputValue('leave_duration'));
        const reason = interaction.fields.getTextInputValue('leave_reason');
        if (duration < 1 || duration > 14) {
          return interaction.reply({ content: '❌ المدة بين 1 و 14 يوماً.', ephemeral: true });
        }
        const endDate = Date.now() + duration * 24 * 60 * 60 * 1000;
        activeLeaves.set(interaction.user.id, { endDate });
        saveActiveLeaves();
        // إضافة رتبة الإجازة (اختياري)
        try {
          const member = await interaction.guild.members.fetch(interaction.user.id);
          const leaveRoleId = '1459304469127758027'; // غيرها حسب رتبتك
          await member.roles.add(leaveRoleId);
        } catch (e) {}
        return interaction.reply({ content: `✅ تم قبول إجازتك لمدة ${duration} يوماً.`, ephemeral: true });
      }
      if (interaction.customId === 'resign_modal') {
        // معالجة الاستقالة
        return interaction.reply({ content: '📝 تم تقديم طلب الاستقالة.', ephemeral: true });
      }
      if (interaction.customId === 'break_modal') {
        if (activeLeaves.has(interaction.user.id)) {
          activeLeaves.delete(interaction.user.id);
          saveActiveLeaves();
          // إزالة رتبة الإجازة
          try {
            const member = await interaction.guild.members.fetch(interaction.user.id);
            const leaveRoleId = '1459304469127758027';
            await member.roles.remove(leaveRoleId);
          } catch (e) {}
          return interaction.reply({ content: '✅ تم كسر الإجازة والعودة للعمل.', ephemeral: true });
        }
        return interaction.reply({ content: '❌ أنت لست في إجازة حالياً.', ephemeral: true });
      }
    }

  } catch (error) {
    console.error('❌ خطأ في التفاعل:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ حدث خطأ.', ephemeral: true }).catch(() => null);
    }
  }
});

client.login(BOT_TOKEN);
