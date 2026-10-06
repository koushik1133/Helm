-- ============================================================================
-- 0024_injection_guards.sql — CANONICAL forward-only. Security audit Phase 6
-- (injection / XSS). The pages now escape these values (that is the real fix);
-- these checks stop bad data from being stored at all, so no other screen can
-- trip on it later:
--   chat reaction emoji ....... short, no HTML characters, no spaces
--   chat photo / voice path ... must be our own storage key <org>/<chat>/<file>.<ext>,
--                               never an outside URL (stops "read-tracking" pixels)
--   menu package dishes ....... must be a list (anything else broke the package
--                               picker and apply_menu_template)
-- NOT VALID: existing rows are NOT re-checked and nothing is changed or deleted;
-- only new or edited rows must pass. Idempotent.
-- ============================================================================

do $$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'chat_reactions_emoji_chk' and conrelid = 'public.chat_reactions'::regclass) then
    alter table public.chat_reactions add constraint chat_reactions_emoji_chk
      check (char_length(emoji) between 1 and 16 and emoji !~ '[<>&"''[:space:]]') not valid;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'chat_messages_media_path_chk' and conrelid = 'public.chat_messages'::regclass) then
    alter table public.chat_messages add constraint chat_messages_media_path_chk
      check (media_path is null
             or media_path ~* '^[0-9a-f-]{36}/[0-9a-f-]{36}/[a-z0-9-]{1,64}\.[a-z0-9]{2,5}$') not valid;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'menu_templates_dishes_array_chk' and conrelid = 'public.menu_templates'::regclass) then
    alter table public.menu_templates add constraint menu_templates_dishes_array_chk
      check (jsonb_typeof(dishes) = 'array') not valid;
  end if;
end $$;

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select conname, convalidated from pg_constraint
--  where conname in ('chat_reactions_emoji_chk','chat_messages_media_path_chk','menu_templates_dishes_array_chk');
