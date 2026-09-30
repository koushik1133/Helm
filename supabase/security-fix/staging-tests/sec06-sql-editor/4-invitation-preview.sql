-- BLOCK 4 — invitation_preview as a signed-out visitor (anon)
set role anon;
select c.case_name, p.preview,
       (select coalesce(bool_or(k in ('email','id','invitation_id','org_id','invited_by','inviter','inviter_email','token')), false)
          from jsonb_object_keys(p.preview) k) as exposes_private_field,
       case when (select coalesce(bool_or(k in ('email','id','invitation_id','org_id','invited_by','inviter','inviter_email','token')), false)
                    from jsonb_object_keys(p.preview) k) then 'FAIL'
            when p.preview->>'status' = c.want_status and (p.preview->>'valid')::boolean = c.want_valid then 'PASS' else 'FAIL' end as result
from (values
  ('malformed',                '0000',                 'not_found', false),
  ('nonexistent 48-char',      repeat('9',48),         'not_found', false),
  ('valid pending',            repeat('e',47)||'1',    'pending',   true),
  ('expired',                  repeat('e',47)||'2',    'pending',   false),
  ('accepted',                 repeat('e',47)||'3',    'accepted',  false),
  ('revoked',                  repeat('e',47)||'4',    'revoked',   false)
) as c(case_name, tok, want_status, want_valid)
cross join lateral (select public.invitation_preview(c.tok) as preview) p;
