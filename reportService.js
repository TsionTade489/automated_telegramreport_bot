import { supabase } from './supabase.js';

// This is the function the error is complaining about
export const getTodayReport = async () => {
  // Get start of today in local time
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

  const { data, error } = await supabase
    .from('attendance')
    .select(`
      id,
      check_in_time,
      users (name, department),
      daily_summaries (
        id,
        ai_summary,
        is_final
      )
    `)
    .gte('check_in_time', startOfDay); // This ensures we get everything from 00:00 today

  if (error) throw error;
  return data;
};

// Functions for the NEW Task-by-Task flow
export const createDailySummary = async (userId, attendanceId) => {
  const { data, error } = await supabase
    .from('daily_summaries')
    .insert([{
       user_id: userId, 
       attendance_id: attendanceId,
       summary: "",
       is_final: false 
      }])
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const addTaskTitle = async (summaryId, userId, telegramId, title) => {
  const { data, error } = await supabase
    .from('tasks')
    .insert([
      { 
        summary_id: summaryId, 
        user_id: userId, 
        telegram_id: telegramId, 
        title: title 
      }
    ])
    .select()
    .single();

  if (error) throw error;
  return data;
};

export const updateLastTask = async (summaryId, updateData) => {
  const { data: lastTask } = await supabase
    .from('tasks')
    .select('id')
    .eq('summary_id', summaryId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!lastTask) return;

  const { error } = await supabase
    .from('tasks')
    .update(updateData)
    .eq('id', lastTask.id);
  if (error) throw error;
};

export const getSessionTasks = async (summaryId) => {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('summary_id', summaryId)
    .order('created_at', { ascending: true });
  
  if (error) {
    console.error("Supabase Error in getSessionTasks:", error);
    throw error;
  }
  return data;
};