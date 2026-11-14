-- =====================================================================
-- 💰 SMS Center: the balance beside History
--   Anyone who may send SMS sees the SMS company's balance (only the
--   number, e.g. "5,054.40"). It is asked again each time SMS Center
--   opens, after a send, and on a tap. The last answer is kept so the
--   number shows at once; two people opening the page together ask the
--   company only once (10 seconds apart at most, unless tapped).
--   The API key and the company's full answer never reach the app.
-- =====================================================================

create table if not exists public.sms_balance_cache (
  id         int primary key default 1 check (id = 1),
  balance    text,
  checked_at timestamptz,
  req_id     bigint,
  asked_at   timestamptz
);
alter table public.sms_balance_cache enable row level security;   -- server only
revoke all on public.sms_balance_cache from anon, authenticated;

-- the number in the company's answer: {"Balance":"5,054.40", …} or plain text
create or replace function public.sms_balance_parse(p text)
returns text
language plpgsql
immutable
as $$
declare
  v text;
begin
  if coalesce(p, '') ~ '^\s*\{' then
    begin
      select e.value into v
      from jsonb_each_text(p::jsonb) e
      where lower(e.key) in ('balance', 'credit', 'credits', 'current_balance', 'sms_balance', 'remaining', 'amount')
      limit 1;
    exception when others then
      v := null;
    end;
  end if;
  if v is null then
    v := substring(coalesce(p, '') from '([0-9][0-9,]*(\.[0-9]+)?)');
  end if;
  return nullif(trim(v), '');
end;
$$;

create or replace function public.sms_balance_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.sms_can_send() or public.has_permission('settings.manage');
$$;
revoke all on function public.sms_balance_allowed() from public, anon;

-- the last number at once, and asks the company again → {balance, at, req}
create or replace function public.sms_balance_ask(p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.sms_providers;
  c public.sms_balance_cache;
  v_req bigint;
begin
  if not public.sms_balance_allowed() then raise exception 'You can''t see the SMS balance.'; end if;
  select * into c from public.sms_balance_cache where id = 1;

  select * into p from public.sms_providers where is_active;
  if p.id is null or p.balance_url is null or coalesce(p.api_key, '') = '' then
    return jsonb_build_object('balance', c.balance, 'at', c.checked_at, 'req', null, 'off', true);
  end if;

  -- someone asked a moment ago: wait for that answer instead of asking again
  if not coalesce(p_force, false) and c.asked_at > now() - interval '10 seconds' then
    return jsonb_build_object('balance', c.balance, 'at', c.checked_at, 'req', c.req_id);
  end if;

  v_req := public.sms_request('GET', public.sms_url(p.balance_url, p.api_key, '', '', ''));
  insert into public.sms_balance_cache (id, req_id, asked_at) values (1, v_req, now())
  on conflict (id) do update set req_id = excluded.req_id, asked_at = excluded.asked_at;
  return jsonb_build_object('balance', c.balance, 'at', c.checked_at, 'req', v_req);
end;
$$;
revoke all on function public.sms_balance_ask(boolean) from public, anon;
grant execute on function public.sms_balance_ask(boolean) to authenticated;

-- the company's answer to that ask → {done, balance, at, error}
create or replace function public.sms_balance_get(p_req bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.sms_balance_cache;
  r record;
  v text;
begin
  if not public.sms_balance_allowed() then raise exception 'You can''t see the SMS balance.'; end if;
  select * into c from public.sms_balance_cache where id = 1;
  -- only the latest ask (never any other web answer)
  if p_req is null or c.req_id is distinct from p_req then
    return jsonb_build_object('done', true, 'balance', c.balance, 'at', c.checked_at);
  end if;
  if to_regclass('net._http_response') is null then
    return jsonb_build_object('done', true, 'balance', c.balance, 'at', c.checked_at);
  end if;

  execute 'select status_code, content, timed_out, error_msg from net._http_response where id = $1'
    into r using p_req;
  if r is null then return jsonb_build_object('done', false); end if;

  if public.sms_answer_problem(r.status_code, r.content, r.timed_out, r.error_msg) is not null then
    return jsonb_build_object('done', true, 'balance', c.balance, 'at', c.checked_at, 'error', 'Could not get the balance.');
  end if;
  v := public.sms_balance_parse(r.content);
  if v is null then
    return jsonb_build_object('done', true, 'balance', c.balance, 'at', c.checked_at, 'error', 'Could not read the balance.');
  end if;
  update public.sms_balance_cache set balance = v, checked_at = now() where id = 1;
  return jsonb_build_object('done', true, 'balance', v, 'at', now());
end;
$$;
revoke all on function public.sms_balance_get(bigint) from public, anon;
grant execute on function public.sms_balance_get(bigint) to authenticated;

notify pgrst, 'reload schema';
