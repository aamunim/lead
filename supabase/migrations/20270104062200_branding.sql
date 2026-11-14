-- =====================================================================
-- 🎨 Branding: the logo, names, words and colours on the sign-in page,
--   Home and the website, changed from Settings → Branding.
--   Only the Super Admin may change it. Everyone (also before sign-in)
--   may read it, but only these few public things (app_brand()).
--   The logo is a picture in the public "branding" storage folder.
-- =====================================================================

insert into public.app_settings (key, value)
values ('branding', '{}'::jsonb)
on conflict (key) do nothing;

-- Only the Super Admin changes the branding (Settings managers can read it)
create or replace function public.brand_setting_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.key = 'branding'
     and auth.uid() is not null
     and public.current_role_key() is distinct from 'super_admin'
     and new.value is distinct from old.value then
    raise exception 'Only a Super Admin can change the branding.';
  end if;
  return new;
end;
$$;

drop trigger if exists brand_setting_guard on public.app_settings;
create trigger brand_setting_guard
  before update on public.app_settings
  for each row execute function public.brand_setting_guard();

-- The public part, cleaned: short texts, real colours, a logo from our own folder
create or replace function public.app_brand()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
  r jsonb := '{}'::jsonb;
  k text;
  t text;
  pts jsonb := '[]'::jsonb;
  p jsonb;
begin
  select value into v from public.app_settings where key = 'branding';
  v := coalesce(v, '{}'::jsonb);
  if jsonb_typeof(v) <> 'object' then return r; end if;

  -- texts (empty = the app's own words)
  foreach k in array array['short_name', 'college', 'product', 'system', 'login_title', 'login_note', 'login_footer',
                           'web_title', 'copyright'] loop
    t := left(btrim(coalesce(v ->> k, '')), case when k in ('login_note', 'web_title') then 200 when k = 'short_name' then 20 else 120 end);
    if t <> '' then r := r || jsonb_build_object(k, t); end if;
  end loop;

  -- colours: #RRGGBB only
  foreach k in array array['hero_color', 'web_color', 'accent_color'] loop
    t := btrim(coalesce(v ->> k, ''));
    if t ~ '^#[0-9A-Fa-f]{6}$' then r := r || jsonb_build_object(k, upper(t)); end if;
  end loop;

  -- the logo: only a picture in our public branding folder
  t := btrim(coalesce(v ->> 'logo_url', ''));
  if t ~ '^https://[^/?#]+/storage/v1/object/public/branding/[A-Za-z0-9._/-]+$' then
    r := r || jsonb_build_object('logo_url', t);
  end if;

  -- website points (icon + text), at most 5
  if jsonb_typeof(v -> 'web_points') = 'array' then
    for p in select x from jsonb_array_elements(v -> 'web_points') x limit 50 loop
      exit when jsonb_array_length(pts) >= 5;
      t := left(btrim(coalesce(p ->> 'text', '')), 100);
      if t <> '' then
        pts := pts || jsonb_build_array(jsonb_build_object('icon', left(btrim(coalesce(p ->> 'icon', '')), 8), 'text', t));
      end if;
    end loop;
    r := r || jsonb_build_object('web_points', pts);
  end if;

  -- switches
  if jsonb_typeof(v -> 'home_greeting') = 'boolean' then
    r := r || jsonb_build_object('home_greeting', v -> 'home_greeting');
  end if;
  if jsonb_typeof(v -> 'home_names') = 'boolean' then
    r := r || jsonb_build_object('home_names', v -> 'home_names');
  end if;

  return r;
end;
$$;
revoke all on function public.app_brand() from public;
grant execute on function public.app_brand() to anon, authenticated;

-- 🖼 The logo folder: anyone may see it (the sign-in page), only the Super Admin adds or removes
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('branding', 'branding', true, 1048576, array['image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do nothing;

    execute 'drop policy if exists "branding: super admin upload" on storage.objects';
    execute $p$create policy "branding: super admin upload" on storage.objects for insert to authenticated
      with check (bucket_id = 'branding' and public.is_super_admin())$p$;
    execute 'drop policy if exists "branding: super admin change" on storage.objects';
    execute $p$create policy "branding: super admin change" on storage.objects for update to authenticated
      using (bucket_id = 'branding' and public.is_super_admin())$p$;
    execute 'drop policy if exists "branding: super admin remove" on storage.objects';
    execute $p$create policy "branding: super admin remove" on storage.objects for delete to authenticated
      using (bucket_id = 'branding' and public.is_super_admin())$p$;
  end if;
end $$;

notify pgrst, 'reload schema';
