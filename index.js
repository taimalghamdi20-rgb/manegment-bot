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

// إنشاء الجداول إذا لم تكن موجودة
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
    last_update INTEGER
  );
  CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id TEXT,
    citizen_id TEXT,
    rating INTEGER,
    timestamp INTEGER
  );
`);

// ===== قراءة المتغيرات من بيئة التشغيل =====
const {
  BOT_TOKEN,
  GUILD_ID,
  WAITING_CHANNEL_ID,
  ADMIN_ROLE_ID,
  CITIZEN_ROLE_ID,
  SUPPORT_CATEGORY_ID,
  DONE_VOICE_CHANNEL_ID,
  LOG_CHANNEL_ID,
} = process.env;

if (!BOT_TOKEN || !GUILD_ID || !WAITING_CHANNEL_ID || !ADMIN_ROLE_ID) {
  console.error('❌ تأكد من تعبئة المتغيرات التالية في بيئة التشغيل:');
  console.error('BOT_TOKEN, GUILD_ID, WAITING_CHANNEL_ID, ADMIN_ROLE_ID');
  process.exit(1);
}

// ===== إضافة رومات الانتظار الإضافية =====
const ADDITIONAL_WAITING_IDS = [
  '1481398869463138604',
  '1519511668823167116'
];

const WAITING_CHANNEL_IDS = [
  ...WAITING_CHANNEL_ID.split(',').map(id => id.trim()).filter(Boolean),
  ...ADDITIONAL_WAITING_IDS
];

// ===== إعدادات ثابتة =====
const RATING_CHANNEL_ID = '1529482677516898555';
const LEAVE_EMBED_CHANNEL_ID = '1529495796247167178';
const LEAVE_PANEL_CHANNEL_ID = '1529440458030321714';
const LEAVE_ROLE_ID = '1459304469127758027';
const RESIGNATION_KEEP_ROLE_ID = '1476796533168017428';
const STAFF_ROLE_IDS = ['1459304407899443396', '1459304410923532481'];
const DONE_TEXT_CHANNEL_ID = '1529933848144510976';
const BOARD_CHANNEL_ID = '1529933848144510976'; // نفس روم الإدارة أو روم مخصص للبورد

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

const MAX_LEAVE_DAYS = 14;
const LEAVE_PANEL_COLOR = 0xC2410C;
const LEAVE_BANNER_PATH = path.join(__dirname, 'leave_banner.png');
const LEAVE_BANNER_FILENAME = 'leave_banner.png';
const SERVER_LOGO_PATH = path.join(__dirname, 'server_logo.png');
const SERVER_LOGO_FILENAME = 'server_logo.png';

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

// ===== دوال نقاط التواجد =====
function loadPresencePoints() {
  const stmt = db.prepare('SELECT admin_id, points, last_update FROM presence_points');
  const rows = stmt.all();
  const map = new Map();
  for (const row of rows) {
    map.set(row.admin_id, { points: row.points, lastUpdate: row.last_update });
  }
  return map;
}

function savePresencePoints() {
  db.prepare('DELETE FROM presence_points').run();
  const insert = db.prepare('INSERT INTO presence_points (admin_id, points, last_update) VALUES (?, ?, ?)');
  const trans = db.transaction((entries) => {
    for (const [id, data] of entries) {
      insert.run(id, data.points, data.lastUpdate);
    }
  });
  trans(presencePoints.entries());
}

function saveRating(adminId, citizenId, rating) {
  const insert = db.prepare('INSERT INTO ratings (admin_id, citizen_id, rating, timestamp) VALUES (?, ?, ?, ?)');
  insert.run(adminId, citizenId, rating, Date.now());
}

function getAdminRatings(adminId) {
  const stmt = db.prepare('SELECT AVG(rating) as avg_rating, COUNT(*) as total FROM ratings WHERE admin_id = ?');
  return stmt.get(adminId);
}

// تحميل البيانات
const doneCounts = loadDoneCounts();
const activeLeaves = loadActiveLeaves();
const presencePoints = loadPresencePoints();
const evaluatedLogs = new Set();

// ===== دوال مساعدة =====
function hasStaffRole(member) {
  return STAFF_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId));
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

function isMutedOrDeafened(vs) {
  if (!vs) return false;
  return vs.selfMute || vs.selfDeaf || vs.serverMute || vs.serverDeaf;
}

function isDeafened(vs) {
  if (!vs) return false;
  return vs.selfDeaf || vs.serverDeaf;
}

// ===== دوال الطابور الذكي =====
const waitQueue = [];
const activeSessions = new Map();
const presenceTimers = new Map();

function getNextEligibleWaitingMember(guild) {
  for (const waitingId of WAITING_CHANNEL_IDS) {
    const channel = guild.channels.cache.get(waitingId);
    if (!channel || !channel.members) continue;
    for (const [, member] of channel.members) {
      if (!isMutedOrDeafened(member.voice)) {
        // إضافة إلى الطابور إذا لم يكن موجوداً
        if (!waitQueue.includes(member.id)) {
          waitQueue.push(member.id);
        }
        return member;
      }
    }
  }
  return null;
}

function isFreeAdminRoom(channel) {
  if (!channel || channel.type !== 2 || !ADMIN_ROOM_IDS.includes(channel.id)) return false;
  const members = [...channel.members.values()];
  if (members.length !== 1) return false;
  const admin = members[0];
  if (!admin.roles.cache.has(ADMIN_ROLE_ID) || isDeafened(admin.voice)) return false;
  return true;
}

// ===== نظام نقاط التواجد =====
function startPresenceTimer(adminId, guild) {
  if (presenceTimers.has(adminId)) return;
  
  const timer = setInterval(async () => {
    const member = await guild.members.fetch(adminId).catch(() => null);
    if (!member) {
      stopPresenceTimer(adminId);
      return;
    }
    
    const voiceState = member.voice;
    if (!voiceState.channel || isDeafened(voiceState)) {
      stopPresenceTimer(adminId);
      return;
    }
    
    // تحديث النقاط كل 15 دقيقة
    const now = Date.now();
    const data = presencePoints.get(adminId) || { points: 0, lastUpdate: now };
    const timeDiff = now - (data.lastUpdate || now);
    
    if (timeDiff >= 15 * 60 * 1000) { // 15 دقيقة
      data.points += 1;
      data.lastUpdate = now;
      presencePoints.set(adminId, data);
      savePresencePoints();
      
      console.log(`🟢 تم إضافة نقطة تواجد للإداري <@${adminId}> (المجموع: ${data.points})`);
    }
  }, 60 * 1000); // فحص كل دقيقة
  
  presenceTimers.set(adminId, timer);
}

function stopPresenceTimer(adminId) {
  if (presenceTimers.has(adminId)) {
    clearInterval(presenceTimers.get(adminId));
    presenceTimers.delete(adminId);
  }
}

// ===== دوال البورد المباشر =====
let boardMessage = null;

async function updateBoard(guild) {
  const channel = guild.channels.cache.get(BOARD_CHANNEL_ID);
  if (!channel) return;

  const waitingCount = waitQueue.length;
  const status = waitingCount > 0 ? '🟡 Busy' : '🟢 Available';

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('# Emperors Town RP')
    .setDescription(`- Live Support Board\n- Live Support Board`)
    .addFields(
      { name: '**Support Status:**', value: status, inline: false },
      { name: '**Players Waiting:**', value: `**${waitingCount}**`, inline: false },
      { name: '**Current Waiting List:**', value: waitQueue.length > 0 
        ? waitQueue.map((id, i) => `${i+1}. <@${id}>`).join('\n')
        : '`لا يوجد لاعبين ينتظرون`', 
        inline: false }
    )
    .setFooter({ text: 'Live board - updates automatically' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('refresh_board')
      .setLabel('🔄 تحديث')
      .setStyle(ButtonStyle.Secondary)
  );

  if (boardMessage) {
    try {
      await boardMessage.edit({ embeds: [embed], components: [row] });
    } catch (e) {
      boardMessage = await channel.send({ embeds: [embed], components: [row] });
    }
  } else {
    boardMessage = await channel.send({ embeds: [embed], components: [row] });
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

// ============================================================
// حماية روم الإجازات
// ============================================================
client.on(Events.MessageCreate, async (message) => {
  if (message.guild && message.channelId === LEAVE_EMBED_CHANNEL_ID) {
    if (message.author.bot) return;
    if (!hasStaffRole(message.member)) {
      try { await message.delete(); } catch (e) { console.error('❌ فشل حذف الرسالة:', e); }
    }
  }
});

// ============================================================
// تسجيل الأوامر
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
      { name: 'board', description: 'إرسال لوحة الدعم المباشرة' },
      { name: 'points', description: 'عرض نقاط التواجد للإداريين' },
    ];
    await c.application.commands.set(commands, GUILD_ID);
    console.log('✅ تم تسجيل الأوامر.');
    
    // تحديث البورد بعد 5 ثواني
    setTimeout(async () => {
      await updateBoard(c.guilds.cache.get(GUILD_ID));
    }, 5000);
    
  } catch (error) {
    console.error('❌ خطأ في تسجيل الأوامر:', error);
  }
});

// ============================================================
// حركة الصوت
// ============================================================
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild || guild.id !== GUILD_ID) return;
  const userId = newState.id;

  // ===== نظام الطابور =====
  // إزالة من الطابور إذا غادر روم الانتظار أو دخل روم إداري
  if (oldState.channelId && WAITING_CHANNEL_IDS.includes(oldState.channelId)) {
    const index = waitQueue.indexOf(userId);
    if (index > -1) {
      waitQueue.splice(index, 1);
      await updateBoard(guild);
    }
  }

  // إضافة إلى الطابور إذا دخل روم الانتظار
  if (newState.channelId && WAITING_CHANNEL_IDS.includes(newState.channelId)) {
    if (!waitQueue.includes(userId) && !isMutedOrDeafened(newState)) {
      waitQueue.push(userId);
      await updateBoard(guild);
      
      // إرسال رسالة تنبيه للمواطن
      try {
        const user = await client.users.fetch(userId);
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('🎙️ Emperors Town RP')
          .setDescription('**استعد لجلسة الدعم**\nسيتم نقلك إلى روم الدعم (Support) بعد لحظات.\n\nجهز ملاحظاتك وأسئلتك قبل بدء الجلسة.')
          .setFooter({ text: 'Emperors Town RP' })
          .setTimestamp();
        await user.send({ embeds: [embed] });
      } catch (e) { /* تجاهل الأخطاء */ }
    }
  }

  // ===== نظام نقاط التواجد =====
  // بدء المؤقت إذا دخل الإداري روم دعم
  if (newState.channelId && ADMIN_ROOM_IDS.includes(newState.channelId)) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member && member.roles.cache.has(ADMIN_ROLE_ID) && !isDeafened(newState)) {
      startPresenceTimer(userId, guild);
    }
  }

  // إيقاف المؤقت إذا غادر الإداري أو ديفن
  if (oldState.channelId && ADMIN_ROOM_IDS.includes(oldState.channelId)) {
    if (isDeafened(newState) || !newState.channelId) {
      stopPresenceTimer(userId);
    }
  }

  // ===== نظام الـ Done والتقييم =====
  if (activeSessions.has(userId) && newState.channelId !== oldState.channelId) {
    const { adminId, startTime } = activeSessions.get(userId);
    activeSessions.delete(userId);

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
      const channel = guild.channels.cache.get(DONE_TEXT_CHANNEL_ID);
      if (channel) {
        const embed = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle('✅ انتهاء الدعم')
          .setDescription('قام الإداري بإنهاء حالة الدعم الخاصة بك وتم نقلك إلى روم الانتهاء.')
          .addFields(
            { name: 'الإداري', value: `<@${adminId}>`, inline: true },
            { name: 'الوقت المستغرق', value: `\`${durationText}\``, inline: true },
            { name: 'تقييم الدعم الفني', value: 'هل أنت راضي عن جودة الدعم الذي تلقيه؟', inline: false }
          )
          .setImage('attachment://server_logo.png')
          .setTimestamp();
        
        // زر التقييم
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`rate_satisfied_${adminId}`)
            .setLabel('راضي')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🟢'),
          new ButtonBuilder()
            .setCustomId(`rate_unsatisfied_${adminId}`)
            .setLabel('غير راضي')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🔴')
        );
        
        const file = new AttachmentBuilder(SERVER_LOGO_PATH, { name: 'server_logo.png' });
        logMsg = await channel.send({ embeds: [embed], components: [row], files: [file] });
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
          fields[2].value = '❌ الخاص مغلق (لم يتم التقييم)';
          embed.setFields(fields);
          await logMsg.edit({ embeds: [embed] });
        } catch (e) {}
      }
    }
  }

  // محاولة السحب التلقائي
  try {
    const pullResult = await tryPullForAllFreeAdmins(guild);
    if (pullResult) {
      await updateBoard(guild);
    }
  } catch (e) { console.error('خطأ في السحب:', e); }
});

// ===== دوال السحب =====
const pullLocks = new Set();

async function tryPullForAllFreeAdmins(guild) {
  let pulled = false;
  for (const roomId of ADMIN_ROOM_IDS) {
    const channel = guild.channels.cache.get(roomId);
    if (!channel || !isFreeAdminRoom(channel) || pullLocks.has(channel.id)) continue;
    
    const candidate = getNextEligibleWaitingMember(guild);
    if (!candidate) continue;
    
    pullLocks.add(channel.id);
    try {
      const admin = channel.members.first();
      await candidate.voice.setChannel(channel.id, 'سحب تلقائي');
      
      // إزالة من الطابور
      const index = waitQueue.indexOf(candidate.id);
      if (index > -1) waitQueue.splice(index, 1);
      
      activeSessions.set(candidate.id, { adminId: admin.id, startTime: Date.now() });
      console.log(`✅ تم سحب ${candidate.user.tag} إلى ${channel.name} (الإداري: ${admin.user.tag})`);
      pulled = true;
    } catch (err) {
      console.error(`⚠️ فشل سحب ${candidate.user.tag}:`, err.message);
    } finally {
      pullLocks.delete(channel.id);
    }
  }
  return pulled;
}

// ============================================================
// التفاعلات
// ============================================================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ===== زر تحديث البورد =====
    if (interaction.isButton() && interaction.customId === 'refresh_board') {
      await interaction.deferUpdate();
      await updateBoard(interaction.guild);
      return;
    }

    // ===== أزرار التقييم (النجوم) =====
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
      await interaction.update({ content: `✅ شكراً! (${stars})`, embeds: [], components: [] });

      // حفظ التقييم
      saveRating(adminId, interaction.user.id, rating);

      try {
        const guild = client.guilds.cache.get(GUILD_ID);
        const channel = guild.channels.cache.get(RATING_CHANNEL_ID);
        if (channel) {
          const file = new AttachmentBuilder(SERVER_LOGO_PATH, { name: SERVER_LOGO_FILENAME });
          const embed = new EmbedBuilder()
            .setColor(ratingColor(rating))
            .setAuthor({ name: `${interaction.user.username} قيّم الخدمة`, iconURL: interaction.user.displayAvatarURL() })
            .setTitle('🌟 تقييم إداري')
            .setThumbnail(`attachment://${SERVER_LOGO_FILENAME}`)
            .addFields(
              { name: 'المواطن', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'الإداري', value: `<@${adminId}>`, inline: true },
              { name: '⭐ التقييم', value: `${stars}\n\`${rating}/5\` — ${ratingLabel(rating)}`, inline: false }
            )
            .setTimestamp();
          await channel.send({ embeds: [embed], files: [file] });
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
              const fields = embed.data.fields;
              // تحديث حقل التقييم
              if (fields.length > 2) {
                fields[2].value = stars;
              }
              embed.setFields(fields);
              await msg.edit({ embeds: [embed] });
            }
          }
        }
      } catch (e) { console.error('❌ خطأ في تحديث سجل التقييم:', e); }
      return;
    }

    // ===== أزرار راضي/غير راضي =====
    if (interaction.isButton() && interaction.customId.startsWith('rate_satisfied_')) {
      const adminId = interaction.customId.split('_')[2];
      await interaction.update({ content: '✅ شكراً لتقييمك!', components: [] });
      
      // حفظ التقييم كـ 5 نجوم
      saveRating(adminId, interaction.user.id, 5);
      
      try {
        const guild = client.guilds.cache.get(GUILD_ID);
        const channel = guild.channels.cache.get(RATING_CHANNEL_ID);
        if (channel) {
          const file = new AttachmentBuilder(SERVER_LOGO_PATH, { name: SERVER_LOGO_FILENAME });
          const embed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setAuthor({ name: `${interaction.user.username} قيّم الخدمة`, iconURL: interaction.user.displayAvatarURL() })
            .setTitle('🌟 تقييم إداري')
            .setThumbnail(`attachment://${SERVER_LOGO_FILENAME}`)
            .addFields(
              { name: 'المواطن', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'الإداري', value: `<@${adminId}>`, inline: true },
              { name: '⭐ التقييم', value: '⭐⭐⭐⭐⭐\n`5/5` — **ممتاز**', inline: false }
            )
            .setTimestamp();
          await channel.send({ embeds: [embed], files: [file] });
        }
      } catch (e) { console.error('❌ خطأ في إرسال التقييم:', e); }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('rate_unsatisfied_')) {
      const adminId = interaction.customId.split('_')[2];
      await interaction.update({ content: '❌ تم تسجيل ملاحظتك، شكراً لك.', components: [] });
      
      // حفظ التقييم كـ 1 نجمة
      saveRating(adminId, interaction.user.id, 1);
      
      try {
        const guild = client.guilds.cache.get(GUILD_ID);
        const channel = guild.channels.cache.get(RATING_CHANNEL_ID);
        if (channel) {
          const file = new AttachmentBuilder(SERVER_LOGO_PATH, { name: SERVER_LOGO_FILENAME });
          const embed = new EmbedBuilder()
            .setColor(0xed4245)
            .setAuthor({ name: `${interaction.user.username} قيّم الخدمة`, iconURL: interaction.user.displayAvatarURL() })
            .setTitle('🌟 تقييم إداري')
            .setThumbnail(`attachment://${SERVER_LOGO_FILENAME}`)
            .addFields(
              { name: 'المواطن', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'الإداري', value: `<@${adminId}>`, inline: true },
              { name: '⭐ التقييم', value: '⭐\n`1/5` — **ضعيف جداً**', inline: false }
            )
            .setTimestamp();
          await channel.send({ embeds: [embed], files: [file] });
        }
      } catch (e) { console.error('❌ خطأ في إرسال التقييم:', e); }
      return;
    }

    // ===== باقي الأزرار (طلب إجازة، استقالة، كسر إجازة) =====
    if (interaction.customId === 'open_leave_modal') {
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

    if (interaction.customId === 'open_resign_modal') {
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

    if (interaction.customId === 'open_break_modal') {
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

    // ===== أزرار قبول/رفض الطلبات =====
    if (interaction.customId.startsWith('req_accept_') || interaction.customId.startsWith('req_reject_')) {
      if (!hasStaffRole(interaction.member)) {
        return interaction.reply({
          content: '❌ هذا الإجراء خاص بأصحاب صلاحية الإدارة فقط.',
          ephemeral: true,
        });
      }

      const parts = interaction.customId.split('_');
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

    // ===== المودالات =====
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
            ephemeral: true,
          });
        }

        if (duration > MAX_LEAVE_DAYS) {
          return await interaction.reply({
            content: `❌ ما يصير تطلب إجازة أكثر من ${MAX_LEAVE_DAYS} أيام. الرجاء إعادة المحاولة بمدة أقل.`,
            ephemeral: true,
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
          ephemeral: true,
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
          ephemeral: true,
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
          ephemeral: true,
        });
      }
    }

    // ===== الأوامر =====
    if (interaction.isChatInputCommand()) {
      // أمر البورد
      if (interaction.commandName === 'board') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بأصحاب صلاحية الإدارة فقط.', ephemeral: true });
        }
        await updateBoard(interaction.guild);
        return interaction.reply({ content: '✅ تم تحديث لوحة الدعم المباشرة.', ephemeral: true });
      }

      // أمر نقاط التواجد
      if (interaction.commandName === 'points') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بأصحاب صلاحية الإدارة فقط.', ephemeral: true });
        }
        
        if (presencePoints.size === 0) {
          return interaction.reply({ content: '📊 لا توجد نقاط تواجد مسجلة بعد.', ephemeral: true });
        }

        const sortedPoints = [...presencePoints.entries()]
          .sort((a, b) => b[1].points - a[1].points)
          .slice(0, 10);

        const description = sortedPoints.map(([adminId, data], index) => {
          const medals = ['🥇', '🥈', '🥉'];
          const rank = index < 3 ? medals[index] : `**#${index + 1}**`;
          return `${rank} - <@${adminId}> : \`${data.points}\` نقطة`;
        }).join('\n\n');

        const embed = new EmbedBuilder()
          .setTitle('🏆 توب 10 إداريين (نقاط التواجد)')
          .setColor(0xffd700)
          .setDescription(description)
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }

      // الأمر send_leave_panel
      if (interaction.commandName === 'send_leave_panel') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بأصحاب صلاحية الإدارة فقط.', ephemeral: true });
        }

        const panelEmbed = new EmbedBuilder()
          .setTitle('📋 نظام طلبات الإجازات والاستقالات')
          .setDescription(
            [
              'اختر نوع الطلب اللي تبيه من الأزرار تحت:',
              '',
              `📄 **طلب إجازة** — لطلب إجازة (بحد أقصى ${MAX_LEAVE_DAYS} أيام) مع ذكر السبب.`,
              '🔓 **طلب كسر إجازة** — إذا رجعت من إجازتك بدري وتبي توضح السبب.',
              '📝 **طلب استقالة** — لتقديم طلب استقالة مع ذكر السبب.',
            ].join('\n')
          )
          .setColor(LEAVE_PANEL_COLOR)
          .setImage(`attachment://${LEAVE_BANNER_FILENAME}`)
          .setFooter({ text: 'يرجى تعبئة البيانات بدقة قبل الإرسال' })
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

        const bannerFile = new AttachmentBuilder(LEAVE_BANNER_PATH, { name: LEAVE_BANNER_FILENAME });

        try {
          const panelChannel = await interaction.guild.channels.fetch(LEAVE_EMBED_CHANNEL_ID);
          await panelChannel.send({ embeds: [panelEmbed], components: [row], files: [bannerFile] });

          return interaction.reply({
            content: `✅ تم إرسال لوحة الإجازات والاستقالات في روم الإمبد <#${LEAVE_EMBED_CHANNEL_ID}>.`,
            ephemeral: true,
          });
        } catch (err) {
          console.error('❌ خطأ أثناء إرسال لوحة الاجازات:', err);
          return interaction.reply({
            content: '⚠️ ما قدرت أرسل اللوحة. تأكد إن البوت عنده صلاحية إرسال رسائل وصور بذاك الروم.',
            ephemeral: true,
          });
        }
      }

      // أمر الإجازات النشطة
      if (interaction.commandName === 'active_leaves') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بأصحاب صلاحية الإدارة فقط.', ephemeral: true });
        }

        if (activeLeaves.size === 0) {
          return interaction.reply({ content: '🌴 لا يوجد أي إداري في إجازة حالياً.', ephemeral: true });
        }

        let expiredCount = 0;
        const now = Date.now();
        let description = '';
        let index = 1;

        for (const [userId, leaveData] of activeLeaves.entries()) {
          if (now > leaveData.endDate) {
            activeLeaves.delete(userId);
            expiredCount++;
            continue;
          }

          const remainingMs = leaveData.endDate - now;
          const remainingDays = Math.floor(remainingMs / (1000 * 60 * 60 * 24));
          const remainingHours = Math.floor((remainingMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

          let timeText = '';
          if (remainingDays > 0) timeText += `${remainingDays} يوم و `;
          timeText += `${remainingHours} ساعة`;

          description += `**${index}.** <@${userId}> — ينتهي بعد: \`${timeText}\`\n`;
          index++;
        }

        if (expiredCount > 0) saveActiveLeaves();

        if (description === '') {
          description = '✅ كانت هناك إجازات في السجل ولكن جميعها انتهت الآن.';
        }

        const embed = new EmbedBuilder()
          .setTitle('قائمة الإجازات النشطة')
          .setColor(0x3ba55d)
          .setDescription(description)
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }

      // أمر التوب 10
      if (interaction.commandName === 'top_done') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بأصحاب صلاحية الإدارة فقط.', ephemeral: true });
        }
        if (doneCounts.size === 0) return interaction.reply({ content: '📊 ما فيه أي إحصائيات مسجلة حتى الآن.', ephemeral: true });

        const sortedDones = [...doneCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

        const description = sortedDones.map(([adminId, count], index) => {
          const medals = ['🥇', '🥈', '🥉'];
          const rank = index < 3 ? medals[index] : `**#${index + 1}**`;
          return `${rank} - <@${adminId}> : \`${count}\` Done`;
        }).join('\n\n');

        const embed = new EmbedBuilder()
          .setTitle('🏆 توب 10 إداريين (أكثر من ساعد المواطنين)')
          .setColor(0xffd700)
          .setDescription(description);

        return interaction.reply({ embeds: [embed] });
      }

      // أمر عرض الكل
      if (interaction.commandName === 'all_dones') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بأصحاب صلاحية الإدارة فقط.', ephemeral: true });
        }
        if (doneCounts.size === 0) return interaction.reply({ content: '📊 ما فيه أي إحصائيات مسجلة حتى الآن.', ephemeral: true });

        const sortedDones = [...doneCounts.entries()].sort((a, b) => b[1] - a[1]);

        const description = sortedDones.map(([adminId, count], index) => {
          return `**#${index + 1}** - <@${adminId}> : \`${count}\` Done`;
        }).join('\n');

        const embed = new EmbedBuilder()
          .setTitle('📊 إحصائيات جميع الإداريين (Done)')
          .setColor(0x3498db)
          .setDescription(description.length > 4096 ? description.slice(0, 4090) + '...' : description);

        return interaction.reply({ embeds: [embed] });
      }

      // إضافة إنجازات
      if (interaction.commandName === 'add_done') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بأصحاب صلاحية الإدارة العليا فقط.', ephemeral: true });
        }

        const admin = interaction.options.getUser('admin');
        const amount = interaction.options.getInteger('amount');

        const currentCount = doneCounts.get(admin.id) || 0;
        const newCount = currentCount + amount;
        doneCounts.set(admin.id, newCount);
        saveDoneCounts();

        return interaction.reply({ content: `✅ تم إضافة \`${amount}\` إلى إحصائيات <@${admin.id}>. المجموع الحالي: \`${newCount}\``, ephemeral: true });
      }

      // خصم إنجازات
      if (interaction.commandName === 'remove_done') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بأصحاب صلاحية الإدارة العليا فقط.', ephemeral: true });
        }

        const admin = interaction.options.getUser('admin');
        const amount = interaction.options.getInteger('amount');

        const currentCount = doneCounts.get(admin.id) || 0;
        const newCount = Math.max(0, currentCount - amount);
        doneCounts.set(admin.id, newCount);
        saveDoneCounts();

        return interaction.reply({ content: `✅ تم خصم \`${amount}\` من إحصائيات <@${admin.id}>. المجموع الحالي: \`${newCount}\``, ephemeral: true });
      }

      // تصفير الإحصائيات
      if (interaction.commandName === 'reset_all') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بأصحاب صلاحية الإدارة العليا فقط.', ephemeral: true });
        }

        doneCounts.clear();
        saveDoneCounts();

        return interaction.reply({ content: '🧹 تم تصفير جميع إحصائيات الـ Done بنجاح!', ephemeral: true });
      }
    }
  } catch (error) {
    console.error('❌ خطأ أثناء معالجة التفاعل:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ حدث خطأ أثناء معالجة الطلب.', ephemeral: true }).catch(() => null);
    }
  }
});

client.login(BOT_TOKEN);
