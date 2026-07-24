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
// 3. المعرفات الثابتة (من سيرفرك)
// ============================================================
const RATING_CHANNEL_ID = '1529482677516898555'; // روم التقييمات
const LEAVE_EMBED_CHANNEL_ID = '1529495796247167178'; // روم لوحة الإجازات
const LEAVE_PANEL_CHANNEL_ID = '1529440458030321714'; // روم طلبات الإدارة
const LEAVE_ROLE_ID = '1459304469127758027';
const RESIGNATION_KEEP_ROLE_ID = '1476796533168017428';
const STAFF_ROLE_IDS = ['1459304407899443396', '1459304410923532481'];
const DONE_TEXT_CHANNEL_ID = '1529933848144510976'; // روم سجلات الإدارة
const SUPPORT_CATEGORY_ID = '1499354167646228480'; // كاتاقوري رومات الدعم (اختياري)

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
// 4. دوال قاعدة البيانات (للميزات الجديدة)
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
// 6. نظام الطابور (Queue)
// ============================================================
const waitingQueue = [];
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
// 8. نظام السحب التلقائي (باستخدام الطابور)
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

      // إرسال رسالة للمواطن (استعد للجلسة)
      try {
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('🎙️ استعد لجلسة الدعم')
          .setDescription(`سيتم نقلك إلى روم الدعم (Support) بعد لحظات مع المسؤول\n<@${admin.id}>`)
          .setFooter({ text: 'جهز ملاحظاتك وأسئلتك قبل بدء الجلسة' })
          .setTimestamp();
        await candidate.user.send({ embeds: [embed] });
      } catch (e) {}

      // تحديث لوحة الانتظار
      updateWaitingBoard(guild);

      // بدء عداد نقاط التواجد للإداري
      startPresenceTimer(admin.id, guild);

    } catch (err) {
      console.error(`⚠️ فشل سحب ${candidate.user.tag}:`, err.message);
    } finally {
      pullLocks.delete(channel.id);
    }
  }
}

// ============================================================
// 9. لوحة الانتظار (Board)
// ============================================================
let boardMessage = null;

async function updateWaitingBoard(guild) {
  const waitingList = getWaitingList(guild);
  const status = waitingList.length > 0 ? '🟡 مشغول' : '🟢 متاح';
  const boardChannel = guild.channels.cache.get(LEAVE_EMBED_CHANNEL_ID);
  if (!boardChannel) return;

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

  try {
    if (boardMessage) {
      await boardMessage.edit({ embeds: [embed] });
    } else {
      const msg = await boardChannel.send({ embeds: [embed] });
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

// عند الجاهزية
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
      { name: 'admin_ratings', description: 'عرض تقييمات الإداريين (راضي/غير راضي)' },
      { name: 'presence_points', description: 'عرض نقاط التواجد الصوتي للإداريين' },
    ];
    await c.application.commands.set(commands, GUILD_ID);
    console.log('✅ تم تسجيل الأوامر.');
  } catch (error) {
    console.error('❌ خطأ في تسجيل الأوامر:', error);
  }

  // إرسال لوحة الانتظار عند التشغيل
  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild) {
    await updateWaitingBoard(guild);
    // تحديث اللوحة كل 30 ثانية
    setInterval(() => updateWaitingBoard(guild), 30000);
  }
});

// حماية روم الإجازات
client.on(Events.MessageCreate, async (message) => {
  if (message.guild && message.channelId === LEAVE_EMBED_CHANNEL_ID) {
    if (message.author.bot) return;
    if (!hasStaffRole(message.member)) {
      try { await message.delete(); } catch (e) {}
    }
  }
});

// حركة الصوت (السحب والتقييم ونقاط التواجد)
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild || guild.id !== GUILD_ID) return;
  const userId = newState.id;

  // إذا دخل عضو إلى روم الانتظار، نحدث اللوحة
  if (WAITING_CHANNEL_IDS.includes(newState.channelId) && !WAITING_CHANNEL_IDS.includes(oldState.channelId)) {
    await updateWaitingBoard(guild);
  }

  // إذا خرج عضو من روم الانتظار
  if (WAITING_CHANNEL_IDS.includes(oldState.channelId) && !WAITING_CHANNEL_IDS.includes(newState.channelId)) {
    await updateWaitingBoard(guild);
  }

  // إذا دخل إداري إلى روم دعم، نحاول السحب
  if (ADMIN_ROOM_IDS.includes(newState.channelId) && newState.channelId !== oldState.channelId) {
    const member = guild.members.cache.get(userId);
    if (member && hasStaffRole(member)) {
      await tryPullForAllFreeAdmins(guild);
      // بدء عداد النقاط
      if (!isDeafened(newState)) {
        startPresenceTimer(userId, guild);
      }
    }
  }

  // إذا غادر إداري روم الدعم أو عطل الصوت، نوقف عداد النقاط
  if (ADMIN_ROOM_IDS.includes(oldState.channelId) || isDeafened(newState)) {
    if (adminPresenceTimers.has(userId)) {
      clearInterval(adminPresenceTimers.get(userId));
      adminPresenceTimers.delete(userId);
    }
  }

  // نهاية جلسة الدعم (خروج المواطن من روم الإداري)
  if (activeSessions.has(userId) && newState.channelId !== oldState.channelId) {
    const { adminId, startTime } = activeSessions.get(userId);
    activeSessions.delete(userId);

    const durationSec = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(durationSec / 60);
    const secs = durationSec % 60;
    const durationText = mins > 0 ? `${mins} دقيقة و ${secs} ثانية` : `${secs} ثانية`;

    // تحديث إحصائيات الـ Done
    const current = (doneCounts.get(adminId) || 0) + 1;
    doneCounts.set(adminId, current);
    saveDoneCounts();

    // إرسال سجل الـ Done (مع رابط للتقييم)
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

    // إرسال رسالة تقييم جديدة (راضي / غير راضي)
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
        .setImage('https://your-image-url.com/rating.png') // يمكنك تغييره
        .setFooter({ text: 'اختر تقييمك' })
        .setTimestamp();
      await user.send({ embeds: [embed], components: [row] });
    } catch (err) {
      console.error('⚠️ تعذر إرسال رسالة التقييم:', err);
    }

    // تحديث لوحة الانتظار
    await updateWaitingBoard(guild);
  }

  // محاولة السحب لأي إداري فاضي بعد كل تغيير
  await tryPullForAllFreeAdmins(guild);
});

// ============================================================
// 12. الأوامر والأزرار (بما فيها نظام التقييم الجديد)
// ============================================================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // --------------------------------------------------------
    // أزرار التقييم (راضي / غير راضي)
    // --------------------------------------------------------
    if (interaction.isButton() && (interaction.customId.startsWith('satisfied_') || interaction.customId.startsWith('dissatisfied_'))) {
      const parts = interaction.customId.split('_');
      const type = parts[0]; // satisfied or dissatisfied
      const adminId = parts[1];
      const logId = parts[2];

      if (evaluatedSessions.has(logId)) {
        return interaction.reply({
          content: '⚠️ تم تقييم هذه الخدمة مسبقاً.',
          flags: MessageFlags.Ephemeral
        });
      }
      evaluatedSessions.add(logId);

      // حفظ التقييم
      saveAdminRating(adminId, type);

      const ratingText = type === 'satisfied' ? '😊 راضي' : '😞 غير راضي';
      await interaction.update({ content: `✅ شكراً لتقييمك! (${ratingText})`, embeds: [], components: [] });

      // إرسال التقييم لروم التقييمات
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

      // تحديث سجل الـ Done
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
    // باقي الأزرار (طلب إجازة، استقالة، كسر إجازة، قبول/رفض)
    // --------------------------------------------------------
    if (interaction.customId === 'open_leave_modal') {
      // ... (نفس الكود القديم)
    }
    if (interaction.customId === 'open_resign_modal') {
      // ... (نفس الكود القديم)
    }
    if (interaction.customId === 'open_break_modal') {
      // ... (نفس الكود القديم)
    }
    if (interaction.customId.startsWith('req_accept_') || interaction.customId.startsWith('req_reject_')) {
      // ... (نفس الكود القديم مع إضافة استخدام MessageFlags بدلاً من ephemeral)
    }

    // --------------------------------------------------------
    // المودالات (نفس الكود القديم)
    // --------------------------------------------------------
    if (interaction.isModalSubmit()) {
      // ... (نفس الكود القديم)
    }

    // --------------------------------------------------------
    // الأوامر الجديدة
    // --------------------------------------------------------
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'admin_ratings') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({
            content: '❌ هذا الأمر خاص بالإدارة.',
            flags: MessageFlags.Ephemeral
          });
        }
        const list = [...adminRatings.entries()]
          .sort((a, b) => (b[1].satisfied + b[1].dissatisfied) - (a[1].satisfied + a[1].dissatisfied));
        const desc = list.map(([id, data]) => {
          const total = data.satisfied + data.dissatisfied;
          const percent = total > 0 ? Math.round((data.satisfied / total) * 100) : 0;
          return `<@${id}>: 😊 ${data.satisfied} | 😞 ${data.dissatisfied} | (${percent}% رضا)`;
        }).join('\n') || 'لا توجد تقييمات بعد.';
        const embed = new EmbedBuilder()
          .setTitle('📊 تقييمات الإداريين')
          .setColor(0x5865f2)
          .setDescription(desc)
          .setTimestamp();
        return interaction.reply({ embeds: [embed] });
      }

      if (interaction.commandName === 'presence_points') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({
            content: '❌ هذا الأمر خاص بالإدارة.',
            flags: MessageFlags.Ephemeral
          });
        }
        const list = [...presencePoints.entries()].sort((a, b) => b[1] - a[1]);
        const desc = list.map(([id, points]) => {
          return `<@${id}>: 🏆 ${points} نقطة`;
        }).join('\n') || 'لا توجد نقاط تواجد مسجلة بعد.';
        const embed = new EmbedBuilder()
          .setTitle('🎯 نقاط التواجد الصوتي')
          .setColor(0xf1a10c)
          .setDescription(desc)
          .setTimestamp();
        return interaction.reply({ embeds: [embed] });
      }

      // ... (باقي الأوامر القديمة: send_leave_panel, active_leaves, top_done, all_dones, add_done, remove_done, reset_all)
    }
  } catch (error) {
    console.error('❌ خطأ في التفاعل:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ حدث خطأ.', flags: MessageFlags.Ephemeral }).catch(() => null);
    }
  }
});

client.login(BOT_TOKEN);
