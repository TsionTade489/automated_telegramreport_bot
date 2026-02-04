import { supabase } from './supabase.js'

export const getOrCreateUser = async (telegramId) => {
  // 1. Check if user exists
  const { data: existingUser, error: fetchError } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .single()

  if (fetchError && fetchError.code !== 'PGRST116') {
    throw fetchError
  }

  // 2. If exists → return
  if (existingUser) {
    return existingUser
  }

  // 3. Otherwise create user with default role
  const { data: newUser, error: insertError } = await supabase
  .from('users')
  .insert({
    telegram_id: telegramId,
    name: 'Telegram User',
    role: 'team',
    department: 'General',
    active: true
  })
  .select()
  .single()

  return newUser
}

export const updateUserState = async (telegramId, step, activeSummaryId = null) => {
  const { error } = await supabase
    .from('users')
    .update({ 
      current_step: step, 
      active_summary_id: activeSummaryId 
    })
    .eq('telegram_id', telegramId.toString());
  if (error) throw error;
};

export const getUserState = async (telegramId) => {
  const { data, error } = await supabase
    .from('users')
    .select('current_step, active_summary_id, id')
    .eq('telegram_id', telegramId.toString())
    .single();
  if (error) throw error;
  return data;
};
