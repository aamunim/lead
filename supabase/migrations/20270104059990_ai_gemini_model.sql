-- =====================================================================
-- 🔧 Gemini: a retired model ("This Gemini model was not found")
--   Google still lists the retired 1.0 / 1.5 models, and "Test" could pick
--   one. A model saved like that moves to Gemini 2.5 Flash; from now on the
--   server itself moves to the best model the key may use when the chosen
--   one is gone (and saves it, so Settings → AI shows it).
-- =====================================================================

update public.app_settings
   set value = jsonb_set(value, '{gemini,model}', '"models/gemini-2.5-flash"')
 where key = 'ai_providers'
   and value -> 'gemini' ->> 'model' ~* 'gemini-1\.';

-- The server saves the Gemini model it moved to
create or replace function public.ai_set_gemini_model(p_model text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.app_settings
     set value = jsonb_set(value, '{gemini,model}', to_jsonb(p_model))
   where key = 'ai_providers' and nullif(trim(p_model), '') is not null;
$$;
revoke all on function public.ai_set_gemini_model(text) from public, anon, authenticated;
grant execute on function public.ai_set_gemini_model(text) to service_role;

-- Leads that failed only because of the missing model: try again
update public.lead_chances
   set status = 'pending', attempts = 0, error = null, due_at = now(), requested_at = now()
 where status = 'failed' and error like '%Gemini model was not found%';
update public.admission_credits
   set status = 'pending', attempts = 0, error = null, requested_at = now()
 where status = 'failed' and error like '%Gemini model was not found%';
