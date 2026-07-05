import { createClient } from '@supabase/supabase-js';

// NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be
// added to apps/web/.env.local (values from your Supabase project settings).
// They are safe to expose in the browser — the publishable key is the anon key.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  realtime: { timeout: 30000 },
});
