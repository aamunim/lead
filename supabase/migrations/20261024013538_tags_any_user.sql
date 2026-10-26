-- =====================================================================
-- Any active user (callers too) can create new tags.
-- Editing, switching off and reordering tags stays with admins
-- (the existing policies are not changed).
-- =====================================================================
create policy "tags: any active user can add"
  on public.tags for insert
  to authenticated
  with check (
    public.is_active_user()
    and length(trim(name)) between 1 and 40
  );

notify pgrst, 'reload schema';