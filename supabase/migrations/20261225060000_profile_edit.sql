-- =====================================================================
-- 👤 Profile editing: everyone edits their own name, phone, email and
--   photo (More → My profile); admins edit everyone's (Users → a person).
--   Role, team and status stay as they are (protect_profile_fields).
--   Your own email: Supabase sends a confirm link. An admin changing
--   someone else's email: set at once (admin_set_user_email).
-- =====================================================================

-- An admin sets another person's sign-in email (no confirm link)
create or replace function public.admin_set_user_email(p_user uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_role  text;
begin
  if not public.has_permission('users.manage') then raise exception 'Only admins can change this.'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That email doesn''t look right.'; end if;
  select role_key into v_role from public.profiles where id = p_user;
  if not found then raise exception 'User not found.'; end if;
  if v_role = 'super_admin' and public.current_role_key() is distinct from 'super_admin' then
    raise exception 'Only the Super Admin can change a Super Admin''s email.';
  end if;
  if exists (select 1 from auth.users where lower(email) = v_email and id <> p_user) then
    raise exception 'Someone already signs in with %.', v_email;
  end if;

  update auth.users set email = v_email where id = p_user;
  -- newer Supabase also keeps the email in the sign-in identity
  begin
    execute 'update auth.identities set identity_data = identity_data || jsonb_build_object(''email'', $1)
             where user_id = $2 and provider = ''email''' using v_email, p_user;
  exception when others then
    null;
  end;
  update public.profiles set email = v_email where id = p_user;
end;
$$;
grant execute on function public.admin_set_user_email(uuid, text) to authenticated;

-- 📷 Profile photos: a public bucket (small pictures of staff), folder = the person's id
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do nothing;

    execute 'drop policy if exists "avatars: own or admin upload" on storage.objects';
    execute $p$create policy "avatars: own or admin upload" on storage.objects for insert to authenticated
      with check (bucket_id = 'avatars' and ((storage.foldername(name))[1] = auth.uid()::text or public.has_permission('users.manage')))$p$;
    execute 'drop policy if exists "avatars: own or admin change" on storage.objects';
    execute $p$create policy "avatars: own or admin change" on storage.objects for update to authenticated
      using (bucket_id = 'avatars' and ((storage.foldername(name))[1] = auth.uid()::text or public.has_permission('users.manage')))$p$;
    execute 'drop policy if exists "avatars: own or admin remove" on storage.objects';
    execute $p$create policy "avatars: own or admin remove" on storage.objects for delete to authenticated
      using (bucket_id = 'avatars' and ((storage.foldername(name))[1] = auth.uid()::text or public.has_permission('users.manage')))$p$;
  end if;
end $$;

notify pgrst, 'reload schema';
