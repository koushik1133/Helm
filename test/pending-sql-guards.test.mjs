// Guards for supabase/PENDING-SQL-ALL.sql: the owner pastes this file into the Supabase SQL
// editor, so it must stay additive, idempotent, ASCII-only and self-verifying.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "..", "supabase", "PENDING-SQL-ALL.sql"), "utf8");

// remove "-- ..." comments (no string literal in this file contains two dashes)
const noComments = raw.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
// remove dollar-quoted bodies (function bodies / DO blocks); leftmost tag wins, so $outer$ eats nested $f$
const stripBodies = (s) => s.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, " ");
const topLevel = stripBodies(noComments);

test("file is pure ASCII", () => {
  const bad = [...raw].findIndex((c) => c.charCodeAt(0) > 127);
  assert.equal(bad, -1, "non-ASCII character at index " + bad);
});

test("no destructive statements at top level (outside comments and function bodies)", () => {
  const rules = [
    [/\bdrop\s+table\b/i, "DROP TABLE"],
    [/\bdelete\s+from\b/i, "DELETE FROM"],
    [/\btruncate\b/i, "TRUNCATE"],
    [/\balter\s+table\b[^;]*\bdrop\b/i, "ALTER TABLE ... DROP"],
    [/(^|;)\s*update\s+\S/i, "UPDATE"],
    [/\bdrop\s+(column|schema|function|index|trigger)\b/i, "DROP object"],
  ];
  for (const [re, name] of rules) assert.ok(!re.test(topLevel), "top-level " + name + " found");
});

test("function bodies never delete or truncate; only one allowed constraint swap", () => {
  assert.ok(!/\bdelete\s+from\b/i.test(noComments), "DELETE FROM anywhere");
  assert.ok(!/\btruncate\b/i.test(noComments), "TRUNCATE anywhere");
  assert.ok(!/\bdrop\s+table\b/i.test(noComments), "DROP TABLE anywhere");
  const drops = noComments.match(/\balter\s+table\b[^;]*\bdrop\b[^;]*/gi) || [];
  for (const d of drops) {
    assert.match(d, /drop\s+constraint\s+invitations_role_chk/i, "unexpected ALTER TABLE ... DROP: " + d);
  }
  assert.ok(drops.length <= 1, "only the invitations_role_chk swap may drop anything");
});

test("every executable section has a PRE-CHECK and a VERIFY query with an expected result", () => {
  const parts = raw.split(/^-- SECTION (\d+)\b/m);
  const secs = [];
  for (let i = 1; i < parts.length; i += 2) secs.push({ n: Number(parts[i]), body: parts[i + 1] });
  assert.ok(secs.length >= 10, "expected sections 1..13, found " + secs.length);
  for (const s of secs) {
    const head = s.body.split("\n", 1)[0];
    const isStub = /\(stub\)/i.test(head);
    if (isStub) continue;
    // an executable section runs to the OWNER-DECISION banner at most
    const body = s.body.split("-- OWNER-DECISION SECTIONS")[0];
    assert.match(body, new RegExp("-- VERIFY " + s.n + "\\b"), "section " + s.n + " lacks a VERIFY comment");
    const afterVerify = body.slice(body.search(new RegExp("-- VERIFY " + s.n + "\\b")));
    assert.match(afterVerify, /\bselect\b/i, "section " + s.n + " VERIFY has no select");
    assert.match(afterVerify, /-- expected:/i, "section " + s.n + " VERIFY has no expected result");
    assert.match(body, /PRE-CHECK/, "section " + s.n + " lacks a PRE-CHECK");
  }
});

test("stub sections are fully commented out", () => {
  const i = raw.indexOf("-- SECTION 11 (stub)");
  assert.ok(i > 0, "stub sections missing");
  const tail = raw.slice(i).split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"));
  assert.deepEqual(tail, [], "executable text after the owner-decision stubs");
});

test("every CREATE UNIQUE INDEX is partial (has a WHERE)", () => {
  const stmts = noComments.match(/create\s+unique\s+index[^;]*;/gi) || [];
  assert.ok(stmts.length >= 5, "expected the five duplicate-guard indexes");
  for (const s of stmts) assert.match(s, /\bwhere\b/i, "non-partial unique index: " + s.replace(/\s+/g, " "));
});

test("idempotency: indexes use IF NOT EXISTS, columns use ADD COLUMN IF NOT EXISTS, constraints are guarded", () => {
  for (const s of noComments.match(/create\s+(unique\s+)?index[^;]*;/gi) || []) {
    assert.match(s, /if\s+not\s+exists/i, "index without IF NOT EXISTS: " + s.replace(/\s+/g, " "));
  }
  for (const s of topLevel.match(/alter\s+table[^;]*add\s+column[^;]*;/gi) || []) {
    assert.match(s, /add\s+column\s+if\s+not\s+exists/i, "ADD COLUMN without IF NOT EXISTS");
  }
  // constraint additions only inside guarded DO blocks (none at top level)
  assert.ok(!/alter\s+table[^;]*add\s+constraint/i.test(topLevel), "unguarded ADD CONSTRAINT at top level");
  // the chat cap must stay NOT VALID so existing rows are never rewritten or scanned
  assert.match(noComments, /chat_messages_body_len_chk[\s\S]*?not valid/i);
});

test("no temp tables or session state", () => {
  assert.ok(!/create\s+(temp|temporary)\s+table/i.test(noComments));
  assert.ok(!/(^|;)\s*set\s+(local\s+|session\s+)?(search_path|role|session)\b/i.test(topLevel), "top-level SET");
  assert.ok(!/\bbegin\s*;|\bcommit\s*;/i.test(topLevel), "explicit transaction control");
});

test("replaced SECURITY DEFINER functions keep a pinned search_path", () => {
  const fns = noComments.match(/create or replace function[\s\S]*?\$(\w*)\$[\s\S]*?\$\1\$/gi) || [];
  for (const f of fns) {
    if (/security\s+definer/i.test(f)) assert.match(f, /set\s+search_path/i, "definer without search_path");
  }
});
