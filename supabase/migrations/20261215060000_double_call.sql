-- =====================================================================
-- 📞⚠️ Double-call warning
--   Before a call from the app: has someone else talked to (or written a
--   note on) this lead in the last N minutes? Then the app warns: "Rahim
--   called 12 minutes ago. Call again?" An admin sets it all in
--   Settings → Calls; "Call anyway" can go into the change log.
-- =====================================================================

insert into public.app_settings (key, value, description)
values (
  'double_call',
  '{"enabled": true, "minutes": 30, "count_attempts": false, "count_notes": true,
    "count_whatsapp": false, "own": false, "log_anyway": true}'::jsonb,
  'Double-call warning: someone talked to this lead in the last N minutes'
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- The latest contact by someone else within the window (null = none / off)
--   Runs with the caller's own rights: only leads, calls and notes they
--   may see count.
-- ---------------------------------------------------------------------
create or replace function public.recent_contact(p_lead uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  s jsonb;
  mins int;
  since timestamptz;
  own boolean;
  me uuid := auth.uid();
  c record;
  n record;
  best jsonb := null;
  call_obj jsonb := null;
  best_at timestamptz := null;
  last_note text;
begin
  select value into s from public.app_settings where key = 'double_call';
  if s is null or not coalesce((s->>'enabled')::boolean, false) then return null; end if;
  mins := greatest(1, least(coalesce((s->>'minutes')::int, 30), 1440));
  since := now() - make_interval(mins => mins);
  own := coalesce((s->>'own')::boolean, false);

  -- 📞 calls (talked; or any attempt; WhatsApp when chosen)
  select cl.called_at, cl.user_id, cl.outcome, cl.duration_sec, cl.channel, cl.direction
    into c
  from public.call_logs cl
  where cl.lead_id = p_lead
    and cl.deleted_at is null
    and cl.called_at >= since
    and (own or cl.user_id is distinct from me)
    and (cl.channel = 'phone' or (cl.channel = 'whatsapp' and coalesce((s->>'count_whatsapp')::boolean, false)))
    and (cl.outcome in ('connected', 'message') or coalesce((s->>'count_attempts')::boolean, false))
  order by cl.called_at desc
  limit 1;
  if found then
    best_at := c.called_at;
    call_obj := jsonb_build_object(
      'at', c.called_at, 'user_id', c.user_id, 'outcome', c.outcome,
      'duration_sec', c.duration_sec, 'channel', c.channel, 'direction', c.direction,
      'user_name', (select p.full_name from public.profiles p where p.id = c.user_id)
    );
    best := jsonb_build_object('kind', 'call', 'at', c.called_at, 'user_id', c.user_id);
  end if;

  -- 📝 notes and 🎙 voice notes
  if coalesce((s->>'count_notes')::boolean, true) then
    select * into n from (
      select a.created_at as at, a.user_id as by_user, 'note'::text as kind
      from public.lead_activity a
      where a.lead_id = p_lead and a.action = 'note_added' and a.created_at >= since
        and (own or a.user_id is distinct from me)
      union all
      select f.created_at, f.uploaded_by, 'voice'
      from public.lead_files f
      where f.lead_id = p_lead and f.kind = 'voice' and f.deleted_at is null and f.created_at >= since
        and (own or f.uploaded_by is distinct from me)
    ) x
    order by at desc
    limit 1;
    if found and (best_at is null or n.at > best_at) then
      best_at := n.at;
      best := jsonb_build_object('kind', n.kind, 'at', n.at, 'user_id', n.by_user);
    end if;
  end if;

  if best is null then return null; end if;

  select ll.note_text into last_note from public.lead_last ll where ll.lead_id = p_lead;

  return best || jsonb_build_object(
    'user_name', (select p.full_name from public.profiles p where p.id = (best->>'user_id')::uuid),
    'minutes_ago', greatest(0, floor(extract(epoch from (now() - best_at)) / 60))::int,
    'window', mins,
    'last_note', last_note,
    'call', call_obj,
    'log_anyway', coalesce((s->>'log_anyway')::boolean, true)
  );
end;
$$;

revoke all on function public.recent_contact(uuid) from public, anon;
grant execute on function public.recent_contact(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- "Call anyway" → the change log (when Settings says so)
-- ---------------------------------------------------------------------
create or replace function public.log_double_call(p_lead uuid, p_other uuid, p_minutes int, p_kind text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l record;
  s jsonb;
begin
  select value into s from public.app_settings where key = 'double_call';
  if s is null or not coalesce((s->>'log_anyway')::boolean, true) then return; end if;

  select * into l from public.leads where id = p_lead and deleted_at is null;
  if not found
     or not (public.can_view_lead(l.assigned_to) or public.leads_shared_mode() or l.created_by = auth.uid()) then
    raise exception 'Lead not found.';
  end if;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (
    p_lead, auth.uid(), 'double_call',
    jsonb_build_object(
      'other_user', p_other,
      'other_name', (select full_name from public.profiles where id = p_other),
      'minutes', p_minutes,
      'kind', p_kind
    )
  );
end;
$$;

revoke all on function public.log_double_call(uuid, uuid, int, text) from public, anon;
grant execute on function public.log_double_call(uuid, uuid, int, text) to authenticated;
