// smart-import.test.mjs — mapping engine on real-world sheets (Indian / UAE / US styles,
// reordered / missing / extra columns, messy values, blank rows, merged header rows, 5k rows),
// plus wiring guards for the UI, store and migration.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../public/smart-import-core.js');
let n = 0, bad = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { bad++; console.error("FAIL " + name + ": " + e.message.split("\n").slice(0, 4).join(" | ")); } };
const map = (entity, table) => {
  const h = C.detectHeader(table, entity);
  const body = table.slice(h.index + 1);
  const m = C.autoMap(entity, h.headers, body);
  const by = {}; m.forEach((x, c) => { by[h.headers[c]] = x.target === 'custom' ? 'custom:' + x.key : x.target; });
  return { h, m, by, built: C.buildRows(entity, table, h.index, m) };
};

/* ---------- value parsers ---------- */
t('amounts', () => {
  assert.equal(C.parseAmount('₹1,50,000.50'), 150000.5);
  assert.equal(C.parseAmount('$1,200'), 1200);
  assert.equal(C.parseAmount('AED 500'), 500);
  assert.equal(C.parseAmount('Rs. 450/-'), 450);
  assert.equal(C.parseAmount('1.5k'), 1500);
  assert.equal(C.parseAmount('2 lakh'), 200000);
  assert.equal(C.parseAmount('1.234,50'), 1234.5);
  assert.equal(C.parseAmount(''), null);
  assert.equal(C.parseAmount('N/A'), null);
  assert.ok(Number.isNaN(C.parseAmount('abc')));
  assert.equal(C.parseAmount(42), 42);
});
t('phones', () => {
  assert.equal(C.parsePhone('+91 98765 43210').value, '+919876543210');
  assert.equal(C.parsePhone('098480 12345').value, '9848012345');
  assert.equal(C.parsePhone(9876543210).value, '9876543210');
  assert.equal(C.parsePhone('9.87654321E9').value, '9876543210');
  assert.equal(C.parsePhone('9876543210.0').value, '9876543210');
  assert.equal(C.parsePhone('00971 50 123 4567').value, '+971501234567');
  assert.equal(C.parsePhone('(555) 123-4567').value, '5551234567');
  const two = C.parsePhone('98480 12345 / 040-2345678'); assert.equal(two.value, '9848012345'); assert.equal(two.extra, '040-2345678');
  assert.ok(C.parsePhone('12').error);
});
t('emails + dates + diet + bool', () => {
  assert.equal(C.parseEmail(' Ravi@Example.COM ').value, 'ravi@example.com');
  assert.ok(C.parseEmail('ravi at gmail').error);
  assert.equal(C.parseDate('05/01/2024').value, '2024-01-05');           // dd/mm (India/UAE)
  assert.equal(C.parseDate('05/01/2024', 'mdy').value, '2024-05-01');    // US
  assert.equal(C.parseDate('13/01/2024', 'mdy').value, '2024-01-13');    // unambiguous wins
  assert.equal(C.parseDate('2024-01-05').value, '2024-01-05');
  assert.equal(C.parseDate('5-Jan-2024').value, '2024-01-05');
  assert.equal(C.parseDate('Jan 5, 2024').value, '2024-01-05');
  assert.equal(C.parseDate('5th Jan 2024').value, '2024-01-05');
  assert.equal(C.parseDate(45296).value, '2024-01-05');                  // Excel serial
  assert.ok(C.parseDate('31/02/2024').error);
  for (const [v, d] of [['Veg', 'veg'], ['NON-VEG', 'nonveg'], ['NV', 'nonveg'], ['Jain', 'jain'], ['Eggetarian', 'egg'], ['Vegan', 'vegan'], ['V', 'veg'], ['Pure Veg', 'veg'], ['Chicken', 'nonveg']]) assert.equal(C.parseDiet(v).value, d, v);
  assert.equal(C.parseBool('Yes').value, true); assert.equal(C.parseBool('N').value, false); assert.equal(C.parseBool('✓').value, true);
});

/* ---------- staff ---------- */
t('staff: Indian HR export, reordered, extra columns kept as custom', () => {
  const r = map('staff', [
    ['Emp Code', 'Mobile No.', 'Employee Name', 'Desig.', 'Dept', 'DOJ', 'Salary (₹)', 'Aadhar No', 'Bank A/c No', 'IFSC Code', 'Blood Group', 'Shoe Size'],
    ['E001', '98765 43210', 'Ravi Kumar', 'Supervisor', 'Production', '12/03/2022', '25,000', '1234 5678 9012', '001234567890', 'HDFC0001234', 'O+', '9'],
    ['E002', '+91-91234-56789', 'Asha Rao', 'Helper', 'Decor', '01/11/2023', '12000', '', '', '', 'B+', '6'],
  ]);
  assert.equal(r.by['Mobile No.'], 'field:phone');
  assert.equal(r.by['Employee Name'], 'field:name');
  assert.equal(r.by['Desig.'], 'field:designation');
  assert.equal(r.by['Dept'], 'field:department');
  assert.equal(r.by['DOJ'], 'field:joining_date');
  assert.equal(r.by['Salary (₹)'], 'field:monthly_salary');
  assert.equal(r.by['Aadhar No'], 'field:id_number');
  assert.equal(r.by['Bank A/c No'], 'field:bank_account');
  assert.equal(r.by['IFSC Code'], 'field:ifsc');
  assert.equal(r.by['Blood Group'], 'field:blood_group');
  assert.equal(r.by['Shoe Size'], 'custom:shoe_size');
  assert.equal(map('staff', [['S.No', 'Name', 'Phone'], ['1', 'A', '9876543210']]).by['S.No'], 'ignore');
  assert.equal(r.by['Emp Code'], 'custom:emp_code');
  const row = r.built.rows[0];
  assert.deepEqual(row.errors, []);
  assert.equal(row.fields.phone, '9876543210');
  assert.equal(row.attributes.joining_date, '2022-03-12');
  assert.equal(row.attributes.monthly_salary, 25000);
  assert.equal(row.attributes.shoe_size, '9');
  assert.equal(row.attributes.ifsc, 'HDFC0001234');
  assert.equal(r.built.rows[1].fields.phone, '+919123456789');
});
t('staff: US style with first/last, cell, hourly, SSN; name composed', () => {
  const r = map('staff', [
    ['Last Name', 'First Name', 'Cell', 'E-mail Address', 'Hourly Rate', 'Hire Date', 'Position', 'ZIP'],
    ['Smith', 'John', '(555) 123-4567', 'john@x.com', '$25.50', '01/13/2024', 'Bartender', '10001'],
  ]);
  assert.equal(r.by['Cell'], 'field:phone'); assert.equal(r.by['E-mail Address'], 'field:email');
  assert.equal(r.by['Hourly Rate'], 'field:hourly_rate'); assert.equal(r.by['Hire Date'], 'field:joining_date');
  assert.equal(r.by['Position'], 'field:role'); assert.equal(r.by['ZIP'], 'custom:zip');
  const row = r.built.rows[0];
  assert.equal(row.fields.name, 'John Smith'); assert.equal(row.attributes.hourly_rate, 25.5);
  assert.equal(row.attributes.joining_date, '2024-01-13'); assert.equal(row.fields.email, 'john@x.com');
});
t('staff: UAE style (Emirates ID, WhatsApp, AED daily rate, nationality)', () => {
  const r = map('staff', [
    ['S.No', 'Name', 'Nationality', 'WhatsApp', 'Emirates ID', 'Daily Rate (AED)', 'Languages Known', 'Skills', 'Visa Expiry'],
    ['1', 'Mohammed Ali', 'Indian', '+971 50 123 4567', '784-1990-1234567-1', 'AED 250', 'Arabic, English, Hindi', 'Sound; Lights', '2026-08-31'],
  ]);
  assert.equal(r.by['WhatsApp'], 'field:phone'); assert.equal(r.by['Emirates ID'], 'field:id_number');
  assert.equal(r.by['Daily Rate (AED)'], 'field:day_rate'); assert.equal(r.by['Languages Known'], 'field:languages');
  assert.equal(r.by['Skills'], 'field:skills'); assert.equal(r.by['Nationality'], 'custom:nationality');
  const row = r.built.rows[0];
  assert.equal(row.fields.day_rate, 250); assert.deepEqual(row.fields.skills, ['Sound', 'Lights']);
  assert.equal(row.attributes.languages, 'Arabic, English, Hindi'); assert.equal(row.fields.phone, '+971501234567');
});
t('staff: title rows + merged 2-level header + blank rows + repeated header', () => {
  const r = map('staff', [
    ['ABC Events Pvt Ltd — Staff list 2024'],
    [],
    ['Personal', '', '', 'Bank details', ''],
    ['Name', 'Phone', 'Email', 'Account No', 'IFSC'],
    ['Ravi', '9876543210', 'r@x.in', '1234567890', 'SBIN0000001'],
    ['', '', '', '', ''],
    ['Name', 'Phone', 'Email', 'Account No', 'IFSC'],
    ['Sita', '9876500000', '', '', ''],
  ]);
  assert.equal(r.h.index, 3);
  assert.equal(r.by['Phone'], 'field:phone'); assert.equal(r.by['Account No'], 'field:bank_account');
  assert.equal(r.built.rows.length, 2); assert.equal(r.built.skippedBlank, 2);
  assert.equal(r.built.rows[1].line, 8);
});
t('staff: missing phone column → each row flagged, no crash', () => {
  const r = map('staff', [['Name', 'Role'], ['A', 'Helper']]);
  assert.ok(r.built.rows[0].errors.some((e) => /Phone is missing/.test(e)));
});
t('staff: messy values → row errors, raw kept', () => {
  const r = map('staff', [['Name', 'Phone', 'Email', 'Day Rate'], ['A', '12', 'bad@', 'lots'], ['B', '9876543210', 'b@x.com', '1,500']]);
  assert.equal(r.built.rows[0].errors.length, 3);
  assert.equal(r.built.rows[0].attributes.raw_day_rate, 'lots');
  assert.deepEqual(r.built.rows[1].errors, []);
  assert.equal(r.built.rows[1].fields.day_rate, 1500);
});
t('staff: headerless phone column detected by values', () => {
  const r = map('staff', [['Name', 'Col2'], ['A', '9876543210'], ['B', '9876543211'], ['C', '+91 98765 43212']]);
  assert.equal(r.by['Col2'], 'field:phone');
});
t('staff: emp type words', () => {
  assert.equal(C.parseEmp('Permanent').value, 'full_time'); assert.equal(C.parseEmp('Part Time').value, 'part_time');
  assert.equal(C.parseEmp('Daily wage').value, 'on_call'); assert.equal(C.parseEmp('Contract').value, 'on_call');
});

/* ---------- inventory ---------- */
t('inventory: godown sheet with Qty / UOM / Rate / Rent / Location', () => {
  const r = map('inventory', [
    ['Sr No', 'Item Description', 'Category', 'Qty', 'UOM', 'Purchase Rate', 'Rental Price', 'Godown', 'Condition', 'Colour', 'Size'],
    ['1', 'Chiavari Chair', 'Seating', '200', 'Nos', '₹1,500', '₹150', 'Hyd-2', 'Good', 'Gold', '40x40x90 cm'],
    ['2', 'Round Table 5ft', 'Tables', '30', 'pcs', '4,000', '400', 'Hyd-1', 'Fair', '', ''],
  ]);
  assert.equal(r.by['Item Description'], 'field:name'); assert.equal(r.by['Qty'], 'field:total_qty');
  assert.equal(r.by['UOM'], 'field:unit'); assert.equal(r.by['Purchase Rate'], 'field:unit_cost');
  assert.equal(r.by['Rental Price'], 'field:rental_price'); assert.equal(r.by['Godown'], 'field:location');
  assert.equal(r.by['Condition'], 'field:condition'); assert.equal(r.by['Colour'], 'field:colour'); assert.equal(r.by['Size'], 'field:dimensions');
  const row = r.built.rows[0];
  assert.equal(row.fields.total_qty, 200); assert.equal(row.fields.unit_cost, 1500); assert.equal(row.attributes.rental_price, 150);
  assert.equal(row.attributes.location, 'Hyd-2');
});
t('inventory: US style Product / SKU / Stock / Cost / Supplier / Replacement Value', () => {
  const r = map('inventory', [['SKU', 'Product', 'Stock', 'Cost', 'Supplier', 'Replacement Value', 'Material', 'Warehouse Bin'],
    ['CH-01', 'Ghost chair', '120', '$45.00', 'Acme', '$60', 'Acrylic', 'A-3']]);
  assert.equal(r.by['SKU'], 'field:sku'); assert.equal(r.by['Product'], 'field:name'); assert.equal(r.by['Stock'], 'field:total_qty');
  assert.equal(r.by['Cost'], 'field:unit_cost'); assert.equal(r.by['Supplier'], 'field:vendor');
  assert.equal(r.by['Replacement Value'], 'field:replacement_cost'); assert.equal(r.by['Material'], 'field:material');
  assert.equal(r.by['Warehouse Bin'], 'field:location');
});
t('inventory: negative / text qty flagged', () => {
  const r = map('inventory', [['Item', 'Qty'], ['A', '-3'], ['B', 'some'], ['C', '']]);
  assert.ok(r.built.rows[0].errors.length && r.built.rows[1].errors.length); assert.deepEqual(r.built.rows[2].errors, []);
});

/* ---------- menu ---------- */
t('menu: caterer menu with Veg/Non-veg, course, per plate, allergens, live', () => {
  const r = map('menu', [
    ['Course', 'Dish Name', 'Veg/Non-veg', 'Cuisine', 'Rate Per Plate', 'Allergens', 'Spice Level', 'Live Counter', 'Chef Notes'],
    ['Starters', 'Paneer Tikka', 'Veg', 'North Indian', '₹120', 'Dairy', 'Medium', 'Yes', 'tandoor'],
    ['Main Course', 'Chicken Biryani', 'Non-Veg', 'Hyderabadi', '₹250', '', 'Hot', 'No', ''],
    ['Main Course', 'Egg Curry', 'Egg', 'Andhra', '150', '', '', '', ''],
    ['Dessert', 'Gulab Jamun', 'Jain', '', '60', 'Dairy, Gluten', 'Mild', '', ''],
  ]);
  assert.equal(r.by['Course'], 'field:category'); assert.equal(r.by['Dish Name'], 'field:name');
  assert.equal(r.by['Veg/Non-veg'], 'field:diet'); assert.equal(r.by['Rate Per Plate'], 'field:price_per_plate');
  assert.equal(r.by['Live Counter'], 'field:live_counter'); assert.equal(r.by['Chef Notes'], 'field:description');
  const [a, b, c, d] = r.built.rows;
  assert.equal(a.fields.kind, 'veg'); assert.equal(b.fields.kind, 'nonveg'); assert.equal(c.fields.kind, 'nonveg'); assert.equal(c.attributes.diet, 'egg');
  assert.equal(d.attributes.diet, 'jain'); assert.equal(d.fields.kind, 'veg'); assert.equal(a.attributes.live_counter, true);
  assert.equal(a.attributes.price_per_plate, 120); assert.equal(d.attributes.allergens, 'Dairy, Gluten');
});
t('menu: "Item" + "Type" with V/NV values → diet by sniffing', () => {
  const r = map('menu', [['Item', 'V/NV', 'Price'], ['Dal', 'V', '80'], ['Fish fry', 'NV', '200'], ['Salad', 'V', '50']]);
  assert.equal(r.by['Item'], 'field:name'); assert.equal(r.by['V/NV'], 'field:diet'); assert.equal(r.by['Price'], 'field:price_per_plate');
});

/* ---------- vendors ---------- */
t('vendors: GSTIN, contact person, city', () => {
  const r = map('vendors', [['Firm Name', 'Contact Person', 'Mobile', 'Service', 'GST No', 'City'], ['Shree Tents', 'Raju', '9876543210', 'Tents', '36ABCDE1234F1Z5', 'Hyderabad']]);
  assert.equal(r.by['Firm Name'], 'field:name'); assert.equal(r.by['Contact Person'], 'field:contact_person');
  assert.equal(r.by['GST No'], 'field:gstin'); assert.equal(r.by['Service'], 'field:category');
});

/* ---------- order independence ---------- */
t('order independent: shuffled columns map identically', () => {
  const H = ['Name', 'Phone', 'Email', 'Department', 'Skills', 'Day Rate', 'Joining Date', 'Remarks'];
  const R = ['Ravi', '9876543210', 'r@x.in', 'Ops', 'sound', '1000', '01/02/2024', 'ok'];
  const base = map('staff', [H, R]);
  for (let s = 0; s < 10; s++) {
    const idx = H.map((_, i) => i).sort(() => Math.sin(s * 99 + H.length) - 0.5 + (Math.random() - 0.5));
    const r = map('staff', [idx.map((i) => H[i]), idx.map((i) => R[i])]);
    H.forEach((h) => assert.equal(r.by[h], base.by[h], h));
    assert.deepEqual(r.built.rows[0].fields, base.built.rows[0].fields);
  }
});

/* ---------- saved mapping ---------- */
t('saved mapping overrides auto-map next time', () => {
  const headers = ['Name', 'Phone', 'Code'];
  const m = C.autoMap('staff', headers, [['A', '9876543210', 'X']]);
  m[2] = { target: 'ignore' };
  const saved = C.mappingToSaved(headers, m);
  const m2 = C.autoMap('staff', ['Code', 'Phone', 'Name'], [['X', '9876543210', 'A']], saved);
  assert.equal(m2[0].target, 'ignore'); assert.equal(m2[0].why, 'saved'); assert.equal(m2[2].target, 'field:name');
});

/* ---------- duplicates ---------- */
t('duplicates: against existing + inside file, default skip; name-unique tables cannot create dup', () => {
  const r = map('staff', [['Name', 'Phone'], ['Ravi', '+91 98765 43210'], ['New Person', '9000000001'], ['New Person 2', '9000000001']]);
  C.markDuplicates('staff', r.built.rows, [{ id: 'x1', name: 'Ravi Kumar', phone: '9876543210' }]);
  const [a, b, c] = r.built.rows;
  assert.equal(a.status, 'duplicate'); assert.equal(a.action, 'skip'); assert.equal(a.match.id, 'x1');
  assert.equal(b.status, 'new'); assert.equal(b.action, 'create');
  assert.equal(c.status, 'dup-in-file'); assert.equal(c.action, 'skip');
  assert.equal(C.setAction('staff', a, 'update'), 'update');
  const inv = map('inventory', [['Item', 'Qty'], ['Chair', '5']]).built.rows;
  C.markDuplicates('inventory', inv, [{ id: 'i1', name: 'chair ' }]);
  assert.equal(C.setAction('inventory', inv[0], 'create'), 'skip');   // refused, stays skip
  const p = C.payloads('staff', r.built.rows, []);
  assert.equal(p.batches[0].length, 2); assert.equal(p.batches[0].find((x) => x.action === 'update').id, 'x1');
});
t('error rows are never sent', () => {
  const r = map('staff', [['Name', 'Phone'], ['', '9876543210'], ['B', '9876543211']]);
  C.markDuplicates('staff', r.built.rows, []);
  assert.equal(C.payloads('staff', r.built.rows, []).batches[0].length, 1);
});

/* ---------- formula injection + results CSV ---------- */
t('formula injection neutralised; results CSV', () => {
  const r = map('staff', [['Name', 'Phone', 'Notes'], ['=HYPERLINK("x")', '9876543210', '@SUM(A1)']]);
  assert.match(r.built.rows[0].fields.name, /^'/); assert.match(r.built.rows[0].fields.notes, /^'/);
  C.markDuplicates('staff', r.built.rows, []);
  const csv = C.resultsCSV(['Name', 'Phone', 'Notes'], r.built.rows, [{ i: 2, status: 'error', error: 'boom' }]);
  assert.match(csv, /^Row,Result,Message,Name,Phone,Notes\r\n2,error,boom,"'=HYPERLINK/);
});

/* ---------- 5k rows ---------- */
t('5,000 rows map + build + dedupe quickly; 5,001st truncated', () => {
  const rows = [['Employee Name', 'Mobile', 'Dept', 'Daily Wage', 'Bank IFSC']];
  for (let i = 0; i < 5001; i++) rows.push(['Person ' + i, String(9000000000 + i), 'Ops', String(500 + i % 100), 'HDFC000' + (i % 1000)]);
  const t0 = Date.now();
  const r = map('staff', rows);
  C.markDuplicates('staff', r.built.rows, []);
  const p = C.payloads('staff', r.built.rows, r.m);
  assert.equal(r.built.rows.length, 5000); assert.ok(r.built.truncated);
  assert.equal(p.batches.length, 25); assert.ok(p.batches.every((b) => b.length <= 200));
  assert.ok(Date.now() - t0 < 4000, 'took ' + (Date.now() - t0) + 'ms');
});

/* ---------- display helper ---------- */
t('attrList labels from defs, hides inactive, built-in labels fallback', () => {
  const l = C.attrList('staff', { ifsc: 'X', shoe_size: '9', secret: 'h', empty: '' }, [{ key: 'shoe_size', label: 'Shoe' }, { key: 'secret', label: 'S', active: false }]);
  assert.deepEqual(l.map((x) => x.label + '=' + x.value), ['Shoe=9', 'IFSC / routing code=X']);
});

/* ---------- wiring guards ---------- */
t('UI + store + pages wired', () => {
  const ui = readFileSync(new URL('../public/smart-import.js', import.meta.url), 'utf8');
  assert.match(ui, /root\.HelmImport\s*=\s*\{[^}]*open/);
  assert.doesNotMatch(ui, /innerHTML|insertAdjacentHTML|document\.write/);
  const st = readFileSync(new URL('../public/store-api.js', import.meta.url), 'utf8');
  assert.match(st, /smart_import_batch/); assert.match(st, /custom_field_defs/); assert.match(st, /import_mappings/);
  for (const p of ['staff', 'inventory', 'control']) {
    const h = readFileSync(new URL('../public/' + p + '.html', import.meta.url), 'utf8');
    assert.match(h, /smart-import-core\.js\?v=6"/, p); assert.match(h, /smart-import\.js\?v=6"/, p);
    assert.match(h, /xlsx-lite\.js\?v=2"/, p); assert.match(h, /store-api\.js\?v=305"/, p);
    assert.match(h, /HelmImport\.open\(\{\s*entity:/, p);
  }
  const sql = readFileSync(new URL('../supabase/migrations/0088_smart_import.sql', import.meta.url), 'utf8');
  assert.match(sql, /add column if not exists attributes jsonb not null default '\{\}'::jsonb/);
  assert.match(sql, /security definer set search_path = ''/);
  assert.match(sql, /has_area\(v_area, 'edit'\)/);
  assert.doesNotMatch(sql, /\bdrop table\b|\bdelete from\b|\btruncate\b/i);
  assert.match(readFileSync(new URL('../supabase/migrations/MANIFEST', import.meta.url), 'utf8'), /0088_smart_import\.sql/);
});

if (bad) { console.error(`smart-import: ${bad} FAILED`); process.exit(1); }
console.log(`smart-import: ${n} passed`);
