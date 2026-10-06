-- ════════════════════════════════════════════════════════════════════════════
-- HELM — Security audit Phase 3 · P3-02 — READ-ONLY CHECK (changes nothing)
-- Old seed scripts (seed-users.sql / setup-all.sql / complete-setup.sql) created
-- accounts like admin@helm.com with the password "helm", and that value is
-- published in the public GitHub repos. This lists every account whose password
-- is still one of those well-known defaults. It only COMPARES hashes (bcrypt
-- crypt() check) — it never reads, prints or changes a password.
-- USE: production project → SQL Editor → paste → Run. Expect: 0 rows.
-- If any row appears: reset that person's password right away (Control Center →
-- Users → issue a temporary password, or Supabase → Authentication → Users →
-- "Send password recovery"), or remove the account if it's an unused demo one.
-- ════════════════════════════════════════════════════════════════════════════
select u.email,
       p.role,
       u.last_sign_in_at,
       u.created_at
  from auth.users u
  left join public.profiles p on p.id = u.id
 where u.encrypted_password is not null
   and u.encrypted_password <> ''
   and exists (
     select 1
       from unnest(array['helm','Helm','helm123','Helm@123','password','admin','admin123','123456','12345678','demo','test']) as d(pw)
      where u.encrypted_password = extensions.crypt(d.pw, u.encrypted_password)
   )
 order by p.role nulls last, u.email;
