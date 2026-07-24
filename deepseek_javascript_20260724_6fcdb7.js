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

// إنشاء الجداول
db.exec(`
  CREATE TABLE IF NOT EXISTS done_counts (
    admin_id TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id TEXT,
    citizen_id TEXT,
    rating INTEGER,
    timestamp INTEGER
  );
  CREATE TABLE IF NOT EXISTS presence_points (
    admin_id TEXT PRIMARY KEY,
    points INTEGER DEFAULT 0,
    last_update INTEGER
  );
  CREATE TABLE IF NOT EXISTS active_sessions (
    citizen_id TEXT PRIMARY KEY,
    admin_id TEXT,
    start_time INTEGER
  );
  CREATE TABLE IF NOT EXISTS waiting_queue (
    position INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE,
    joined_at INTEGER
  );
`);

// ===== المتغيرات البيئية =====
const {
  BOT_TOKEN,
  GUILD_ID,
  WAITING_CHANNEL_ID,
  ADMIN_ROLE_ID,
  SUPPORT_CHANNEL_IDS, // قائمة رومات الدعم (مفصولة بفاصلة)
  BOARD_CHANNEL_ID,
  LOG_CHANNEL_ID,
  SUPPORT_CATEGORY_ID,
  CITIZEN_ROLE_ID,
} = process.env;

if (!BOT_TOKEN || !GUILD_ID || !WAITING_CHANNEL_ID || !ADMIN_ROLE_ID) {
  console.error('❌ تأكد من تعبئة جميع المتغيرات في ملف .env');
  process.exit(1);
}

// ===== إعدادات =====
const WAITING_CHANNEL_IDS = WAITING_CHANNEL_ID.split(',').map(id => id.trim()).filter(Boolean);
const SUPPORT_ROOM_IDS = SUPPORT_CHANNEL_IDS ? SUPPORT_CHANNEL_IDS.split(',').map(id => id.trim()).filter(Boolean) : [];
const BOARD_UPDATE_INTERVAL = 10000; // 10 ثوانٍ لتحديث البورد

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
  const stmt = db.prepare('SELECT admin_id, points FROM presence_points');
  const rows = stmt.all();
  const map = new Map();
  for (const row of rows) map.set(row.admin_id, row.points);
  return map;
}

function savePresencePoints() {
  db.prepare('DELETE FROM presence_points').run();
  const insert = db.prepare('INSERT INTO presence_points (admin_id, points) VALUES (?, ?)');
  const trans = db.transaction((entries) => {
    for (const [id, points] of entries) insert.run(id, points);
  });
  trans(presencePoints.entries());
}

function getQueue() {
  const stmt = db.prepare('SELECT user_id, joined_at FROM waiting_queue ORDER BY position ASC');
  return stmt.all();
}

function addToQueue(userId) {
  const stmt = db.prepare('INSERT OR IGNORE INTO waiting_queue (user_id, joined_at) VALUES (?, ?)');
  stmt.run(userId, Date.now());
}

function removeFromQueue(userId) {
  const stmt = db.prepare('DELETE FROM waiting_queue WHERE user_id = ?');
  stmt.run(userId);
}

function isInQueue(userId) {
  const stmt = db.prepare('SELECT 1 FROM waiting_queue WHERE user_id = ?');
  return !!stmt.get(userId);
}

function getQueuePosition(userId) {
  const stmt = db.prepare('SELECT position FROM waiting_queue WHERE user_id = ?');
  const row = stmt.get(userId);
  return row ? row.position : null;
}

function clearQueue() {
  db.prepare('DELETE FROM waiting_queue').run();
}

function saveRating(adminId, citizenId, rating) {
  const stmt = db.prepare('INSERT INTO ratings (admin_id, citizen_id, rating, timestamp) VALUES (?, ?, ?, ?)');
  stmt.run(adminId, citizenId, rating, Date.now());
}

function getAdminRating(adminId) {
  const stmt = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as count FROM ratings WHERE admin_id = ?');
  return stmt.get(adminId);
}

const doneCounts = loadDoneCounts();
const presencePoints = loadPresencePoints();

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

// ===== متغيرات الجلسات =====
const activeSessions = new Map(); // citizenId -> { adminId, startTime }
const adminPresence = new Map(); // adminId -> { channelId, startTime, interval }
const pullLocks = new Set();

// ===== دالة تحديث البورد =====
async function updateBoard(guild) {
  const boardChannel = guild.channels.cache.get(BOARD_CHANNEL_ID);
  if (!boardChannel) return;

  const queue = getQueue();
  const waitingCount = queue.length;
  const queueList = queue.map((row, i) => `${i+1}. <@${row.user_id}>`).join('\n') || 'لا يوجد منتظرون حالياً.';

  // حساب عدد الإداريين المتاحين
  const adminMembers = guild.members.cache.filter(m => m.roles.cache.has(ADMIN_ROLE_ID) && m.voice.channel);
  const availableAdmins = adminMembers.filter(m => {
    const channel = m.voice.channel;
    return SUPPORT_ROOM_IDS.includes(channel.id) && !m.voice.selfDeaf && !m.voice.serverDeaf;
  });

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('🎙️ نظام الدعم الصوتي - Live Support Board')
    .setDescription(
      `**حالة الدعم:** ${availableAdmins.size > 0 ? '🟢 متاح' : '🔴 مشغول'}\n` +
      `**اللاعبون المنتظرون:** ${waitingCount}\n\n` +
      `**قائمة الانتظار:**\n${queueList}`
    )
    .setFooter({ text: 'Live board - يتم التحديث تلقائياً' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('refresh_board')
      .setLabel('🔄 تحديث')
      .setStyle(ButtonStyle.Secondary)
  );

  // البحث عن رسالة البورد القديمة وحذفها
  const messages = await boardChannel.messages.fetch({ limit: 10 });
  const oldBoard = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0);
  if (oldBoard) {
    await oldBoard.edit({ embeds: [embed], components: [row] });
  } else {
    await boardChannel.send({ embeds: [embed], components: [row] });
  }
}

// ===== دالة إرسال إشعار للمواطن =====
async function notifyCitizen(userId, adminId) {
  try {
    const user = await client.users.fetch(userId);
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🎯 استعد لجلسة الدعم')
      .setDescription(
        `سيتم نقلـك إلى روم الدعم (Support) بعد لحظات.\n` +
        `المسؤول: <@${adminId}>\n\n` +
        `جهّز ملاحظاتك وأسئلتك قبل بدء الجلسة.`
      )
      .setFooter({ text: 'Emperors Town RP • نظام الدعم الصوتي' })
      .setTimestamp();
    await user.send({ embeds: [embed] });
  } catch (err) {
    console.error(`❌ فشل إرسال إشعار للمواطن ${userId}:`, err);
  }
}

// ===== دالة إنهاء الجلسة =====
async function endSession(guild, citizenId, adminId, logMessageId) {
  const session = activeSessions.get(citizenId);
  if (!session) return;

  const { startTime } = session;
  activeSessions.delete(citizenId);

  const durationSec = Math.floor((Date.now() - startTime) / 1000);
  const mins = Math.floor(durationSec / 60);
  const secs = durationSec % 60;
  const durationText = mins > 0 ? `${mins} دقيقة و ${secs} ثانية` : `${secs} ثانية`;

  // تحديث الـ Done
  const current = (doneCounts.get(adminId) || 0) + 1;
  doneCounts.set(adminId, current);
  saveDoneCounts();

  // إرسال سجل الـ Done
  let logMsg = null;
  try {
    const logChannel = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (logChannel) {
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ تم إنهاء خدمة مواطن (Done)')
        .addFields(
          { name: '👤 المواطن', value: `<@${citizenId}>`, inline: true },
          { name: '🛡️ الإداري', value: `<@${adminId}>`, inline: true },
          { name: '📊 مجموع الـ Done', value: `\`${current}\``, inline: true },
          { name: '⏱️ المدة', value: `\`${durationText}\``, inline: true }
        )
        .setTimestamp();
      logMsg = await logChannel.send({ embeds: [embed] });
    }
  } catch (e) { console.error('❌ خطأ في إرسال سجل الـ Done:', e); }

  // إرسال تقييم للمواطن
  try {
    const user = await client.users.fetch(citizenId);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rate_satisfied_${adminId}_${citizenId}`)
        .setLabel('✅ راضٍ')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`rate_unsatisfied_${adminId}_${citizenId}`)
        .setLabel('❌ غير راضٍ')
        .setStyle(ButtonStyle.Danger)
    );
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📝 تقييم الدعم الفني')
      .setDescription(`كيف تقيم مستوى المساعدة التي تلقيتها من <@${adminId}>؟`);
    await user.send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error(`❌ فشل إرسال تقييم للمواطن ${citizenId}:`, err);
  }

  // حذف المواطن من الطابور
  removeFromQueue(citizenId);

  // تحديث البورد
  await updateBoard(guild);
}

// ===== دوال السحب =====
function getNextFromQueue() {
  const queue = getQueue();
  if (queue.length === 0) return null;
  return queue[0].user_id;
}

function isFreeSupportRoom(channel) {
  if (!channel || channel.type !== 2) return false;
  if (!SUPPORT_ROOM_IDS.includes(channel.id)) return false;
  const members = [...channel.members.values()];
  if (members.length !== 1) return false;
  const admin = members[0];
  if (!admin.roles.cache.has(ADMIN_ROLE_ID)) return false;
  if (admin.voice.selfDeaf || admin.voice.serverDeaf) return false;
  return true;
}

async function tryPull(guild) {
  for (const roomId of SUPPORT_ROOM_IDS) {
    const channel = guild.channels.cache.get(roomId);
    if (!channel || !isFreeSupportRoom(channel) || pullLocks.has(channel.id)) continue;

    const citizenId = getNextFromQueue();
    if (!citizenId) continue;

    const citizen = guild.members.cache.get(citizenId);
    if (!citizen || !citizen.voice.channel) {
      removeFromQueue(citizenId);
      continue;
    }

    const admin = channel.members.first();
    if (!admin) continue;

    pullLocks.add(channel.id);
    try {
      // إشعار للمواطن
      await notifyCitizen(citizenId, admin.id);

      // نقل المواطن
      await citizen.voice.setChannel(channel.id, 'سحب تلقائي من الطابور');

      // تسجيل الجلسة
      activeSessions.set(citizenId, { adminId: admin.id, startTime: Date.now() });
      removeFromQueue(citizenId);

      console.log(`✅ تم سحب ${citizen.user.tag} إلى ${channel.name} (الإداري: ${admin.user.tag})`);

      // تحديث البورد
      await updateBoard(guild);
    } catch (err) {
      console.error(`⚠️ فشل سحب ${citizen.user.tag}:`, err.message);
    } finally {
      pullLocks.delete(channel.id);
    }
  }
}

// ===== بدء البوت =====
client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 البوت شغال باسم ${c.user.tag}`);

  // تسجيل الأوامر
  try {
    const commands = [
      { name: 'board', description: 'عرض لوحة الدعم الحالية' },
      { name: 'queue', description: 'عرض قائمة الانتظار' },
      { name: 'end_session', description: 'إنهاء الجلسة الحالية (للإداري)' },
      { name: 'stats', description: 'عرض إحصائيات الإداريين' },
      { name: 'top', description: 'عرض أكثر الإداريين إنجازاً' },
    ];
    await c.application.commands.set(commands, GUILD_ID);
    console.log('✅ تم تسجيل الأوامر.');
  } catch (error) {
    console.error('❌ خطأ في تسجيل الأوامر:', error);
  }

  // تحديث البورد فوراً
  const guild = c.guilds.cache.get(GUILD_ID);
  if (guild) {
    await updateBoard(guild);
    // تحديث البورد كل 10 ثوانٍ
    setInterval(() => updateBoard(guild), BOARD_UPDATE_INTERVAL);
  }
});

// ===== حدث دخول/خروج من الصوت =====
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild || guild.id !== GUILD_ID) return;
  const userId = newState.id;

  // ===== تسجيل دخول إلى روم الانتظار =====
  if (newState.channelId && WAITING_CHANNEL_IDS.includes(newState.channelId)) {
    // التحقق من أن العضو ليس إداري
    const member = guild.members.cache.get(userId);
    if (member && !member.roles.cache.has(ADMIN_ROLE_ID)) {
      if (!isInQueue(userId)) {
        addToQueue(userId);
        console.log(`📥 تم إضافة ${member.user.tag} إلى الطابور.`);
        await updateBoard(guild);
        tryPull(guild);
      }
    }
  }

  // ===== خروج من روم الانتظار =====
  if (oldState.channelId && WAITING_CHANNEL_IDS.includes(oldState.channelId)) {
    if (isInQueue(userId)) {
      removeFromQueue(userId);
      console.log(`📤 تم إزالة ${userId} من الطابور.`);
      await updateBoard(guild);
    }
  }

  // ===== إنهاء الجلسة عند خروج المواطن من روم الدعم =====
  if (activeSessions.has(userId) && newState.channelId !== oldState.channelId) {
    const session = activeSessions.get(userId);
    if (session) {
      await endSession(guild, userId, session.adminId, null);
    }
  }

  // ===== نظام نقاط التواجد للإداريين =====
  const member = guild.members.cache.get(userId);
  if (!member || !member.roles.cache.has(ADMIN_ROLE_ID)) return;

  const inSupport = newState.channelId && SUPPORT_ROOM_IDS.includes(newState.channelId);
  const wasInSupport = oldState.channelId && SUPPORT_ROOM_IDS.includes(oldState.channelId);

  if (inSupport && !wasInSupport) {
    // دخل إداري إلى روم دعم
    adminPresence.set(userId, {
      channelId: newState.channelId,
      startTime: Date.now(),
      interval: setInterval(() => {
        // إضافة نقطة كل 15 دقيقة (900 ثانية)
        const current = presencePoints.get(userId) || 0;
        presencePoints.set(userId, current + 1);
        savePresencePoints();
        console.log(`⭐ تم إضافة نقطة تواجد للإداري ${userId}`);
      }, 15 * 60 * 1000)
    });
    console.log(`🟢 الإداري ${member.user.tag} دخل روم دعم.`);
    tryPull(guild);
  } else if (!inSupport && wasInSupport) {
    // خرج إداري من روم دعم
    const presence = adminPresence.get(userId);
    if (presence) {
      clearInterval(presence.interval);
      adminPresence.delete(userId);
      console.log(`🔴 الإداري ${member.user.tag} خرج من روم الدعم.`);
    }
  }
});

// ===== التفاعلات =====
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ===== زر تحديث البورد =====
    if (interaction.isButton() && interaction.customId === 'refresh_board') {
      await interaction.deferUpdate();
      await updateBoard(interaction.guild);
      return;
    }

    // ===== أزرار التقييم =====
    if (interaction.isButton() && interaction.customId.startsWith('rate_')) {
      const parts = interaction.customId.split('_');
      const type = parts[1]; // satisfied / unsatisfied
      const adminId = parts[2];
      const citizenId = parts[3];

      const rating = type === 'satisfied' ? 5 : 1;
      saveRating(adminId, citizenId, rating);

      await interaction.update({
        content: `✅ شكراً لتقييمك! (${type === 'satisfied' ? 'راضٍ 😊' : 'غير راضٍ 😞'})`,
        components: [],
        embeds: []
      });

      // إرسال تقرير التقييم إلى روم اللوق
      try {
        const logChannel = interaction.guild.channels.cache.get(LOG_CHANNEL_ID);
        if (logChannel) {
          const embed = new EmbedBuilder()
            .setColor(type === 'satisfied' ? 0x2ecc71 : 0xe74c3c)
            .setTitle('📊 تقييم جديد')
            .addFields(
              { name: 'المقيّم', value: `<@${citizenId}>`, inline: true },
              { name: 'المُقيَّم', value: `<@${adminId}>`, inline: true },
              { name: 'التقييم', value: type === 'satisfied' ? '✅ راضٍ' : '❌ غير راضٍ', inline: true }
            )
            .setTimestamp();
          await logChannel.send({ embeds: [embed] });
        }
      } catch (e) { console.error('❌ خطأ في إرسال تقرير التقييم:', e); }
      return;
    }

    // ===== أمر /board =====
    if (interaction.isChatInputCommand() && interaction.commandName === 'board') {
      await interaction.deferReply();
      await updateBoard(interaction.guild);
      await interaction.editReply({ content: '✅ تم تحديث لوحة الدعم.', ephemeral: true });
      return;
    }

    // ===== أمر /queue =====
    if (interaction.isChatInputCommand() && interaction.commandName === 'queue') {
      const queue = getQueue();
      if (queue.length === 0) {
        return interaction.reply({ content: '📭 لا يوجد لاعبون في قائمة الانتظار حالياً.', ephemeral: true });
      }
      const list = queue.map((row, i) => `${i+1}. <@${row.user_id}>`).join('\n');
      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('📋 قائمة الانتظار')
        .setDescription(list)
        .setFooter({ text: `إجمالي المنتظرين: ${queue.length}` })
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ===== أمر /end_session =====
    if (interaction.isChatInputCommand() && interaction.commandName === 'end_session') {
      const member = interaction.member;
      if (!member.roles.cache.has(ADMIN_ROLE_ID)) {
        return interaction.reply({ content: '❌ هذا الأمر خاص بالإداريين فقط.', ephemeral: true });
      }

      // البحث عن جلسة نشطة لهذا الإداري
      let sessionCitizenId = null;
      let sessionData = null;
      for (const [citizenId, data] of activeSessions) {
        if (data.adminId === member.id) {
          sessionCitizenId = citizenId;
          sessionData = data;
          break;
        }
      }

      if (!sessionCitizenId) {
        return interaction.reply({ content: '❌ ليس لديك جلسة نشطة حالياً.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      await endSession(interaction.guild, sessionCitizenId, member.id, null);
      await interaction.editReply({ content: '✅ تم إنهاء الجلسة بنجاح.' });
      return;
    }

    // ===== أمر /stats =====
    if (interaction.isChatInputCommand() && interaction.commandName === 'stats') {
      const adminId = interaction.options.getUser('admin')?.id || interaction.user.id;
      const done = doneCounts.get(adminId) || 0;
      const ratingData = getAdminRating(adminId);
      const points = presencePoints.get(adminId) || 0;
      const avgRating = ratingData ? ratingData.avg : 0;
      const totalRatings = ratingData ? ratingData.count : 0;

      const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle('📊 إحصائيات الإداري')
        .addFields(
          { name: '🛡️ الإداري', value: `<@${adminId}>`, inline: true },
          { name: '✅ الـ Done', value: `\`${done}\``, inline: true },
          { name: '⭐ متوسط التقييم', value: `\`${avgRating.toFixed(1)}/5\``, inline: true },
          { name: '📝 عدد التقييمات', value: `\`${totalRatings}\``, inline: true },
          { name: '⏱️ نقاط التواجد', value: `\`${points}\``, inline: true }
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    // ===== أمر /top =====
    if (interaction.isChatInputCommand() && interaction.commandName === 'top') {
      const sorted = [...doneCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      if (sorted.length === 0) {
        return interaction.reply({ content: '📊 لا توجد إحصائيات مسجلة بعد.', ephemeral: true });
      }
      const description = sorted.map(([id, count], i) => {
        const medals = ['🥇', '🥈', '🥉'];
        const rank = i < 3 ? medals[i] : `#${i+1}`;
        return `${rank} <@${id}>: \`${count}\` Done`;
      }).join('\n');
      const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle('🏆 ترتيب الإداريين')
        .setDescription(description)
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

  } catch (error) {
    console.error('❌ خطأ في التفاعل:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ حدث خطأ أثناء معالجة الطلب.', ephemeral: true }).catch(() => null);
    }
  }
});

client.login(BOT_TOKEN);