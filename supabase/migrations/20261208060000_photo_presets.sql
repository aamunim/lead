-- =====================================================================
-- 🖼 Photo Studio (website): sizes people save for everyone
--   app_settings.photo_presets = [{ id, name, width, height, unit, dpi,
--   face_pct, top_pct, bg, max_kb, format }]
--   Read: everyone signed in (as every setting). Change: admins and the
--   Admission Officer (the same people as Upload rules).
-- =====================================================================

create or replace function public.set_photo_presets(p_presets jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_edit_upload_rules() then
    raise exception 'Only admins and the Admission Officer can change this.';
  end if;
  if p_presets is null or jsonb_typeof(p_presets) <> 'array' then
    raise exception 'The sizes must be a list.';
  end if;
  if jsonb_array_length(p_presets) > 60 then
    raise exception 'At most 60 saved sizes.';
  end if;
  insert into public.app_settings (key, value)
  values ('photo_presets', p_presets)
  on conflict (key) do update set value = excluded.value;
end;
$$;

grant execute on function public.set_photo_presets(jsonb) to authenticated;

notify pgrst, 'reload schema';
