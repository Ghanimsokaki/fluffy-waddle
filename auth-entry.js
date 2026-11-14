// Bundle the official Supabase client locally; credentials stay in the user's browser.
const { createClient } = require('@supabase/supabase-js');
window.createGembyClient = createClient;
