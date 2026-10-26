-- =====================================================================
-- Fix: users cannot write to lead_activity directly.
-- The timeline lines for follow-ups are now written by a trigger
-- (like every other timeline line), not by the functions.
-- =====================================================================

-- 1. Timeline trigger on follow_ups
create or replace function public.log_follow_up_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.lead_id, auth.uid(), 'follow_up_set', jsonb_build_object('due_at', new.due_at));

  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'cancelled' then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.lead_id, auth.uid(), 'follow_up_cancelled', '{}'::jsonb);
  end if;

  return null;
end;
$$;

create trigger follow_ups_log_activity
  after insert or update on public.follow_ups
  for each row execute function public.log_follow_up_activity();

-- 2. schedule_follow_up without the direct timeline insert
create or replace function public.schedule_follow_up(
  p_lead_id uuid,
  p_due_at  timestamptz,
  p_note    text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.is_active_user() then
    raise exception 'Your account is not active.';
  end if;

  update public.follow_ups
     set status = 'rescheduled', completed_at = now(), completed_by = auth.uid()
   where lead_id = p_lead_id and status = 'pending';

  insert into public.follow_ups (lead_id, due_at, note)
  values (p_lead_id, p_due_at, nullif(trim(p_note), ''))
  returning id into v_id;

  return v_id;
end;
$$;

-- 3. cancel_follow_up without the direct timeline insert
create or replace function public.cancel_follow_up(p_lead_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.follow_ups
     set status = 'cancelled', completed_at = now(), completed_by = auth.uid()
   where lead_id = p_lead_id and status = 'pending';
end;
$$;

notify pgrst, 'reload schema';