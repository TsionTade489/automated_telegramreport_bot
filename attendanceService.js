import { supabase } from './supabase.js'

export const checkIn = async (telegramId) => {
  const today = new Date().toISOString().split('T')[0];

  // 1. Set the RLS context
  await supabase.rpc('set_app_context', { tg_id: telegramId.toString() });

  // 2. Get the internal UUID for the user
  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('telegram_id', telegramId)
    .single();

  if (!user) throw new Error('USER_NOT_FOUND');

  // 3. Try to insert the check-in
  const { error } = await supabase
    .from('attendance') // or whatever your table is named
    .insert({
      user_id: user.id,
      telegram_id: telegramId,
      check_in_time: new Date().toISOString(), // Ensure you provide all NOT NULL columns
      date: today
    });

  if (error) {
    // If the error code is 23505, it means a unique constraint (like one check-in per day) was hit
    if (error.code === '23505') throw new Error('ALREADY_CHECKED_IN');
    throw error;
  }
};