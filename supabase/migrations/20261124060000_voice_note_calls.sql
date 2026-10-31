-- =====================================================================
-- 🎙 A voice note recorded in the call popup belongs to that call
--   The popup records first and saves the call after, so the app links
--   them once the call is saved: only my own voice notes, on the same
--   lead, not linked yet.
-- =====================================================================
create or replace function public.link_voice_notes(p_file_ids uuid[], p_call_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update public.lead_files f
     set call_id = p_call_id
   where f.id = any (p_file_ids)
     and f.kind = 'voice'
     and f.call_id is null
     and f.deleted_at is null
     and f.uploaded_by = auth.uid()
     and f.lead_id = (select c.lead_id from public.call_logs c where c.id = p_call_id);
  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on function public.link_voice_notes(uuid[], uuid) to authenticated;

notify pgrst, 'reload schema';
