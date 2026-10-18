// Supabase connection for Tap-In Welcome.
// The anon (public) key is designed to be used in web pages; access is controlled by the rules in supabase/setup.sql.
// Never put the service_role key here.
window.TAPIN_CONFIG = {
  SUPABASE_URL: "https://ncfgthjozyombclfjxmk.supabase.co",
  SUPABASE_ANON_KEY: "PASTE-ANON-PUBLIC-KEY-HERE"
};
