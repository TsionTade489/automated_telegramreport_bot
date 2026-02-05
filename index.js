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
import { session } from 'telegraf/session';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN || '8513662828:AAHXmaJk9x1lxuY1Ou4rIrSNirSWWERthVA';
const bot = new Telegraf(token);
bot.use(session());
// The "Start" command
bot.start(async (ctx) => {
  try {
    const telegramId = ctx.from.id;
    const user = await getOrCreateUser(telegramId);
    const firstName = ctx.from.first_name || 'there';

    let message = '';
    let commands = [];
    
    if (user.role === 'ceo') {
      message = `👑 <b>Welcome CEO ${firstName}!</b>\nFull access granted.`;
      commands = [
        '📊 /report - View daily team report'
      ];
    } else if (user.role === 'admin') {
      message = `🛠️ <b>Welcome Admin ${firstName}!</b>\nYou can manage team reports.`;
      commands = [
        '📊 /report - View daily team report'
      ];
    } else {
      message = `👋 <b>Welcome ${firstName}!</b>\nLet's get your day organized.`;
      commands = [
        '✅ /checkin - Mark your attendance',
        '📝 /daily - Plan your goals for today',
        '🚀 /start_day - Lock in goals and start working',
        '🏁 /done - Review goals and checkout',
        '❓ /help - See all available commands'
      ];
    }

    let callToAction = '';
    if (['ceo', 'admin'].includes(user.role)) {
      callToAction = '💡 <b>Tip:</b> Use /report to see who is active right now.';
    } else {
      callToAction = '💡 <b>Getting Started:</b>\n1. Use /checkin first.\n2. Use /daily to list your goals.\n3. Type /start_day when your list is ready!';
    }

    const fullMessage = `${message}\n\n📋 <b>Available Commands:</b>\n${commands.join('\n')}\n\n${callToAction}`;
    
    await ctx.reply(fullMessage, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('Bot Error:', err);
    await ctx.reply('❌ Something went wrong. Please try again later.');
  }
});

// The "Check In" command
bot.command('checkin', async (ctx) => {
  try {
    const telegramId = ctx.from.id
    const firstName = ctx.from.first_name || 'there'

    await getOrCreateUser(telegramId)
    await checkIn(telegramId)

    const now = new Date()
    const etTime = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Africa/Addis_Ababa',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }).format(now)

    await ctx.reply(
      `✅ <b>Check-in successful!</b>\n\n` +
      `🕐 <b>Time:</b> ${etTime}\n` +
      `👤 <b>Welcome,</b> ${firstName}\n\n` +
      `📝 <b>Next Step:</b> Use /daily to list your goals for today.`,
      { parse_mode: 'HTML' }
    )

  } catch (err) {
    console.error('❌ CHECKIN ERROR:', err)

    if (err.message === 'ALREADY_CHECKED_IN') {
      return ctx.reply(
        `⚠️ <b>Already checked in today!</b>\n\n` +
        `You can proceed with /daily to plan your goals or /start_day if you've already listed them.`,
        { parse_mode: 'HTML' }
      )
    }

    await ctx.reply(
      `❌ <b>Check-in failed</b>\n\n${err.message}`,
      { parse_mode: 'HTML' }
    )
  }
})


// 1. Updated /daily Command
bot.command('daily', async (ctx) => {
  try {
    const telegramId = ctx.from.id;
    const user = await getOrCreateUser(telegramId);
    
    // 1. Fetch Today's Attendance ID
    const todayStr = new Date().toISOString().split('T')[0];
    const { data: attendance, error: attError } = await supabase
      .from('attendance')
      .select('id')
      .eq('user_id', user.id)
      .gte('check_in_time', todayStr)
      .maybeSingle();

    if (attError) throw attError;
    if (!attendance) {
      return ctx.reply("❌ <b>Check-in first!</b>\nUse /checkin before starting your report.", { parse_mode: 'HTML' });
    }

    // 2. Date Range Check
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

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
      await ctx.reply("⚠️ <b>You have an active planning session.</b>\nSend another goal or type /start_day to finish.", { parse_mode: 'HTML' });
    } else {
      const summary = await createDailySummary(user.id, attendance.id);
      summaryId = summary.id;
      // THE NEW ASK:
      await ctx.reply("🎯 <b>Daily Planning Started</b>\n\nPlease send your <b>first goal</b> for today:", { parse_mode: 'HTML' });
    }

    // Set state to PLANNING
    await updateUserState(telegramId, 'PLANNING', summaryId);

  } catch (err) {
    console.error("Daily Command Error:", err);
    ctx.reply("❌ Failed to start daily report.");
  }
});

// 1.5 Start Day Command - "Locks in" the plan
bot.command('start_day', async (ctx) => {
  try {
    const telegramId = ctx.from.id;
    const userState = await getUserState(ctx.from.id);

    if (userState?.current_step !== 'PLANNING') {
      return ctx.reply("⚠️ You aren't in planning mode. Type /daily to start your plan for today.");
    }

    // Move state to IDLE so they can work. They can still use /add if they forgot something.
    await updateUserState(ctx.from.id, 'IDLE', userState.active_summary_id);
    
    await ctx.reply("🚀 <b>Goals locked in!</b>\nYour plan has been saved. Go crush it! \n\n💡 Use /done later today to update your progress and checkout.", { parse_mode: 'HTML' });
  } catch (err) {
    console.error("Start Day Error:", err);
    ctx.reply("❌ Error starting your work day.");
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
  console.log("🏁 /done interactive checklist triggered by:", ctx.from.id);
  
  try {
    const userState = await getUserState(ctx.from.id);
    
    // 1. Validation: Ensure there is an active session
    if (!userState || !userState.active_summary_id) {
      return ctx.reply("⚠️ You don't have an active report. Type /daily to start planning your day.");
    }

    // 2. Call the helper function to fetch tasks and render the UI
    // This will bring back ALL tasks added during /daily or /add
    await renderChecklist(ctx, userState.active_summary_id);

  } catch (err) {
    console.error("CRITICAL ERROR IN /DONE:", err);
    ctx.reply("❌ Something went wrong while loading your task checklist.");
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

bot.action(/toggle_(.+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {}); 
  
  try {
    const taskId = ctx.match[1];
    const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).single();

    // 1. Set the user state to start the interview immediately
    await updateUserState(ctx.from.id, 'AWAITING_CHECKOUT_STATUS', task.summary_id);
    
    // 2. Store the Task ID in the session
    ctx.session = ctx.session || {};
    ctx.session.currentEditingTaskId = taskId;

    // 3. Ask the first question WITHOUT changing the DB yet
    return ctx.reply(
      `📉 <b>Updating Task:</b> "${task.title}"\n\n` +
      `1️⃣ <b>What is the current status?</b>\n` +
      `1) Not started\n` +
      `2) In progress\n` +
      `3) Blocked / Waiting\n` +
      `4) Completed`, 
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.error("Toggle Error:", err);
  }
});

bot.action('confirm_finalize', async (ctx) => {
  console.log("📥 Finalizing and sending to n8n...");
  try {
    const telegramId = ctx.from.id;
    const user = await getUserState(telegramId);

    // 1. Fetch summary AND all tasks for this session
    const { data: summaryRecord } = await supabase
      .from('daily_summaries')
      .select('attendance_id')
      .eq('id', user.active_summary_id)
      .single();

    const tasks = await getSessionTasks(user.active_summary_id);

    // 2. CATEGORIZE TASKS (The Fix!)
    // We strictly filter by the 'Completed' status we set in the toggle
    const completedTasks = tasks.filter(t => t.status === 'Completed').map(t => t.title);
    const pendingTasks = tasks.filter(t => t.status !== 'Completed').map(t => ({
      title: t.title,
      status: t.status || 'In Progress',
      progress: t.progress || 0,
      blocker: t.blocker_reason || 'None'
    }));

    // 3. TRIGGER N8N with Structured Data
    const N8N_WEBHOOK_URL = 'https://n8n.blihmarketing.com/webhook/daily-summary-trigger';
    const payload = {
      summary_id: user.active_summary_id,
      attendance_id: summaryRecord.attendance_id,
      user_name: ctx.from.first_name,
      telegram_id: ctx.from.id,
      // Sending categorized data so n8n/AI doesn't have to guess
      completed_tasks: completedTasks,
      pending_tasks: pendingTasks,
      total_count: tasks.length
    };

    try {
      await axios.post(N8N_WEBHOOK_URL, payload);
      console.log("✅ n8n Response: 200 OK with categorized data");
    } catch (e) {
      console.error("❌ n8n Request Error:", e.message);
    }

    // 4. Mark as final and clear state
    await supabase.from('daily_summaries')
      .update({ is_final: true, updated_at: new Date().toISOString() })
      .eq('id', user.active_summary_id);

    await updateUserState(telegramId, 'IDLE', null);

    await ctx.answerCbQuery("✅ Report Submitted!");
    await ctx.editMessageText("🚀 <b>Report Submitted Successfully!</b>\nAdmin report categories are now synced.", { parse_mode: 'HTML' });
    
  } catch (err) {
    console.error("Finalize Error:", err);
    await ctx.answerCbQuery("❌ Submission failed.");
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

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const userState = await getUserState(ctx.from.id);
  const state = userState?.current_step;

  // --- 1. MORNING PLANNING MODE ---
  if (state === 'PLANNING') {
    try {
      if (!userState.active_summary_id) {
        return ctx.reply("❌ Session lost. Please type /daily to restart.");
      }

      const { error } = await supabase.from('tasks').insert([{
        summary_id: userState.active_summary_id, 
        user_id: userState.id,
        telegram_id: ctx.from.id,
        title: text,
        status: 'Not started'
      }]);

      if (error) throw error;
      
      return ctx.reply(`✅ <b>Goal saved:</b> "${text}"\n\nAdd another or type /start_day.`, { parse_mode: 'HTML' });
    } catch (err) {
      console.error("Insert Error:", err.message);
      return ctx.reply("❌ Database Error: Could not save goal.");
    }
  }

  // --- 2. SWITCH CASE HANDLERS ---
  try {
    // Helper to get the ID we are currently editing from session
    const currentTaskId = ctx.session?.currentEditingTaskId;

    switch (state) {
      // --- EVENING CHECKOUT QUESTIONS (Triggered by Toggle) ---
      case 'AWAITING_CHECKOUT_STATUS': {
          const taskId = ctx.session?.currentEditingTaskId;
          
          if (!taskId) {
            return ctx.reply("❌ Error: I lost track of which task you are editing. Please click the button again.");
          }

          const statusMap = { 
            '1': 'Not started', 
            '2': 'In progress', 
            '3': 'Blocked', 
            '4': 'Completed' 
          };
          
          const finalStatus = statusMap[text] || text;

          // Crucial: Use the taskId from session to update the specific row
          const { error } = await supabase
            .from('tasks')
            .update({ status: finalStatus })
            .eq('id', taskId);

          if (error) {
            console.error("Update Status Error:", error);
            return ctx.reply("❌ Failed to update status in database.");
          }

          if (finalStatus === 'Completed') {
            await supabase.from('tasks').update({ progress: 100, blocker_reason: null }).eq('id', taskId);
            await updateUserState(ctx.from.id, 'IDLE', userState.active_summary_id);
            await ctx.reply("✅ Task marked as Completed!");
            return renderChecklist(ctx, userState.active_summary_id);
          }

          await updateUserState(ctx.from.id, 'AWAITING_CHECKOUT_PROGRESS', userState.active_summary_id);
          ctx.reply("2️⃣ Progress (Type a number 0-99)");
          break;
        }
      case 'AWAITING_CHECKOUT_PROGRESS': {
        const progressVal = parseInt(text) || 0;
        await supabase.from('tasks').update({ progress: progressVal }).eq('id', currentTaskId);
        
        await updateUserState(ctx.from.id, 'AWAITING_CHECKOUT_BLOCKER', userState.active_summary_id);
        ctx.reply("3️⃣ Any Blockers (Type your blocker or /skip)");
        break;
      }

      case 'AWAITING_CHECKOUT_BLOCKER': {
        const blockerStr = text.toLowerCase() === '/skip' ? null : text;
        await supabase.from('tasks').update({ blocker_reason: blockerStr }).eq('id', currentTaskId);
        
        // Reset state to IDLE
        await updateUserState(ctx.from.id, 'IDLE', userState.active_summary_id);
        
        await ctx.reply("✅ Task details updated!");
        
        // REFRESH CHECKLIST: Shows the task with the ⬜ icon now
        await renderChecklist(ctx, userState.active_summary_id);
        break;
      }

      // --- MANUAL /add COMMAND QUESTIONS ---
      case 'AWAITING_TITLE': {
        const { data } = await addTaskTitle(userState.active_summary_id, userState.id, ctx.from.id, text);
        // Store the new task ID in session so the next steps know which one to update
        if (ctx.session) ctx.session.currentEditingTaskId = data.id;
        
        await updateUserState(ctx.from.id, 'AWAITING_STATUS', userState.active_summary_id);
        ctx.reply("2️⃣ **Status?**\n1) Not started\n2) In progress\n3) Completed");
        break;
      }

      case 'AWAITING_STATUS': {
        const statusMap = { '1': 'Not started', '2': 'In progress', '3': 'Completed' };
        const statusValue = statusMap[text] || text;
        
        await supabase.from('tasks').update({ status: statusValue }).eq('id', currentTaskId);
        
        await updateUserState(ctx.from.id, 'AWAITING_PROGRESS', userState.active_summary_id);
        ctx.reply("3️⃣ **Progress %?** (Type 0 or /skip to skip)");
        break;
      }

      case 'AWAITING_PROGRESS': {
        let pVal = parseInt(text);
        if (text.toLowerCase() === 'skip' || isNaN(pVal)) pVal = null;
        
        await supabase.from('tasks').update({ progress: pVal }).eq('id', currentTaskId);
        
        await updateUserState(ctx.from.id, 'AWAITING_BLOCKER', userState.active_summary_id);
        ctx.reply("4️⃣ **Any Blockers?**\n(Type your blocker or /skip if none)");
        break;
      }

      case 'AWAITING_BLOCKER': {
        const bStr = text.toLowerCase() === '/skip' ? null : text;
        await supabase.from('tasks').update({ blocker_reason: bStr }).eq('id', currentTaskId);
        
        await updateUserState(ctx.from.id, 'AWAITING_PLAN', userState.active_summary_id);
        ctx.reply("5️⃣ **Next step / plan?** (Type /skip if not needed)");
        break;
      }

      case 'AWAITING_PLAN': {
        const planStr = text.toLowerCase() === '/skip' ? null : text;
        await supabase.from('tasks').update({ next_step: planStr }).eq('id', currentTaskId);
        
        await updateUserState(ctx.from.id, 'IDLE', userState.active_summary_id);
        await ctx.reply("✅ <b>Task saved to your list!</b>", { parse_mode: 'HTML' });
        await renderChecklist(ctx, userState.active_summary_id);
        break;
      }
    }
  } catch (err) {
    console.error("Switch State Error:", err);
    ctx.reply("❌ Error saving data. Please try again.");
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

async function renderChecklist(ctx, summaryId) {
  try {
    const tasks = await getSessionTasks(summaryId);

    if (!tasks || tasks.length === 0) {
      return ctx.reply("📂 No tasks found. Use /daily to add goals!");
    }

    let message = "🏁 <b>End of Day Update</b>\nUpdate the status of your planned tasks:";
    
    const keyboard = tasks.map(task => [
      { 
        text: `${task.status === 'Completed' ? '✅' : '⬜'} ${task.title}`, 
        callback_data: `toggle_${task.id}` 
      }
    ]);

    keyboard.push([{ text: "🚀 Submit Final Report", callback_data: "confirm_finalize" }]);
    keyboard.push([{ text: "➕ Add More", callback_data: "add_more_tasks" }]);

    const menu = {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    };

    if (ctx.callbackQuery) {
      // Use try-catch specifically for the edit call
      try {
        return await ctx.editMessageText(message, menu);
      } catch (err) {
        if (err.description && err.description.includes("message is not modified")) {
          // If message is the same, just answer the callback query so the loading spinner disappears
          return await ctx.answerCbQuery().catch(() => {});
        }
        throw err; // Rethrow if it's a different error
      }
    } else {
      return await ctx.reply(message, menu);
    }
  } catch (err) {
    console.error("Render Checklist Error:", err);
  }
}


bot.launch();
console.log('🚀 Telegram Bot is running...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));