import { supabase } from './supabase.js'

export const submitSummary = async (userId) => {
  const today = new Date().toISOString().split('T')[0]

  // 1. Get today's attendance
  const { data: attendance, error: attErr } = await supabase
    .from('attendance')
    .select('*')
    .eq('user_id', userId)
    .eq('date', today)
    .single()

  if (attErr || !attendance) {
    throw new Error('NO_CHECKIN')
  }

  return async (summaryText) => {
    // 2. Check if summary already exists for this attendance
    const { data: existingSummary, error: checkErr } = await supabase
      .from('daily_summaries')
      .select('*')
      .eq('attendance_id', attendance.id)
      .single()

    let data;
    let error;

    if (existingSummary) {
      // Update existing summary
      const result = await supabase
        .from('daily_summaries')
        .update({ 
          summary: summaryText,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingSummary.id)
        .select()
        .single()
      
      data = result.data
      error = result.error
    } else {
      // Insert new summary
      const result = await supabase
        .from('daily_summaries')
        .insert({
          user_id: userId,
          attendance_id: attendance.id,
          summary: summaryText,
          version: 1
        })
        .select()
        .single()
      
      data = result.data
      error = result.error
    }

    if (error) throw error

    // 3. Mark attendance as submitted
    const { error: updateError } = await supabase
      .from('attendance')
      .update({ submitted: true })
      .eq('id', attendance.id)

    if (updateError) {
      console.error('ATTENDANCE UPDATE FAILED:', updateError)
      throw updateError
    }

    return data
  }
}

export const editSummary = async (userId, newSummaryText) => {
  const today = new Date().toISOString().split('T')[0]
  // 1. Get today's attendance
  const { data: attendance, error: attErr } = await supabase
    .from('attendance')
    .select('*')
    .eq('user_id', userId)
    .eq('date', today)
    .limit(1)
    .single()

  if (attErr || !attendance) {
    console.log('EDIT SUMMARY - No attendance found:', { userId, today, attErr })
    throw new Error('NO_CHECKIN')
  }

  console.log('EDIT SUMMARY - Found attendance:', attendance.id)

  // 2. Get the summary for this attendance
  const { data: existingSummary, error: summaryErr } = await supabase
    .from('daily_summaries')
    .select('*')
    .eq('attendance_id', attendance.id)
    .eq('is_final', false)
    .order('updated_at', { ascending: false })
    .limit(1)
    .single()

  console.log('EDIT SUMMARY - Summary query result:', { existingSummary, summaryErr })

  if (summaryErr || !existingSummary) {
    throw new Error('NO_SUMMARY_FOUND')
  }

  // 3. Update the summary
  const { data, error } = await supabase
    .from('daily_summaries')
    .update({ 
      summary: newSummaryText,
      updated_at: new Date().toISOString()
    })
    .eq('id', existingSummary.id)
    .eq('user_id', userId)
    .select()
    .single()

  if (error) {
  console.error('SUPABASE UPDATE ERROR:', error)
  throw error
}

  return data
}

export const finalizeSummary = async (userId) => {
  const today = new Date().toISOString().split('T')[0]

  // 1. Get today's attendance
  const { data: attendance, error: attErr } = await supabase
    .from('attendance')
    .select('*')
    .eq('user_id', userId)
    .eq('date', today)
    .single()

  if (attErr || !attendance) {
    throw new Error('NO_CHECKIN')
  }

  // 2. Get latest non-final summary
  const { data: summary, error: summaryErr } = await supabase
    .from('daily_summaries')
    .select('*')
    .eq('attendance_id', attendance.id)
    .eq('is_final', false)
    .order('updated_at', { ascending: false })
    .limit(1)
    .single()

  if (summaryErr || !summary) {
    throw new Error('NO_EDITABLE_SUMMARY')
  }

  // 3. Finalize it
  console.log('FINALIZE - Target summary:', summary)
  const { data, error } = await supabase
    .from('daily_summaries')
    .update({
      is_final: true,
      version: summary.version + 1,
      updated_at: new Date().toISOString()
    })
    .eq('id', summary.id)
    .eq('user_id', userId)
    .select()
    .single()

  if (error) {
  console.error('SUPABASE FINALIZE UPDATE ERROR:', error)
  throw error
}


  return data
}
