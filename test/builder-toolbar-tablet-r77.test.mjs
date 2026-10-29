// r77: on tablet widths (721-1279px) the builder header's Units/Grid/View/Work group was one unbreakable
// row (~1040px wide) and made the whole PAGE scroll sideways at 768/1024 (scrollWidth 1052). The fix lets
// header .hgroup wrap inside the toolbar only in that range; >=1280 must stay untouched.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const css = readFileSync(new URL('../public/builder.css', import.meta.url), 'utf8');
const m = css.match(/@media \(min-width:721px\) and \(max-width:1279\.98px\)\{([^}]*\})/);
assert.ok(m, 'tablet-only header media block exists');
assert.match(m[1], /header \.hgroup\{[^}]*flex-wrap:wrap/, 'header groups wrap on tablet');
assert.match(m[1], /min-width:0/, 'groups may shrink below content width');
assert.doesNotMatch(m[1], /overflow-x/, 'no inner scroller that would clip header menus');
const html = readFileSync(new URL('../public/builder.html', import.meta.url), 'utf8');
assert.match(html, /builder\.css\?v=36/, 'builder.css cache-bust bumped');
console.log('builder-toolbar-tablet-r77: ok');
