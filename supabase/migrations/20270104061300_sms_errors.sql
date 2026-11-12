-- =====================================================================
-- 📨 SMS: a clear reason when the company's address is wrong
--   A wrong send / balance address gave back a whole web page (HTML
--   "404 Page") as the reason. Now: "HTTP 404: this address was not found
--   at the SMS company …" and only the page's title is kept.
-- =====================================================================

-- the reason for one answer (null = it is fine)
create or replace function public.sms_answer_problem(p_status int, p_content text, p_timed_out boolean, p_error text)
returns text
language sql
immutable
as $$
  select case
    when p_error is not null then left(p_error, 300)
    when coalesce(p_timed_out, false) then 'No answer from the SMS company (timed out)'
    when p_status is null then 'No answer from the SMS company'
    when p_status = 404 then 'HTTP 404: this address was not found at the SMS company. Check the address in Settings → SMS (the API page of your SMS account shows the right one).'
    when p_status in (401, 403) then 'HTTP ' || p_status || ': the SMS company did not accept the API key (or this server''s IP). Check the key in Settings → SMS.'
    when p_status >= 500 then 'HTTP ' || p_status || ': the SMS company had a problem. Try again later.'
    when coalesce(p_content, '') ~* '^\s*<(!doctype|html)' then
      'HTTP ' || p_status || ': the SMS company sent a web page, not an API answer. Check the address in Settings → SMS.'
    when p_status not between 200 and 299 then 'HTTP ' || p_status || ': ' || left(coalesce(p_content, ''), 200)
  end;
$$;

-- a web page → its title only; anything else as it came (shortened)
create or replace function public.sms_answer_text(p_content text, p_max int default 500)
returns text
language sql
immutable
as $$
  select case
    when coalesce(p_content, '') ~* '^\s*<(!doctype|html)' then
      '(a web page' || coalesce(': ' || nullif(trim(substring(p_content from '(?i)<title>([^<]*)</title>')), ''), '') || ')'
    else left(p_content, p_max)
  end;
$$;

create or replace function public.sms_read_answers()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r      record;
  v_prob text;
begin
  if to_regclass('net._http_response') is not null then
    for r in execute $q$
      select m.id, h.status_code, h.content, h.timed_out, h.error_msg, p.success_match
      from public.sms_messages m
      join net._http_response h on h.id = m.request_id
      left join public.sms_batches b on b.id = m.batch_id
      left join public.sms_providers p on p.id = b.provider_id
      where m.status = 'sending'
      limit 2000
    $q$
    loop
      v_prob := public.sms_answer_problem(r.status_code, r.content, r.timed_out, r.error_msg);
      if v_prob is null and r.success_match is not null and coalesce(r.content, '') !~* r.success_match then
        v_prob := 'The SMS company''s answer does not say sent: ' || left(public.sms_answer_text(r.content), 200);
      end if;
      update public.sms_messages
         set status = case when v_prob is null then 'sent' else 'failed' end,
             http_status = r.status_code,
             response = public.sms_answer_text(r.content),
             error = left(v_prob, 300),
             done_at = now()
       where id = r.id;
    end loop;
  end if;
  -- no answer in 15 minutes (the answer was lost): failed, can be sent again
  update public.sms_messages
     set status = 'failed', error = 'No answer from the SMS company', done_at = now()
   where status = 'sending' and sent_at < now() - interval '15 minutes';
end;
$$;
revoke all on function public.sms_read_answers() from public, anon, authenticated;

create or replace function public.sms_balance_result(p_request bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  if to_regclass('net._http_response') is null or p_request is null then return null; end if;
  execute 'select status_code, content, timed_out, error_msg from net._http_response where id = $1'
    into r using p_request;
  if r is null then return null; end if;   -- not back yet
  return jsonb_build_object('status', r.status_code,
                            'body', public.sms_answer_text(r.content, 1000),
                            'error', replace(public.sms_answer_problem(r.status_code, r.content, r.timed_out, r.error_msg),
                                             'Check the address in', 'Check the balance address in'));
end;
$$;
revoke all on function public.sms_balance_result(bigint) from public, anon;
grant execute on function public.sms_balance_result(bigint) to authenticated;

-- the SMS that already failed with a whole web page as the reason: the short reason
update public.sms_messages
   set error = left(public.sms_answer_problem(http_status, response, false, null), 300),
       response = public.sms_answer_text(response)
 where status = 'failed' and response ~* '^\s*<(!doctype|html)';

notify pgrst, 'reload schema';
