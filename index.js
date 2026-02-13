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

const isAfterReportingCutoff = () => {
  const now = new Date();
  // Ethiopia is UTC+3. Get current Ethiopia hour.
  const ethiopiaHour = (now.getUTCHours() + 3) % 24;
  const ethiopiaMinutes = now.getUTCMinutes();
  
  // Cutoff at 19:30 (7:30 PM)
  return (ethiopiaHour > 19 || (ethiopiaHour === 19 && ethiopiaMinutes >= 30));
};

// The "Start" command
bot.start(async (ctx) => {
  try {
    const telegramId = ctx.from.id;
    const user = await getOrCreateUser(telegramId);
    const firstName = ctx.from.first_name || 'there';


    if (['admin'].includes(user.role)) {
      const excluded = ['ceo', 'CEO', 'ceo ', 'CEO ', 'innovation', 'innovation ', 'Innovation', 'General', 'General '];
     
      const { data, error } = await supabase
        .from('users')
        .select('department')
        .eq('active', true)
        .not('department', 'in', `(${excluded.join(',')})`);

      if (error) {
          console.error("Error fetching departments:", error);
          return ctx.reply("❌ Error loading departments.");
         }

      const departments = [...new Set(
        data
          .map(u => u.department)
          .filter(Boolean)
      )];

      const buttons = departments.map(dep => [{
        text: dep,
        callback_data: `select_dep_${dep}`
      }]);

      return ctx.reply(
        ` <b>Welcome ${user.role.toUpperCase()} ${firstName}</b>\n\nPlease select a team: Tech, Creative, Digital, admin`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: buttons }
        }
      );
    }

    const message = ` <b>Welcome ${firstName}!</b>\nLet's get your day organized.`;
    const commands = [
      '/checkin - Mark your attendance',
      '/daily - Plan your goals for today',
      '/start_day - Lock in goals and start working',
      '/done - Review goals and checkout',
      '/help - See all available commands'
    ];

    await ctx.reply(
      `${message}\n\n<b>Available Commands:</b>\n${commands.join('\n')}`,
      { parse_mode: 'HTML' }
    );

  } catch (err) {
    console.error('Bot Error:', err);
    await ctx.reply('❌ Something went wrong.');
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
      `<b>Check-in successful!</b>\n\n` +
      `<b>Time:</b> ${etTime}\n` +
      `<b>Welcome,</b> ${firstName}\n\n` +
      `<b>Next Step:</b> Use /daily to list your goals for today.`,
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
    // We fetch the user first to get the correct UUID for the database query
    const user = await getOrCreateUser(telegramId); 

    // 1. Look for unfinished reports from previous days
    const { data: unfinished, error: unError } = await supabase
      .from('daily_summaries')
      .select('id, created_at')
      .eq('user_id', user.id) // Use user.id (UUID), not telegramId
      .eq('is_final', false)
      .lt('created_at', new Date().toISOString().split('T')[0])
      .order('created_at', { ascending: false })
      .maybeSingle(); // Use maybeSingle() so it doesn't throw error if empty

    if (unError) console.error("Unfinished check error:", unError);

    if (unfinished) {
      return ctx.reply("⚠️ <b>You forgot to update and checkout the last time!</b>\nWould you like to continue with your previous tasks or start a fresh report for today?", {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Continue Previous Tasks", callback_data: `resume_${unfinished.id}` }],
            [{ text: "🆕 Start New Task (Fresh)", callback_data: "start_fresh" }]
          ]
        }
      });
    }
      
    // 2. Fetch Today's Attendance ID
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

    // 3. Check if they already started a report today
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
      await ctx.reply(" <b>Daily Planning Started</b>\n\nPlease send your <b>first goal</b> for today:", { parse_mode: 'HTML' });
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
    
    await ctx.reply(" <b>Goals locked in!</b>\nYour plan has been saved. Go crush it! \n\n💡If you want to add more tasks use /add and ONLY use /done LATER today to update your progress and checkout.", { parse_mode: 'HTML' });
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

    if (!user || !user.active_summary_id) {
      return ctx.reply(" <b>No active report found.</b>\n\nPlease type /daily first to start today's session.", { parse_mode: 'HTML' });
    }

    // UPDATED: Now points to PLANNING for quick entry
    await updateUserState(telegramId, 'PLANNING', user.active_summary_id);
    
    ctx.reply(" <b>Quick Add Mode</b>\nSend your task title below. You can send multiple tasks one by one.\n\nType /start_day when you are finished.", { parse_mode: 'HTML' });

  } catch (err) {
    console.error("Add Command Error:", err);
    ctx.reply("❌ Error preparing task entry.");
  }
});

bot.command('done', async (ctx) => {

  console.log(" /done interactive checklist triggered by:", ctx.from.id);
  
  try {

      if (isAfterReportingCutoff()) {
      return ctx.reply("🌙 <b>Reporting Window Closed.</b>\nIt is past 7:30 PM. You forgot to update your tasks today. Please wait until tomorrow morning to check in again.", { parse_mode: 'HTML' });
    }

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
      ` <b>Updating Task:</b> "${task.title}"\n\n` +
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
      if (isAfterReportingCutoff()) {
    await ctx.answerCbQuery("🌙 Reporting window closed.");
    return ctx.editMessageText("🌙 <b>Window Closed.</b>\nSubmission is no longer allowed tonight. Please speak with your Admin in the morning.", { parse_mode: 'HTML' });
  }

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
    await ctx.editMessageText(" <b>Report Submitted Successfully!</b>\nAdmin report categories are now synced.", { parse_mode: 'HTML' });
    
  } catch (err) {
    console.error("Finalize Error:", err);
    await ctx.answerCbQuery("❌ Submission failed.");
  }
});

bot.action(/resume_(.+)/, async (ctx) => {
  try {
    const oldSummaryId = ctx.match[1];

    await supabase
      .from('daily_summaries')
      .update({ created_at: new Date().toISOString() })
      .eq('id', oldSummaryId);

    await updateUserState(ctx.from.id, 'PLANNING', oldSummaryId);

    await ctx.answerCbQuery("Yesterday's tasks restored!");

    await ctx.editMessageText(
      " <b>Yesterday's tasks have been moved to today.</b>\nYou can now add more tasks or use /done to manage them.",
      { parse_mode: 'HTML' }
    );

  } catch (err) {
    console.error("Resume error:", err);
    await ctx.reply("❌ Failed to resume tasks.");
  }
});

bot.action('start_fresh', async (ctx) => {
  const telegramId = ctx.from.id;
  
  // 1. Mark previous unfinished reports as 'Abandoned' or simply finalized to clear them
  await supabase.from('daily_summaries')
    .update({ is_final: true, notes: 'Abandoned via fresh start' })
    .eq('user_id', telegramId)
    .eq('is_final', false);

  await ctx.answerCbQuery("Starting fresh...");
  await ctx.editMessageText(" <b>New Day Started!</b>\nPlease list your tasks for today.");
  // Trigger your normal /daily task input flow here
});

// Helper to request report from n8n
const triggerN8nReport = async (ctx, reportType) => {
  try {
    const telegramId = ctx.from.id;
    const user = await getOrCreateUser(telegramId);

    if (!['admin'].includes(user.role?.toLowerCase())) {
      return ctx.reply(' <b>Access Denied</b>', { parse_mode: 'HTML' });
    }

    if (!user.selected_department) {
      return ctx.reply(
        '⚠️ Please select a team first using /start',
        { parse_mode: 'HTML' }
      );
    }

    await ctx.reply(
      ` <b>Generating ${reportType.toUpperCase()} report for ${user.selected_department}…</b>`,
      { parse_mode: 'HTML' }
    );

    await axios.post(
      'https://n8n.blihmarketing.com/webhook/daily-summary-trigger',
      {
        command: reportType,
        department: user.selected_department,   
        chat_id: ctx.chat.id
      }
    );

  } catch (err) {
    console.error('REPORT TRIGGER ERROR:', err);
    await ctx.reply('❌ <b>Failed to generate report</b>', { parse_mode: 'HTML' });
  }
};

bot.action(/select_dep_(.+)/, async (ctx) => {
  try {
    const department = ctx.match[1];

    await supabase
      .from('users')
      .update({ selected_department: department })
      .eq('telegram_id', ctx.from.id);

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `<b>${department}</b> selected.\n\nNow you can use:\n` +
      `/today_report\n` +
      `/weekly_report`,
      { parse_mode: 'HTML' }
    );

  } catch (err) {
    console.error("Department select error:", err);
    ctx.reply("❌ Failed to select department.");
  }
});

bot.command('today_report', (ctx) =>
  triggerN8nReport(ctx, 'daily')
);

bot.command('weekly_report', (ctx) => {
  if (new Date().getDay() !== 6) {
    return ctx.reply(
      ' <b>Weekly reports are only available on Saturdays.</b>',
      { parse_mode: 'HTML' }
    );
  }
  triggerN8nReport(ctx, 'weekly');
});

// Help command
bot.command('help', async (ctx) => {
  try {
    const telegramId = ctx.from.id;
    const user = await getOrCreateUser(telegramId);
    const firstName = ctx.from.first_name || 'there';

    let commands = [];
    
    if (['admin'].includes(user.role)) {
      commands = [
        '/today_report - View daily team report',
        '/weekly_report - View weekly team report',
        '/help - Show this help message',
        '/start - Restart and see welcome message'
      ];
    } else {
      commands = [
        '/checkin - Mark your attendance',
        '/daily - Start daily report',
        '/help - Show this help message',
        '/start - Restart and see welcome message'
      ];
    }

    const helpMessage = ` *Bot Help for ${firstName}*\n\n *Available Commands:*\n${commands.join('\n')}\n\n *Management Role:*\n View team reports and monitor attendance\n\n❓ *Need help?* Contact your team admin.`;
    
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