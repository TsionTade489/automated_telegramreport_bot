import { Telegraf } from 'telegraf';
import { getOrCreateUser } from './userService.js';
import { supabase } from './supabase.js';
import dotenv from 'dotenv';
import { checkIn } from './attendanceService.js';
import { submitSummary, editSummary, finalizeSummary } from './summaryService.js';
import { getTodayReport } from './reportService.js';
import { createDailySummary, addTaskTitle, updateLastTask, getSessionTasks } from './reportService.js';
import { updateUserState, getUserState } from './userService.js';
import axios from 'axios'; 

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN || '8513662828:AAHXmaJk9x1lxuY1Ou4rIrSNirSWWERthVA';
const bot = new Telegraf(token);

// The "Start" command
bot.start(async (ctx) => {
  try {
    const telegramId = ctx.from.id;
    const user = await getOrCreateUser(telegramId);
    const firstName = ctx.from.first_name || 'there';

    let message = '';
    let commands = [];
    
    if (user.role === 'ceo') {
      message = `👑 Welcome CEO ${firstName}! Full access granted.`;
      commands = [
        '📊 /report - View daily team report'
      ];
    } else if (user.role === 'admin') {
      message = `🛠️ Welcome Admin ${firstName}! You can manage team reports.`;
      commands = [
        '📊 /report - View daily team report'
      ];
    } else {
      message = `👋 Welcome ${firstName}! Ready to end your day?`;
      commands = [
        '✅ /checkin - Mark your attendance',
        '📝 /daily - Start daily report',
        '❓ /help - See all available commands'
      ];
    }

    let callToAction = '';
    if (['ceo', 'admin'].includes(user.role)) {
      callToAction = '💡 Start with /report to view team activities!';
    } else {
      callToAction = '💡 Start with /checkin to submit your daily work!';
    }

    const fullMessage = `${message}\n\n📋 Available commands:\n${commands.join('\n')}\n\n${callToAction}`;
    await ctx.reply(fullMessage);
  } catch (err) {
    console.error('Bot Error:', err);
    await ctx.reply('❌ Something went wrong. Please try again later.');
  }
});

// The "Check In" command
bot.command('checkin', async (ctx) => {
  try {
    const telegramId = ctx.from.id;
    const firstName = ctx.from.first_name || 'there';
    
    await getOrCreateUser(telegramId);
    const result = await checkIn(telegramId);
    console.log('CHECKIN RESULT:', result);

    const currentTime = new Date().toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit'
    });
    
    await ctx.reply(`✅ *Check-in successful!*\n\n🕐 Time: ${currentTime}\n👤 Welcome ${firstName}\n\n📝 Next step: Start your daily report with /daily`, 
    { parse_mode: 'Markdown' });
    
  } catch (err) {
    console.error('❌ CHECKIN ERROR:', err);

    if (err.message === 'ALREADY_CHECKED_IN') {
      return ctx.reply('⚠️ *Already checked in today!*\n\nYou can proceed with /daily to start your daily report.', 
      { parse_mode: 'Markdown' });
    }

    await ctx.reply(`❌ *Check-in failed*\n\n${err.message}\n\nPlease try again or contact support.`, 
    { parse_mode: 'Markdown' });
  }
});

// 1. Updated /daily Command
bot.command('daily', async (ctx) => {
  try {
    const telegramId = ctx.from.id;
    const user = await getOrCreateUser(telegramId);
    
    // 1. FETCH TODAY'S ATTENDANCE ID
    const todayStr = new Date().toISOString().split('T')[0];
    const { data: attendance, error: attError } = await supabase
      .from('attendance')
      .select('id')
      .eq('user_id', user.id)
      .gte('check_in_time', todayStr)
      .maybeSingle();

    if (attError) throw attError;

    if (!attendance) {
      return ctx.reply("❌ <b>You must check in first!</b>\nUse the check-in command before starting your report.", { parse_mode: 'HTML' });
    }

    // 2. SET UP DATE RANGE FOR SUMMARY CHECK
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Check if a report for today exists
    const { data: existingSummary, error: fetchError } = await supabase
      .from('daily_summaries')
      .select('id')
      .eq('user_id', user.id)
      .gte('created_at', todayStart.toISOString())
      .lte('created_at', todayEnd.toISOString())
      .maybeSingle();

    if (fetchError) throw fetchError;

    let summaryId;

    if (existingSummary) {
      summaryId = existingSummary.id;
      await ctx.reply("⚠️ <b>You already have an active report for today.</b>\n\nUse /add to record a task or /done to review.", { parse_mode: 'HTML' });
    } else {
      // 3. CREATE SUMMARY WITH ATTENDANCE LINK
      // We pass attendance.id here so it's saved in the database correctly
      const summary = await createDailySummary(user.id, attendance.id);
      summaryId = summary.id;
      await ctx.reply("📝 <b>Daily Report Started</b>\n\nUse /add to record your first task.", { parse_mode: 'HTML' });
    }

    await updateUserState(telegramId, 'AWAITING_ADD_OR_DONE', summaryId);

  } catch (err) {
    console.error("Daily Command Error:", err);
    ctx.reply("❌ Failed to start daily report. Please try again.");
  }
});

// 2. Updated /add Command
bot.command('add', async (ctx) => {
  try {
    const telegramId = ctx.from.id;
    const user = await getUserState(telegramId);

    // Check if the user is actually in the correct flow
    if (!user.active_summary_id) {
      return ctx.reply("⛔ **No active report found.**\n\nPlease type /daily first to start today's session.");
    }

    // Force the state to AWAITING_TITLE even if they were stuck
    await updateUserState(telegramId, 'AWAITING_TITLE', user.active_summary_id);
    ctx.reply("1️⃣ **Task Title?**\n(What are you working on right now?)");

  } catch (err) {
    console.error("Add Command Error:", err);
    ctx.reply("❌ Error preparing task entry. Try /daily again.");
  }
});

bot.command('done', async (ctx) => {
  console.log("🏁 /done command triggered by:", ctx.from.id);
  
  try {
    const userState = await getUserState(ctx.from.id);
    
    if (!userState.active_summary_id) {
      return ctx.reply("⚠️ You don't have an active report. Type /daily to start.");
    }

    // 1. Fetch the summary record from Supabase to get the attendance_id
    const { data: summaryRecord, error: summaryError } = await supabase
      .from('daily_summaries')
      .select('attendance_id')
      .eq('id', userState.active_summary_id)
      .single();

    if (summaryError || !summaryRecord) {
      console.error("Supabase Fetch Error:", summaryError);
      return ctx.reply("❌ Could not find your report details.");
    }

    // 2. Fetch tasks for the review message
    const tasks = await getSessionTasks(userState.active_summary_id);

    if (!tasks || tasks.length === 0) {
      return ctx.reply("📂 No tasks found for today. Use /add to record some work first!");
    }

    // 3. Prepare and Send to n8n
    const N8N_WEBHOOK_URL = 'https://n8n.blihmarketing.com/webhook/daily-summary-trigger';
    
    const payload = {
      summary_id: userState.active_summary_id,
      attendance_id: summaryRecord.attendance_id, // Now this is defined!
      user_name: ctx.from.first_name,
      telegram_id: ctx.from.id
    };

    console.log("📤 Sending Payload to n8n:", payload);

    // Use await for axios to catch errors properly in the try/catch block
    try {
      const res = await axios.post(N8N_WEBHOOK_URL, payload);
      console.log("✅ n8n Response:", res.status, res.statusText);
    } catch (e) {
      console.error("❌ n8n Request Error:", e.message);
    }

    // 4. Format the review message
    let reviewMessage = "📝 *Daily Summary Review*\n\n";
    tasks.forEach((task, index) => {
      reviewMessage += `*${index + 1}. ${task.title}*\n`;
      reviewMessage += `▫️ Status: ${task.status}\n`;
      if (task.progress !== null) reviewMessage += `▫️ Progress: ${task.progress}%\n`;
      if (task.blocker_reason) reviewMessage += `⚠️ Blocker: ${task.blocker_reason}\n`;
      reviewMessage += `\n`;
    });

    reviewMessage += "Confirm submission to the admin?";

    await ctx.replyWithMarkdown(reviewMessage, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🚀 Submit Report", callback_data: "confirm_finalize" }],
          [{ text: "➕ Add More", callback_data: "add_more_tasks" }]
        ]
      }
    });

  } catch (err) {
    console.error("CRITICAL ERROR IN /DONE:", err);
    ctx.reply("❌ Something went wrong while generating your review.");
  }
});

// Handle the "Submit Report" button
bot.action('confirm_finalize', async (ctx) => {
  console.log("📥 Submit button clicked!");
  try {
    const telegramId = ctx.from.id;
    const user = await getUserState(telegramId);

    // 1. Mark the summary as final in the database
    const { error } = await supabase
      .from('daily_summaries')
      .update({ is_final: true, updated_at: new Date().toISOString() })
      .eq('id', user.active_summary_id);

    if (error) throw error;

    // 2. Clear the user's active state so they can start fresh tomorrow

    await updateUserState(telegramId, 'IDLE', null);

    await ctx.answerCbQuery("✅ Report Submitted!");
    await ctx.editMessageText("🚀 **Report Submitted Successfully!**\nYour daily tasks have been locked and sent to the admin.");
    
  } catch (err) {
    console.error("Finalize Error:", err);
    await ctx.answerCbQuery("❌ Submission failed.");
  }
});

// Handle the "Add More" button
bot.action('add_more_tasks', async (ctx) => {
  try {
    const user = await getUserState(ctx.from.id);
    await updateUserState(ctx.from.id, 'AWAITING_TITLE', user.active_summary_id);
    
    await ctx.answerCbQuery();
    await ctx.reply("1️⃣ **Task Title?**\n(What else did you work on today?)");
  } catch (err) {
    console.error("Add More Error:", err);
  }
});

bot.command('report', async (ctx) => {
  try {
    const telegramId = ctx.from.id;
    const user = await getOrCreateUser(telegramId);

    if (!['admin', 'ceo'].includes(user.role)) {
      return ctx.reply('⛔ <b>Access Denied</b>', { parse_mode: 'HTML' });
    }

    const report = await getTodayReport();
    if (!report || report.length === 0) return ctx.reply('📭 <b>No Activity Today</b>', { parse_mode: 'HTML' });

    let message = `📊 <b>Daily Team Report</b>\n📅 ${new Date().toLocaleDateString()}\n👥 <b>Team Status Overview</b>\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const row of report) {

      console.log("DEBUG RAW ROW:", JSON.stringify(row, null, 2));

      const name = row.users?.name || 'Unknown';
      const dept = row.users?.department || 'N/A';
      const checkIn = row.check_in_time ? new Date(row.check_in_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
      
      // Accessing the most recent summary if it exists
      const summaryData = row.daily_summaries?.[0];

      // Logic: If there is an AI summary, it's finished (✅). If just raw tasks, it's drafting (⏳).
      let icon = '❌'; 
      if (row.check_in_time) {
        icon = summaryData?.ai_summary ? '✅' : '⏳';
      }

      message += `${icon} <b>${name}</b> (${dept})\n`;
      message += `🕐 Check-in: ${checkIn}\n`;

      if (summaryData) {
        if (summaryData.ai_summary) {
          // AI Summary is already pre-formatted by the AI Agent
          message += `🤖 <b>Summary:</b>\n${summaryData.ai_summary}\n\n`;
        } 
        else if (summaryData.tasks && summaryData.tasks.length > 0) {
          const taskList = summaryData.tasks.map(t => `• ${t.title}`).join('\n');
          message += `📝 <b>Raw Tasks (Drafting):</b>\n${taskList}\n\n`;
        } 
        else {
          message += `⚠️ <i>Checked in, but no tasks entered.</i>\n\n`;
        }
      } else {
        message += `⚠️ <i>No report started yet.</i>\n\n`;
      }
    }

    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 <b>Generated at:</b> ${new Date().toLocaleTimeString()}`;
    
    await ctx.reply(message, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('REPORT ERROR:', err);
    await ctx.reply('❌ <b>Report Generation Failed</b>', { parse_mode: 'HTML' });
  }
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const user = await getUserState(ctx.from.id);
  const state = user.current_step;

  try {
    switch (state) {
      case 'AWAITING_TITLE':
        const tId = ctx.from.id;
        await addTaskTitle(user.active_summary_id, user.id, tId, text);
        await updateUserState(ctx.from.id, 'AWAITING_STATUS', user.active_summary_id);
        ctx.reply("2️⃣ **Status?**\n1) Not started\n2) In progress\n3) Completed");
        break;

      case 'AWAITING_STATUS':
        const statusMap = { '1': 'Not started', '2': 'In progress', '3': 'Completed' };
        await updateLastTask(user.active_summary_id, { status: statusMap[text] || text });
        await updateUserState(ctx.from.id, 'AWAITING_PROGRESS', user.active_summary_id);
        ctx.reply("3️⃣ **Progress %?** (Type 0 or /skip to skip)");
        break;

      case 'AWAITING_PROGRESS':
        try {
          const tId = ctx.from.id;
          // Check if user skipped or sent a non-number
          let progressValue = parseInt(text);
          
          if (text.toLowerCase() === 'skip' || isNaN(progressValue)) {
            progressValue = null; // Set to null in the database
          }

          await updateLastTask(user.active_summary_id, { progress: progressValue });
          
          // Move to next step (Blockers)
          await updateUserState(tId, 'AWAITING_BLOCKER', user.active_summary_id);
          ctx.reply("4️⃣ **Any Blockers?**\n(Type your blocker or /skip if none)");
        } catch (err) {
          console.error("Progress update error:", err);
          ctx.reply("❌ Error saving progress.");
        }
        break;

      case 'AWAITING_BLOCKER':
        const blocker = text.toLowerCase() === '/skip' ? null : text;
        await updateLastTask(user.active_summary_id, { blocker_reason: blocker });
        await updateUserState(ctx.from.id, 'AWAITING_PLAN', user.active_summary_id);
        ctx.reply("5️⃣ **Next step / plan?** (Type /skip if not needed)");
        break;

      case 'AWAITING_PLAN':
        const plan = text.toLowerCase() === '/skip' ? null : text;
        await updateLastTask(user.active_summary_id, { next_step: plan });
        await updateUserState(ctx.from.id, 'AWAITING_ADD_OR_DONE', user.active_summary_id);
        ctx.reply("✅ **Task saved.**\n\n• /add → add another task\n• /done → review & submit");
        break;
    }
  } catch (err) {
    console.error(err);
    ctx.reply("❌ Error saving data. Try /add again.");
  }
});


// Edit Summary command
bot.command('editsummary', async (ctx) => {
  try {
    const telegramId = ctx.from.id;
    const firstName = ctx.from.first_name || 'there';
    const user = await getOrCreateUser(telegramId);

    const text = ctx.message.text.replace('/editsummary', '').trim();

    if (!text) {
      const helpMessage = `✏️ *Edit Daily Summary*\n\nHi ${firstName}, do you want to edit your today's summary?\n\n📤 *Options:*\n• /editsummary skip - Cancel editing\n• /editsummary Your updated work description here...\n\n💡 *Tips for a good summary:*\n• List your main accomplishments\n• Mention any challenges faced\n• Describe what you learned\n• Keep it detailed but concise`;
      return ctx.reply(helpMessage, { parse_mode: 'Markdown' });
    }

    // Check if user wants to skip
    if (text.toLowerCase() === 'skip') {
      return ctx.reply('✅ *Edit cancelled*\n\nNo changes made to your summary.\n\n💡 *Tip:* You can edit anytime today if you need to update your work description.', 
      { parse_mode: 'Markdown' });
    }

    // Validate summary length
    if (text.length < 20) {
      return ctx.reply('⚠️ *Too short!*\n\nPlease provide a more detailed summary (at least 20 characters).\n\nYour summary helps us understand your work better.', 
      { parse_mode: 'Markdown' });
    }

    if (text.length > 1000) {
      return ctx.reply('⚠️ *Too long!*\n\nPlease keep your summary under 1000 characters.\n\nFocus on the most important aspects of your work.', 
      { parse_mode: 'Markdown' });
    }

    const updatedSummary = await editSummary(user.id, text);

    const successMessage = `✅ *Summary updated successfully!*

👤 ${firstName}
📅 ${new Date().toLocaleDateString()}
⏰ Updated at: ${new Date().toLocaleTimeString()}

Your daily summary has been updated!

💡 *Next steps:*
• /editsummary - Keep editing
• /finalize - Lock and submit final summary

💡 *Tip:* Keep up the great work!`;
    await ctx.reply(successMessage, { parse_mode: 'Markdown' });
    
  } catch (err) {
    if (err.message === 'NO_CHECKIN') {
      return ctx.reply('⚠️ *Check-in required!*\n\nYou must /checkin before editing a summary.\n\nThis helps us track your daily work routine properly.', 
      { parse_mode: 'Markdown' });
    }

    if (err.message === 'NO_SUMMARY_FOUND') {
      return ctx.reply('⚠️ *No summary found!*\n\nYou haven\'t submitted a summary yet today.\n\nUse /summary to submit your first summary, then you can edit it.', 
      { parse_mode: 'Markdown' });
    }

    console.error('EDIT SUMMARY ERROR:', err);
    await ctx.reply('❌ *Update failed*\n\nSomething went wrong while updating your summary.\n\nPlease try again or contact support.', 
    { parse_mode: 'Markdown' });
  }
});

bot.command('finalize', async (ctx) => {
  try {
    const telegramId = ctx.from.id
    const firstName = ctx.from.first_name || 'there'
    const user = await getOrCreateUser(telegramId)

    await finalizeSummary(user.id)

    await ctx.reply(
      `🔒 *Summary Finalized!*\n\nGreat job, ${firstName}!\n\n✅ Your daily summary has been *locked* and submitted.\n🛠️ No further edits are allowed for today.\n\n� *Next step:* Use /view to see your finalized summary.\n\n�📊 Admins can now review your work.`,
      { parse_mode: 'Markdown' }
    )
  } catch (err) {
    if (err.message === 'NO_CHECKIN') {
      return ctx.reply('⚠️ You must /checkin before finalizing your summary.')
    }

    if (err.message === 'NO_EDITABLE_SUMMARY') {
      return ctx.reply('⚠️ No editable summary found.\n\nEither you already finalized it or you haven’t submitted one yet.')
    }

    console.error('FINALIZE ERROR:', err)
    await ctx.reply('❌ Failed to finalize summary. Please try again.')
  }
})

bot.command('view', async (ctx) => {
  const userId = ctx.from.id;
  const today = new Date().toISOString().split('T')[0];

  try {
    // 1. Fetch the finalized summary by joining with attendance
    const { data, error } = await supabase
      .from('summaries')
      .select(`
        summary,
        updated_at,
        attendance!inner (
          date,
          telegram_user_id
        )
      `)
      .eq('attendance.telegram_user_id', userId)
      .eq('attendance.date', today)
      .eq('is_final', true) // Crucial: only show the final version
      .single(); // We only expect one final summary per day

    if (error || !data) {
      return ctx.reply("📂 No finalized summary found for today. Use /summary to create one or /finalize to lock your draft.");
    }

    // 2. Format the output
    const time = new Date(data.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const viewMessage = `
✅ *Your Finalized Summary*
📅 *Date:* ${today}
🕒 *Finalized at:* ${time}

📝 *Content:*
${data.summary}

_Note: Since this is finalized, you cannot edit it further without admin permission._
    `;

    ctx.replyWithMarkdown(viewMessage);

  } catch (err) {
    console.error('VIEW ERROR:', err);
    ctx.reply("⚠️ Error retrieving your summary.");
  }
});

// Help command
bot.command('help', async (ctx) => {
  try {
    const telegramId = ctx.from.id;
    const user = await getOrCreateUser(telegramId);
    const firstName = ctx.from.first_name || 'there';

    let commands = [];
    
    if (['ceo', 'admin'].includes(user.role)) {
      commands = [
        '📊 /report - View daily team report',
        '🆘 /help - Show this help message',
        '🔄 /start - Restart and see welcome message'
      ];
    } else {
      commands = [
        '✅ /checkin - Mark your attendance',
        '📝 /daily - Start daily report',
        '🆘 /help - Show this help message',
        '🔄 /start - Restart and see welcome message'
      ];
    }

    const helpMessage = `🤖 *Bot Help for ${firstName}*\n\n📋 *Available Commands:*\n${commands.join('\n')}\n\n💡 *Management Role:*\n📊 View team reports and monitor attendance\n\n❓ *Need help?* Contact your team admin.`;
    
    await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('HELP ERROR:', err);
    await ctx.reply('❌ Failed to load help. Please try again.');
  }
});




bot.launch();
console.log('🚀 Telegram Bot is running...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));