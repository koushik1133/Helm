/* =========================================================================
   HELM \u2014 smart import engine: PURE logic (no DOM, no network).
   Takes any studio spreadsheet (columns in any order, different names, missing
   or extra columns, merged title rows) and maps it onto our fields:
     * header-row detection (skips title / merged group rows, joins 2-level headers)
     * auto-mapping: normalised name + synonym dictionary + fuzzy score + value sniffing
     * typed value parsing (phones, emails, ₹/$/AED amounts, Excel/Indian/US dates, diet…)
     * anything we have no column for is kept as a custom attribute (nothing is lost)
     * duplicate detection against existing rows and inside the file
   Unit-tested in test/smart-import.test.mjs. Browser: window.HelmImportCore.
   ========================================================================= */
(function (root) {
  "use strict";

  const MAX_ROWS = 5000, MAX_COLS = 80, MAX_TEXT = 1000, MAX_ATTRS = 64, BATCH = 200;

  /* ---------------- text helpers ---------------- */
  function clean(v) {
    if (v == null) return "";
    let s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/[\u00A0\u2007\u202F]/g, " ").replace(/\s+/g, " ").trim();
    if (s.length > MAX_TEXT) s = s.slice(0, MAX_TEXT).trim();
    return s;
  }
  // formula-injection guard for text that may be exported again
  function safeText(v) {
    const s = clean(v).replace(/<[^>]*>/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
    return /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d/.test(s) ? "'" + s : s;
  }
  // India: Hindi (Devanagari) / Hinglish sheet headers -> English words the matcher knows.
  const HI_HDR = [[/नाम/g, " name "], [/मोबाइल|मोबाईल/g, " mobile "], [/फ़ोन|फोन/g, " phone "], [/दर|रेट/g, " rate "],
    [/शहर/g, " city "], [/पता/g, " address "], [/ईमेल/g, " email "], [/वेतन|तनख्वाह/g, " salary "], [/पद|भूमिका/g, " role "],
    [/मात्रा/g, " quantity "], [/कीमत|मूल्य/g, " price "], [/प्रति\s*दिन/g, " per day "], [/किराया/g, " rental "],
    [/\bshahar\b/gi, " city "], [/\bpata\b/gi, " address "], [/\bvetan\b/gi, " salary "], [/\bkiraya\b/gi, " rental "]];
  function normHeader(v) {
    let t = clean(v); HI_HDR.forEach((r) => { t = t.replace(r[0], r[1]); });
    return t.normalize("NFKD").replace(/[\u0300-\u036F]/g, "").toLowerCase()
      .replace(/&/g, " and ").replace(/#/g, " no ").replace(/[\u20B9$\u20AC\u00A3%]/g, " ")
      .replace(/\([^)]*\)/g, (m) => " " + m.slice(1, -1) + " ")
      .replace(/[^a-z0-9]+/g, " ").trim();
  }
  const compact = (s) => s.replace(/ /g, "");
  function slugKey(label, taken) {
    let k = normHeader(label).replace(/ /g, "_").slice(0, 40).replace(/_+$/, "") || "field";
    if (/^\d/.test(k)) k = "f_" + k;
    let out = k, n = 2;
    while (taken && taken.has(out)) out = (k + "_" + n++).slice(0, 48);
    if (taken) taken.add(out);
    return out;
  }
  function lev(a, b) {
    if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);

  /* ---------------- value parsers ---------------- */
  // "₹1,50,000.50", "$1,200", "AED 500", "Rs. 450/-", "1.5k", "2 lakh", "(300)" → number | null | NaN(invalid)
  function parseAmount(raw) {
    if (raw == null) return null;
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : NaN;
    let s = clean(raw).toLowerCase();
    if (!s || s === "-" || s === "\u2014" || s === "na" || s === "n/a" || s === "nil") return null;
    let mult = 1;
    const unit = s.match(/(\d)\s*(k|thousand|lakh|lakhs|lac|lacs|l|cr|crore|crores|m|mn|million)\s*$/);
    if (unit) {
      const u = unit[2]; unit.index += 1;
      mult = u === "k" || u === "thousand" ? 1e3 : /^(lakh|lakhs|lac|lacs|l)$/.test(u) ? 1e5 : /^(cr|crore|crores)$/.test(u) ? 1e7 : 1e6;
      s = s.slice(0, unit.index).trim();
    }
    const neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/^[^\d-]+/, ""));
    s = s.replace(/^(rs\.?|inr|aed|usd|dhs?|sar|qar|us\$)/, "").replace(/(\/-|\/=|only|per\s+\w+|\/\w+)$/g, "")
      .replace(/[\u20B9$\u20AC\u00A3()\s]/g, "").replace(/(rs\.?|inr|aed|usd|dhs?)$/, "");
    if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");   // 1.234,50 (EU)
    s = s.replace(/,/g, "").replace(/^-/, "");
    if (!/^\d*\.?\d+$/.test(s)) return NaN;
    const n = Number(s) * mult;
    return Number.isFinite(n) ? (neg ? -n : n) : NaN;
  }
  // phone: keep a single leading + and digits; Excel numbers (9876543210, 9.87654321E9, "9876543210.0")
  function parsePhone(raw) {
    if (raw == null) return { value: null };
    let s = typeof raw === "number" ? (Number.isInteger(raw) ? String(raw) : raw.toFixed(0)) : clean(raw);
    if (!s) return { value: null };
    if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, "");
    if (/^\d(\.\d+)?e\+?\d+$/i.test(s)) s = Number(s).toFixed(0);
    const first = s.split(/\s*(?:[,;\/|]|\bor\b)\s*/i).filter(Boolean)[0] || s;   // "98480 12345 / 040-2345678"
    let p = first.replace(/(ext|x)\.?\s*\d+$/i, "");
    const plus = /^\s*(\+|00)/.test(p);
    let d = p.replace(/\D/g, "");
    if (/^00/.test(p.trim())) d = d.replace(/^00/, "");
    if (!plus && d.length === 11 && d[0] === "0") d = d.slice(1);                     // 09848012345 (IN trunk 0)
    if (d.length < 7 || d.length > 15) return { value: null, error: "Phone needs 7\u201315 digits" };
    if (plus && /^9710/.test(d)) d = "971" + d.slice(4);                                 // +971 050… (trunk 0)
    if (plus && /^971/.test(d) && !/^971(5\d{8}|[234679]\d{7})$/.test(d)) return { value: null, error: "UAE mobile numbers have 9 digits after +971" };
    if (plus && /^91/.test(d) && d.length !== 12) return { value: null, error: "Indian numbers have 10 digits after +91" };
    const extra = s !== first ? s.slice(first.length).replace(/^\s*(?:[,;\/|]|\bor\b)\s*/i, "") : "";
    return { value: (plus ? "+" : "") + d, extra: extra || null };
  }
  function parseEmail(raw) {
    const s = clean(raw).replace(/^mailto:/i, "").split(/[\s,;]+/)[0] || "";
    if (!s) return { value: null };
    if (s.length > 254 || !/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(s)) return { value: null, error: "Not a valid email" };
    return { value: s.toLowerCase() };
  }
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const pad = (n) => String(n).padStart(2, "0");
  function ymd(y, m, d) {
    if (y < 100) y += y < 50 ? 2000 : 1900;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 1900 || y > 2100) return null;
    return y + "-" + pad(m) + "-" + pad(d);
  }
  // order: "dmy" (India/UAE/UK default) or "mdy" (US). Excel serial dates accepted.
  function parseDate(raw, order) {
    if (raw == null || raw === "") return { value: null };
    if (typeof raw === "number" || /^\d{5}(\.\d+)?$/.test(clean(raw))) {
      const n = Number(raw);
      if (n > 1 && n < 80000) { const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000); return { value: dt.toISOString().slice(0, 10) }; }
    }
    const s = clean(raw).toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/,/g, " ").replace(/\s+/g, " ").trim();
    let m;
    if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[ t].*)?$/))) { const v = ymd(+m[1], +m[2], +m[3]); return v ? { value: v } : { value: null, error: "Not a valid date" }; }
    if ((m = s.match(/^(\d{1,2})[-\/. ](\d{1,2})[-\/. ](\d{2,4})(?: .*)?$/))) {
      let a = +m[1], b = +m[2]; const y = +m[3];
      let d = a, mo = b;
      if (order === "mdy" ? b <= 31 && a <= 12 : false) { d = b; mo = a; }
      if (a > 12 && b <= 12) { d = a; mo = b; } else if (b > 12 && a <= 12) { d = b; mo = a; }
      const v = ymd(y, mo, d); return v ? { value: v } : { value: null, error: "Not a valid date" };
    }
    if ((m = s.match(/^(\d{1,2})[-\/ ]([a-z]{3,9})[-\/ ](\d{2,4})$/)) && MONTHS[m[2].slice(0, 3)]) {
      const v = ymd(+m[3], MONTHS[m[2].slice(0, m[2] === "sept" ? 4 : 3)] || MONTHS[m[2].slice(0, 3)], +m[1]); return v ? { value: v } : { value: null, error: "Not a valid date" };
    }
    if ((m = s.match(/^([a-z]{3,9})[-\/ ](\d{1,2})[-\/ ](\d{2,4})$/)) && MONTHS[m[1].slice(0, 3)]) {
      const v = ymd(+m[3], MONTHS[m[1].slice(0, 3)], +m[2]); return v ? { value: v } : { value: null, error: "Not a valid date" };
    }
    return { value: null, error: "Not a valid date" };
  }
  function parseBool(raw) {
    if (raw === true || /[\u2713\u2714]/.test(String(raw))) return { value: true };
    const s = normHeader(raw);
    if (!s) return { value: null };
    if (/^(y|yes|true|1|available|ok|done|active|x|v)$/.test(s) || raw === true || /[\u2713\u2714]/.test(String(raw))) return { value: true };
    if (/^(n|no|false|0|na|not available|inactive|none)$/.test(s) || raw === false) return { value: false };
    return { value: null, error: "Expected yes or no" };
  }
  function parseDiet(raw) {
    const s = normHeader(raw);
    if (!s) return { value: null };
    if (/\bjain\b/.test(s)) return { value: "jain" };
    if (/\bvegan\b|plant based/.test(s)) return { value: "vegan" };
    if (/\begg(etarian|less)?\b/.test(s) && !/eggless/.test(s)) return { value: "egg" };
    if (/non ?veg|^nv$|^n$|non vegetarian|chicken|mutton|fish|prawn|meat|lamb|beef|pork|seafood|red/.test(s)) return { value: "nonveg" };
    if (/^v$|^veg$|vegetarian|pure veg|^y$|green|^veg\b|eggless|paneer/.test(s)) return { value: "veg" };
    return { value: null, error: "Diet should be veg, non-veg, egg, jain or vegan" };
  }
  function parseEmp(raw) {
    const s = normHeader(raw);
    if (!s) return { value: null };
    if (/part/.test(s)) return { value: "part_time" };
    if (/full|permanent|^ft$|regular|salaried|staff|employee/.test(s)) return { value: "full_time" };
    if (/call|contract|freelanc|casual|daily|temp|adhoc|ad hoc|gig|seasonal|per event/.test(s)) return { value: "on_call" };
    return { value: null, warn: "Unknown employment type kept as a note" };
  }
  function parseList(raw) {
    const s = clean(raw);
    if (!s) return { value: null };
    return { value: [...new Set(s.split(/\s*[,;|\/\n\u2022]\s*|\s+and\s+/i).map((x) => safeText(x)).filter(Boolean))].slice(0, 40) };
  }
  function parseSpice(raw) {
    const s = normHeader(raw);
    if (!s) return { value: null };
    const n = Number(s); if (Number.isFinite(n)) return { value: String(Math.max(0, Math.min(5, Math.round(n)))) };
    if (/extra|very|hot|high|3/.test(s)) return { value: "hot" };
    if (/med/.test(s)) return { value: "medium" };
    if (/mild|low|less|no|none/.test(s)) return { value: "mild" };
    return { value: safeText(raw) };
  }

  /* ---------------- CSV / text files ---------------- */
  function decode(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let text = new TextDecoder("utf-8").decode(u8);
    if (text.indexOf("\uFFFD") >= 0) { try { text = new TextDecoder("windows-1252").decode(u8); } catch (e) { /* keep utf-8 */ } }
    if (u8[0] === 0xFF && u8[1] === 0xFE) text = new TextDecoder("utf-16le").decode(u8);
    return text.replace(/^\uFEFF/, "");
  }
  function parseCSV(text) {
    const s = String(text == null ? "" : text).replace(/^\uFEFF/, "");
    const sample = s.slice(0, 5000).split(/\r?\n/).slice(0, 10);
    const cnt = (ch) => sample.reduce((a, l) => a + (l.split(ch).length - 1), 0);
    const d = [",", ";", "\t", "|"].map((c) => [c, cnt(c)]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = []; let row = [], f = "", q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"' && f.trim() === "") { q = true; f = ""; }
      else if (c === d) { row.push(f); f = ""; }
      else if (c === "\r" || c === "\n") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; if (rows.length > MAX_ROWS + 40) break; }
      else f += c;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows.map((r) => r.slice(0, MAX_COLS));
  }

  /* ---------------- attribute sets per entity ----------------
     std: true \u2192 a real table column (sent in "fields"); otherwise kept in attributes.
     type: text | phone | email | money | number | int | date | bool | diet | emp | list | spice */
  const F = (key, label, type, syn, extra) => Object.assign({ key, label, type, syn: syn || [] }, extra || {});
  const ENTITIES = {
    staff: {
      label: "Staff", noun: "person", area: "staff", dedupe: "staff",
      fields: [
        F("name", "Full name", "text", ["name", "full name", "staff name", "employee name", "emp name", "member name", "person", "worker name", "crew name", "naam", "candidate name", "employee"], { std: true, required: true }),
        F("first_name", "First name", "text", ["first name", "firstname", "given name", "fname", "first"]),
        F("last_name", "Last name", "text", ["last name", "lastname", "surname", "family name", "lname", "last"]),
        F("phone", "Phone", "phone", ["phone", "mobile", "mobile no", "mobile number", "contact", "contact no", "contact number", "ph", "ph no", "phone no", "phone number", "cell", "cell no", "whatsapp", "whatsapp no", "tel", "telephone", "mob", "mob no", "primary phone", "primary contact"], { std: true, required: true }),
        F("alt_phone", "Alternate phone", "phone", ["alternate phone", "alt phone", "alternate mobile", "alternate number", "secondary phone", "other phone", "landline", "phone 2", "mobile 2", "alt contact", "home phone", "alt mobile"]),
        F("email", "Email", "email", ["email", "e mail", "email id", "mail", "mail id", "email address", "e mail id", "gmail"], { std: true }),
        F("role", "Role / title", "text", ["role", "title", "job title", "position", "job role", "post", "work", "function"], { std: true }),
        F("designation", "Designation", "text", ["designation", "desig", "grade", "level", "rank"]),
        F("department", "Department", "text", ["department", "dept", "team", "division", "section", "unit", "vertical", "group"], { std: true }),
        F("skills", "Skills", "list", ["skills", "skill", "skill set", "skillset", "expertise", "speciality", "specialty", "specialization", "trade", "competencies", "can do"], { std: true }),
        F("languages", "Languages", "list", ["languages", "language", "languages known", "lang", "speaks"]),
        F("day_rate", "Daily rate", "money", ["day rate", "daily rate", "rate per day", "per day", "daily wage", "wage", "daily", "rate", "per day rate", "day charge", "per shift", "shift rate", "charges", "fee"], { std: true }),
        F("hourly_rate", "Hourly rate", "money", ["hourly rate", "per hour", "rate per hour", "hourly", "hour rate", "hrly rate"]),
        F("monthly_salary", "Monthly salary", "money", ["monthly salary", "salary", "monthly pay", "ctc", "pay", "gross salary", "net salary", "salary per month", "monthly", "basic salary"]),
        F("emp_type", "Employment type", "emp", ["employment type", "emp type", "type of employment", "employment", "contract type", "engagement", "worker type", "staff type", "full time part time", "ft pt", "nature of employment"], { std: true }),
        F("joining_date", "Joining date", "date", ["joining date", "date of joining", "doj", "join date", "start date", "joined on", "hire date", "date joined", "joined"]),
        F("dob", "Date of birth", "date", ["date of birth", "dob", "birth date", "birthday", "d o b", "born on"]),
        F("gender", "Gender", "text", ["gender", "sex", "m f"]),
        F("address", "Address", "text", ["address", "residential address", "home address", "permanent address", "current address", "addr", "location address", "street"]),
        F("city", "City", "text", ["city", "town", "location", "base location", "place", "district", "emirate", "state city"]),
        F("id_type", "ID proof type", "text", ["id proof type", "id type", "id proof", "document type", "kyc type", "proof type"]),
        F("id_number", "ID number", "text", ["id number", "id no", "aadhaar", "aadhar", "aadhaar no", "aadhar no", "aadhaar number", "aadhar number", "pan", "pan no", "pan number", "passport", "passport no", "emirates id", "eid", "ssn", "national id", "kyc number", "voter id", "driving licence", "license no"]),
        F("bank_account", "Bank account no.", "text", ["bank account", "account number", "account no", "bank ac no", "a c no", "ac no", "bank a c", "acc no", "iban", "bank account number"]),
        F("ifsc", "IFSC / routing code", "text", ["ifsc", "ifsc code", "routing number", "swift", "swift code", "sort code", "branch code", "bank code"]),
        F("bank_name", "Bank name", "text", ["bank name", "bank", "bank branch"]),
        F("upi", "UPI ID", "text", ["upi", "upi id", "gpay", "phonepe", "paytm"]),
        F("emergency_name", "Emergency contact name", "text", ["emergency contact name", "emergency contact", "emergency person", "next of kin", "guardian", "relative name", "kin"]),
        F("emergency_phone", "Emergency contact phone", "phone", ["emergency contact number", "emergency phone", "emergency no", "emergency mobile", "guardian phone", "ice"]),
        F("vehicle", "Vehicle", "text", ["vehicle", "vehicle no", "bike", "two wheeler", "vehicle number", "own vehicle", "transport", "conveyance"]),
        F("blood_group", "Blood group", "text", ["blood group", "blood type", "bg"]),
        F("shirt_size", "Uniform size", "text", ["uniform size", "shirt size", "t shirt size", "tshirt size", "dress size"]),
        F("experience", "Experience (years)", "number", ["experience", "exp", "years of experience", "yrs exp", "experience years", "total experience", "yoe"]),
        F("status", "Status", "text", ["status", "active", "employment status", "current status", "working status"]),
        F("notes", "Notes", "text", ["notes", "note", "remarks", "remark", "comments", "comment", "description", "details", "other info", "additional info", "observations"], { std: true }),
      ],
    },
    inventory: {
      label: "Inventory", noun: "item", area: "inventory", dedupe: "name",
      fields: [
        F("name", "Item name", "text", ["name", "item", "item name", "product", "product name", "article", "description", "particulars", "material", "asset", "asset name", "equipment", "goods", "item description", "prop", "props", "decor item", "stock item"], { std: true, required: true }),
        F("sku", "SKU / code", "text", ["sku", "code", "item code", "product code", "asset code", "asset id", "item id", "barcode", "part no", "part number", "ref", "reference", "tag", "serial no", "model no", "hsn"]),
        F("category", "Category", "text", ["category", "cat", "type", "item type", "group", "class", "product category", "family", "section"], { std: true }),
        F("sub_category", "Sub-category", "text", ["sub category", "subcategory", "sub cat", "sub type", "subtype", "sub group"]),
        F("total_qty", "Quantity", "number", ["quantity", "qty", "stock", "count", "no of units", "units", "total", "total qty", "in stock", "available", "available qty", "nos", "no s", "pieces", "pcs", "stock qty", "on hand", "balance", "closing stock", "numbers"], { std: true }),
        F("unit", "Unit", "text", ["unit", "uom", "unit of measure", "units of measure", "measure", "per"], { std: true }),
        F("condition", "Condition", "text", ["condition", "state", "quality", "grade", "health"]),
        F("location", "Location / warehouse", "text", ["location", "warehouse", "godown", "store", "storage", "storage location", "rack", "shelf", "bin", "site", "kept at", "where"]),
        F("unit_cost", "Purchase price (per unit)", "money", ["purchase price", "cost", "unit cost", "cost price", "buying price", "purchase cost", "cp", "rate", "price", "unit price", "value", "mrp", "cost per unit", "landing cost", "buying cost", "purchase rate", "purchase value", "purchase", "buying"], { std: true,
          anti: /\b(day|days|daily|hire|hiring|rent|rental|rentals|event|events|night|shift|per use|lease)\b/ }),   // C1: "Rate/day" is a rental rate, never a purchase price
        F("rental_price", "Rental price", "money", ["rental price", "rent", "rental", "hire price", "rental rate", "rent per day", "hire charge", "rental charges", "selling price", "sp", "charge", "rate per day", "rate day", "day rate", "per day", "per day rate", "daily rate", "hire", "hire rate", "hire per day", "rate per event", "per event", "event rate", "rent rate", "rental per day"],
          { cue: /\b(day|daily|hire|rent|rental|event|night|lease)\b/, anti: /\b(purchase|purchased|buying|bought|mrp|landing|cost price)\b/ }),
        F("replacement_cost", "Replacement cost", "money", ["replacement cost", "replacement value", "damage charge", "loss charge", "replacement", "damage cost"]),
        F("vendor", "Vendor / supplier", "text", ["vendor", "supplier", "bought from", "purchased from", "source", "manufacturer", "brand", "make"]),
        F("purchase_date", "Purchase date", "date", ["purchase date", "bought on", "date of purchase", "acquired on", "invoice date"]),
        F("dimensions", "Dimensions", "text", ["dimensions", "size", "dimension", "l x w x h", "lxwxh", "measurements", "length x width", "dims"]),
        F("weight", "Weight", "text", ["weight", "wt", "kg", "weight kg"]),
        F("colour", "Colour", "text", ["colour", "color", "shade", "finish"]),
        F("material", "Material", "text", ["material", "made of", "fabric", "build material", "composition"]),
        F("min_stock", "Reorder level", "number", ["reorder level", "min stock", "minimum stock", "reorder qty", "safety stock", "par level"]),
        F("notes", "Notes", "text", ["notes", "note", "remarks", "remark", "comments", "comment", "details", "other info"], { std: true }),
      ],
    },
    menu: {
      label: "Menu dishes", noun: "dish", area: "controls", dedupe: "name",
      fields: [
        F("name", "Dish name", "text", ["name", "dish", "dish name", "item", "item name", "menu item", "food item", "recipe", "particulars", "food", "dishes", "menu"], { std: true, required: true }),
        F("category", "Course / category", "text", ["category", "course", "section", "menu section", "type", "meal course", "group", "head", "course type", "menu category", "station"], { std: true }),
        F("diet", "Diet", "diet", ["diet", "veg non veg", "veg nonveg", "veg or non veg", "veg", "non veg", "food type", "dietary", "v nv", "veg nv", "kind", "classification", "preference", "jain", "type of food", "dietary type"]),
        F("cuisine", "Cuisine", "text", ["cuisine", "cuisine type", "region", "style", "origin"]),
        F("price_per_plate", "Price per plate", "money", ["price per plate", "per plate", "plate price", "price", "rate", "selling price", "cost per plate", "rate per plate", "pp", "per head", "price per head", "per pax", "mrp", "amount", "rate plate", "plate rate", "rate per head", "rate per pax"],
          { anti: /\b(food cost|making|raw|production|costing)\b/ }),
        F("cost", "Food cost", "money", ["food cost", "cost", "cost price", "making cost", "raw material cost", "cp", "costing", "production cost"], { anti: /\b(selling|sale|price per plate|plate price|rate)\b/ }),
        F("description", "Description", "text", ["description", "desc", "details", "about", "ingredients", "contents", "notes", "remarks"]),
        F("allergens", "Allergens", "list", ["allergens", "allergen", "allergy", "contains", "allergy info", "allergen info"]),
        F("spice_level", "Spice level", "spice", ["spice level", "spice", "spicy", "heat", "chilli level", "spiciness"]),
        F("serving_size", "Serving size", "text", ["serving size", "portion", "portion size", "serving", "qty per plate", "quantity per plate", "grams", "per person qty"]),
        F("live_counter", "Live counter", "bool", ["live counter", "live", "live station", "counter", "live cooking", "is live"]),
        F("min_order", "Minimum order (plates)", "number", ["minimum order", "min order", "moq", "min plates", "minimum plates", "min pax"]),
      ],
    },
    vendors: {
      label: "Vendors", noun: "vendor", area: "vendors", dedupe: "name",
      fields: [
        F("name", "Vendor name", "text", ["name", "vendor", "vendor name", "supplier", "supplier name", "company", "company name", "business name", "firm", "firm name", "party name", "agency"], { std: true, required: true }),
        F("category", "Category / service", "text", ["category", "service", "services", "type", "speciality", "trade", "work type", "service type", "vendor type"], { std: true }),
        F("contact_person", "Contact person", "text", ["contact person", "contact name", "owner", "proprietor", "poc", "point of contact", "person"]),
        F("phone", "Phone", "phone", ["phone", "mobile", "contact", "contact no", "contact number", "ph", "phone no", "mobile no", "cell", "whatsapp", "tel", "mob"], { std: true }),
        F("alt_phone", "Alternate phone", "phone", ["alternate phone", "alt phone", "landline", "office phone", "phone 2", "other phone"]),
        F("email", "Email", "email", ["email", "e mail", "email id", "mail", "mail id", "email address"], { std: true }),
        F("city", "City", "text", ["city", "location", "town", "area", "emirate", "district"]),
        F("address", "Address", "text", ["address", "office address", "addr", "street"]),
        F("gstin", "GSTIN / Tax no.", "text", ["gstin", "gst", "gst no", "gst number", "trn", "vat", "vat no", "tax id", "ein", "tin", "pan"]),
        F("rate", "Typical rate", "money", ["rate", "price", "charges", "cost", "fee", "rate card", "starting price"]),
        F("payment_terms", "Payment terms", "text", ["payment terms", "terms", "credit days", "credit period", "payment"]),
        F("bank_account", "Bank account no.", "text", ["bank account", "account number", "account no", "ac no", "iban"]),
        F("ifsc", "IFSC / routing code", "text", ["ifsc", "ifsc code", "swift", "routing number"]),
        F("rating", "Rating", "number", ["rating", "stars", "score", "grade"]),
        F("notes", "Notes", "text", ["notes", "note", "remarks", "comments", "details"], { std: true }),
      ],
    },
  };
  Object.keys(ENTITIES).forEach((e) => ENTITIES[e].fields.forEach((f) => {
    f.synN = [...new Set([f.key.replace(/_/g, " "), normHeader(f.label)].concat(f.syn.map(normHeader)))];
    f.synC = f.synN.map(compact);
  }));
  const entityDef = (e) => { const d = ENTITIES[e]; if (!d) throw new Error("Unknown import type: " + e); return d; };
  const fieldOf = (e, k) => entityDef(e).fields.find((f) => f.key === k) || null;

  /* ---------------- value sniffing ---------------- */
  function sniff(values) {
    const v = values.map(clean).filter(Boolean).slice(0, 60);
    const n = v.length || 1, c = (re) => v.filter((x) => re.test(x)).length / n;
    return {
      n: v.length,
      email: c(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
      phone: v.filter((x) => { const d = x.replace(/\D/g, ""); return /^[+\d(][\d\s().\/-]{6,}$/.test(x) && d.length >= 7 && d.length <= 13 && !/^\d{4}-\d{2}-\d{2}/.test(x); }).length / n,
      money: c(/^(rs\.?|inr|aed|usd|\u20B9|\$)\s*[\d,]+(\.\d+)?|[\d,]+(\.\d+)?\s*(\/-|rs|inr|aed)$/i),
      num: c(/^-?[\d,]+(\.\d+)?$/),
      date: v.filter((x) => /^\d{4}-\d{1,2}-\d{1,2}/.test(x) || /^\d{1,2}[-\/.](\d{1,2}|[a-z]{3,9})[-\/.]\d{2,4}$/i.test(x)).length / n,
      diet: c(/^(veg|non[- ]?veg|nv|v|egg|jain|vegan|vegetarian|non[- ]?vegetarian)$/i),
      yesno: c(/^(y|n|yes|no|true|false)$/i),
      avgLen: v.reduce((s, x) => s + x.length, 0) / n,
      distinct: new Set(v.map((x) => x.toLowerCase())).size / n,
    };
  }
  function sniffBoost(f, s) {
    if (!s || !s.n) return 0;
    if (f.type === "email") return s.email > 0.6 ? 0.35 : s.email < 0.1 ? -0.4 : 0;
    if (f.type === "phone") return s.phone > 0.6 ? 0.25 : s.phone < 0.1 && s.n > 2 ? -0.35 : 0;
    if (f.type === "money" || f.type === "number" || f.type === "int") return s.num + s.money > 0.6 ? 0.1 : s.n > 2 && s.num + s.money < 0.2 ? -0.35 : 0;
    if (f.type === "date") return s.date > 0.6 || s.num > 0.8 ? 0.15 : s.n > 2 && s.date < 0.1 ? -0.3 : 0;
    if (f.type === "diet") return s.diet > 0.6 ? 0.35 : s.n > 2 && s.diet < 0.2 ? -0.3 : 0;
    if (f.type === "bool") return s.yesno > 0.6 ? 0.2 : s.n > 2 && s.yesno < 0.2 ? -0.3 : 0;
    if (f.key === "name") return s.num > 0.6 || s.email > 0.5 || s.phone > 0.5 ? -0.5 : s.distinct > 0.7 ? 0.05 : 0;
    if (f.type === "text") return s.email > 0.6 || s.phone > 0.6 ? -0.3 : 0;
    return 0;
  }
  // which field types a sniffed column could be, for headerless / unnamed columns
  function sniffOnly(f, s) {
    if (!s || s.n < 2) return 0;
    if (f.type === "email" && s.email > 0.8) return 0.75;
    if (f.type === "phone" && f.key === "phone" && s.phone > 0.8) return 0.7;
    if (f.type === "diet" && s.diet > 0.8) return 0.7;
    return 0;
  }

  /* ---------------- header scoring ---------------- */
  function nameScore(hn, f) {
    if (!hn) return 0;
    const hc = compact(hn);
    let best = 0;
    for (let i = 0; i < f.synN.length; i++) {
      const sn = f.synN[i], sc = f.synC[i];
      if (hn === sn || hc === sc) return 1;
      if (sc.length >= 3 && hc.length >= 3) {
        const toks = hn.split(" "), stoks = sn.split(" ");
        if (stoks.length > 1 && stoks.every((t) => toks.includes(t))) best = Math.max(best, 0.86 - 0.03 * (toks.length - stoks.length));
        else if (stoks.length === 1 && toks.includes(sn) && sn.length >= 3) best = Math.max(best, 0.8 - 0.04 * (toks.length - 1));
        const s = sim(hc, sc);
        if (s >= 0.8 && Math.min(hc.length, sc.length) >= 4) best = Math.max(best, s * 0.88);
        if (hc.length >= 5 && sc.length >= 5 && (hc.startsWith(sc) || sc.startsWith(hc))) best = Math.max(best, 0.72);
      }
    }
    return best;
  }

  /* ---------------- header-row detection ---------------- */
  function rowStats(row, entity) {
    const cells = (row || []).map(clean);
    const filled = cells.filter(Boolean);
    if (!filled.length) return { score: 0, filled: 0 };
    const def = entityDef(entity);
    let hits = 0, textish = 0;
    filled.forEach((c) => {
      if (!/^-?[\d,.]+$/.test(c) && c.length <= 60 && !/@/.test(c)) textish++;
      const hn = normHeader(c);
      if (def.fields.some((f) => nameScore(hn, f) >= 0.8)) hits++;
    });
    return { score: hits * 3 + textish - (filled.length - textish) * 2, filled: filled.length, hits, cells };
  }
  // returns { index, headers[] } — handles title rows above the header and 2-level (merged) headers
  function detectHeader(table, entity) {
    const rows = table || [];
    let best = -1, bestS = null;
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const st = rowStats(rows[i], entity);
      if (st.filled < 1) continue;
      if (!bestS || st.score > bestS.score || (st.score === bestS.score && st.hits > bestS.hits)) { best = i; bestS = st; }
    }
    if (best < 0) return { index: 0, headers: [] };
    let headers = (rows[best] || []).map(clean);
    let index = best;
    // two-level header: a sparse group row ("Personal details" | "" | "Bank") above or a sub-row below
    const below = rows[best + 1] ? rowStats(rows[best + 1], entity) : null;
    if (below && below.hits >= 2 && below.hits >= (bestS.hits || 0) * 0.6 && headers.some((h) => !h)) {
      const sub = rows[best + 1].map(clean); let group = "";
      headers = Array.from({ length: Math.max(headers.length, sub.length) }, (_, c) => { if (headers[c]) group = headers[c]; return sub[c] || headers[c] || group; });
      index = best + 1;
    }
    const width = Math.max(headers.length, ...rows.slice(index + 1, index + 50).map((r) => (r || []).length));
    headers = Array.from({ length: Math.min(width, MAX_COLS) }, (_, c) => headers[c] || "");
    return { index, headers };
  }

  /* ---------------- auto-mapping ---------------- */
  // mapping[c] = { target: "field:<key>" | "custom" | "ignore", key, label, confidence 0..1, why }
  function autoMap(entity, headers, bodyRows, saved) {
    const def = entityDef(entity);
    const cols = headers.map((h, c) => ({ c, h: clean(h), hn: normHeader(h), sn: sniff((bodyRows || []).map((r) => (r || [])[c])) }));
    const savedMap = (saved && saved.columns) || {};
    const pairs = [];
    cols.forEach((col) => {
      def.fields.forEach((f, fi) => {
        let s = nameScore(col.hn, f);
        // C1: intent cues - "Rate/day", "Hire rate" lean to the rental price; "Purchase", "MRP" to the cost
        if (s > 0 && s < 1 && f.cue && f.cue.test(col.hn)) s = Math.min(0.97, s + 0.15);
        if (s > 0 && f.anti && f.anti.test(col.hn)) s = Math.max(0, s - 0.45);
        if (s > 0) { let b = sniffBoost(f, col.sn); if (s >= 0.75 && b < 0 && f.type === "text") b = Math.max(b, -0.2); s = Math.min(1, s + b * (s >= 1 ? 0.3 : 1)); }
        else s = sniffOnly(f, col.sn);
        if (s >= 0.5) pairs.push({ c: col.c, f, s, fi });
      });
    });
    pairs.sort((a, b) => b.s - a.s || a.fi - b.fi || a.c - b.c);
    const used = new Set(), out = headers.map(() => null);
    // saved choices first (exact header text the studio confirmed last time)
    cols.forEach((col) => {
      const sv = savedMap[col.hn];
      if (!sv) return;
      if (sv === "ignore") out[col.c] = { target: "ignore", confidence: 1, why: "saved" };
      else if (sv === "custom" || /^custom:/.test(sv)) out[col.c] = { target: "custom", confidence: 1, why: "saved", key: sv.slice(7) || null };
      else if (/^field:/.test(sv) && fieldOf(entity, sv.slice(6)) && !used.has(sv.slice(6))) { out[col.c] = { target: sv, confidence: 1, why: "saved" }; used.add(sv.slice(6)); }
    });
    pairs.forEach((p) => {
      if (out[p.c] || used.has(p.f.key)) return;
      out[p.c] = { target: "field:" + p.f.key, confidence: Math.round(p.s * 100) / 100, why: p.s >= 1 ? "exact" : "similar" };
      used.add(p.f.key);
    });
    // a second phone-looking column becomes the alternate phone
    cols.forEach((col) => {
      if (out[col.c] || !col.hn) return;
      const alt = def.fields.find((f) => f.key === "alt_phone");
      if (alt && !used.has("alt_phone") && col.sn.phone > 0.7 && /phone|mobile|contact|cell|whatsapp|tel|mob|number/.test(col.hn)) {
        out[col.c] = { target: "field:alt_phone", confidence: 0.6, why: "values" }; used.add("alt_phone");
      }
    });
    // serial-number columns ("Sr", "S.No", "Sl No", "#") carry no information: ignored by default
    cols.forEach((col) => {
      if (!out[col.c] && /^(s ?r|s ?no|sr no|sl|sl no|serial|serial no|no|sno|srno|slno|row|idx|index)$/.test(col.hn || "no"))
        if (col.hn || col.h === "#") out[col.c] = { target: "ignore", confidence: 0.9, why: "serial" };
    });
    // everything else with a header and data is kept as a custom field; empty columns are ignored
    cols.forEach((col) => {
      if (out[col.c]) return;
      out[col.c] = col.h && col.sn.n ? { target: "custom", confidence: 0, why: "new" } : { target: "ignore", confidence: 0, why: col.h ? "empty" : "no header" };
    });
    // custom keys + labels
    const taken = new Set(def.fields.map((f) => f.key));
    out.forEach((m, c) => {
      if (m.target === "custom") { m.label = cols[c].h || "Column " + (c + 1); m.key = m.key && !taken.has(m.key) ? (taken.add(m.key), m.key) : slugKey(m.label, taken); }
    });
    return out;
  }
  function mappingToSaved(headers, mapping) {
    const columns = {};
    headers.forEach((h, c) => {
      const hn = normHeader(h), m = mapping[c]; if (!hn || !m) return;
      columns[hn] = m.target === "custom" ? "custom:" + (m.key || "") : m.target;
    });
    return { v: 1, columns };
  }

  /* ---------------- row building + validation ---------------- */
  function isBlankRow(r) { return !(r || []).some((c) => clean(c) !== ""); }
  function parseTyped(f, raw, opts) {
    const t = f.type;
    if (raw == null || clean(raw) === "") return { value: null };
    if (t === "phone") return parsePhone(raw);
    if (t === "email") return parseEmail(raw);
    if (t === "money" || t === "number" || t === "int") {
      const n = parseAmount(raw);
      if (n === null) return { value: null };
      if (Number.isNaN(n)) return { value: null, error: f.label + " should be a number" };
      if (n < 0) return { value: null, error: f.label + " cannot be negative" };
      if (n >= 1e12) return { value: null, error: f.label + " is too large" };
      return { value: t === "int" ? Math.round(n) : Math.round(n * 100) / 100 };
    }
    if (t === "date") return parseDate(raw, opts && opts.dateOrder);
    if (t === "bool") return parseBool(raw);
    if (t === "diet") return parseDiet(raw);
    if (t === "emp") return parseEmp(raw);
    if (t === "list") return parseList(raw);
    if (t === "spice") return parseSpice(raw);
    return { value: safeText(raw) || null };
  }
  // dmy unless a date column clearly uses month-first (a 2nd part > 12)
  function guessDateOrder(rows, mapping, entity) {
    let dmy = 0, mdy = 0;
    mapping.forEach((m, c) => {
      const f = m && /^field:/.test(m.target) ? fieldOf(entity, m.target.slice(6)) : null;
      if (!f || f.type !== "date") return;
      rows.slice(0, 500).forEach((r) => { const x = clean((r || [])[c]).match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.]\d{2,4}/); if (x) { if (+x[1] > 12) dmy++; if (+x[2] > 12) mdy++; } });
    });
    return mdy > dmy ? "mdy" : "dmy";
  }
  function buildRows(entity, table, headerIndex, mapping, opts) {
    const def = entityDef(entity); opts = opts || {};
    const body = (table || []).slice(headerIndex + 1);
    const header = ((table || [])[headerIndex] || []).map(normHeader);
    const dateOrder = opts.dateOrder || guessDateOrder(body, mapping, entity);
    const out = []; let skippedBlank = 0, truncated = false;
    for (let i = 0; i < body.length; i++) {
      const r = body[i] || [];
      if (isBlankRow(r)) { skippedBlank++; continue; }
      // B4: a row whose MAPPED cells are all empty (e.g. "3,,,,,," - only a serial number or an
      // ignored column filled) is a blank row: dropped silently, never shown as "Fix needed"
      if (!(mapping || []).some((m, c) => m && m.target !== "ignore" && clean(r[c]) !== "")) { skippedBlank++; continue; }
      if (header.length && r.map(normHeader).join("|") === header.join("|")) { skippedBlank++; continue; }   // repeated header (multi-page export)
      if (out.length >= MAX_ROWS) { truncated = true; break; }
      const fields = {}, attributes = {}, errors = [], warnings = [];
      mapping.forEach((m, c) => {
        if (!m || m.target === "ignore") return;
        const raw = r[c];
        if (m.target === "custom") { const v = safeText(raw); if (v) attributes[m.key] = v.slice(0, 500); return; }
        const f = fieldOf(entity, m.target.slice(6)); if (!f) return;
        const p = parseTyped(f, raw, { dateOrder });
        if (p.error) { errors.push(f.label + ": " + p.error.replace(f.label + " ", "")); attributes["raw_" + f.key] = safeText(raw).slice(0, 200); return; }
        if (p.warn) { warnings.push(f.label + ": " + p.warn); attributes[f.key + "_text"] = safeText(raw).slice(0, 200); }
        if (p.extra && f.key === "phone" && !fields.alt_phone) attributes.alt_phone = p.extra.slice(0, 60);
        if (p.value == null) return;
        if (f.std) fields[f.key] = p.value;
        else attributes[f.key] = Array.isArray(p.value) ? p.value.join(", ") : p.value;
      });
      // name from first + last when there is no name column
      if (!fields.name && (attributes.first_name || attributes.last_name)) fields.name = [attributes.first_name, attributes.last_name].filter(Boolean).join(" ");
      // menu: diet → dish kind (veg/nonveg); exact diet kept as an attribute
      if (entity === "menu") fields.kind = attributes.diet === "nonveg" || attributes.diet === "egg" ? "nonveg" : "veg";
      if (entity === "staff" && attributes.monthly_salary != null && fields.day_rate == null && opts.deriveDayRate) fields.day_rate = Math.round(attributes.monthly_salary / 26);
      def.fields.filter((f) => f.required).forEach((f) => {
        if (fields[f.key] == null || fields[f.key] === "") {
          if (f.key === "phone" && errors.some((e) => /^Phone/.test(e))) return;
          errors.push(f.label + " is missing");
        }
      });
      if (fields.name && String(fields.name).length > 300) errors.push("Name is longer than 300 characters");
      const keys = Object.keys(attributes);
      if (keys.length > MAX_ATTRS) { errors.push("Too many custom fields (" + keys.length + "); ignore some columns"); }
      out.push({ line: headerIndex + 2 + i, fields, attributes, errors, warnings, raw: r });
    }
    return { rows: out, skippedBlank, truncated, dateOrder };
  }

  /* ---------------- duplicates ---------------- */
  const normName = (t) => String(t == null ? "" : t).normalize("NFKC").toLowerCase().replace(/&/g, " and ").normalize("NFD").replace(/[\u0300-\u036F]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const digits10 = (p) => { const d = String(p == null ? "" : p).replace(/\D+/g, ""); return d.length >= 7 ? d.slice(-10) : ""; };
  function dupKeys(entity, rec) {
    const ks = [];
    if (entityDef(entity).dedupe === "staff") { const d = digits10(rec.phone); if (d) ks.push("p:" + d); }
    const n = normName(rec.name); if (n) ks.push("n:" + n);
    return ks;
  }
  // existing: rows from the DB (id, name, phone, active...). Sets row.match / row.status / row.action.
  function markDuplicates(entity, rows, existing) {
    const idx = new Map();
    (existing || []).forEach((e) => dupKeys(entity, e).forEach((k) => { if (!idx.has(k) || idx.get(k).active === false) idx.set(k, e); }));
    const seen = new Map();
    rows.forEach((r) => {
      r.match = null; r.dupInFile = null;
      if (r.errors.length) { r.status = "error"; r.action = "skip"; return; }
      const ks = dupKeys(entity, r.fields);
      for (const k of ks) { if (idx.has(k)) { r.match = idx.get(k); break; } }
      for (const k of ks) { if (seen.has(k)) { r.dupInFile = seen.get(k); break; } }
      ks.forEach((k) => { if (!seen.has(k)) seen.set(k, r.line); });
      if (r.match) { r.status = "duplicate"; r.action = "skip"; }
      else if (r.dupInFile) { r.status = "dup-in-file"; r.action = "skip"; }
      else { r.status = "new"; r.action = "create"; }
    });
    return rows;
  }
  // Allowed per-row choices. Name-unique tables (inventory/menu/vendors) cannot "create" a second same-name row.
  function actionsFor(entity, r) {
    if (r.status === "error") return ["skip"];
    if (r.status === "new") return ["create", "skip"];
    if (r.status === "dup-in-file") return ["skip", "create"];
    const uniqueName = entityDef(entity).dedupe === "name" || normName(r.match && r.match.name) === normName(r.fields.name);
    return uniqueName && entity !== "staff" ? ["skip", "update"] : ["skip", "update", "create"];
  }
  function setAction(entity, r, a) { if (actionsFor(entity, r).includes(a)) r.action = a; return r.action; }
  function summarise(rows) {
    const s = { total: rows.length, create: 0, update: 0, skip: 0, errors: 0, duplicates: 0 };
    rows.forEach((r) => { s[r.action] = (s[r.action] || 0) + 1; if (r.status === "error") s.errors++; if (r.status === "duplicate" || r.status === "dup-in-file") s.duplicates++; });
    return s;
  }

  /* ---------------- payloads for smart_import_batch ---------------- */
  function payloads(entity, rows, mapping) {
    const defs = [], seenK = new Set();
    (mapping || []).forEach((m) => { if (m && m.target === "custom" && m.key && !seenK.has(m.key)) { seenK.add(m.key); defs.push({ key: m.key, label: String(m.label || m.key).slice(0, 80), type: "text" }); } });
    entityDef(entity).fields.forEach((f) => { if (!f.std && (mapping || []).some((m) => m && m.target === "field:" + f.key)) defs.push({ key: f.key, label: f.label, type: f.type === "money" || f.type === "number" || f.type === "int" ? "number" : f.type === "date" ? "date" : f.type === "bool" ? "bool" : "text" }); });
    const list = rows.filter((r) => r.action === "create" || r.action === "update").map((r) => {
      const o = { i: r.line, action: r.action, fields: r.fields, attributes: r.attributes };
      if (r.action === "update") o.id = r.match && r.match.id;
      return o;
    });
    const batches = [];
    for (let i = 0; i < list.length; i += BATCH) batches.push(list.slice(i, i + BATCH));
    return { defs: defs.slice(0, 64), batches };
  }

  /* ---------------- results CSV ---------------- */
  function csvCell(v) {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function resultsCSV(headers, rows, results) {
    const byLine = new Map((results || []).map((x) => [Number(x.i), x]));
    const head = ["Row", "Result", "Message"].concat(headers.map((h, c) => h || "Column " + (c + 1)));
    const lines = [head.map(csvCell).join(",")];
    rows.forEach((r) => {
      const res = byLine.get(r.line);
      let result, msg;
      if (r.errors.length) { result = "error"; msg = r.errors.join("; "); }
      else if (res) { result = res.status; msg = res.error || ""; }
      else if (r.action === "skip") { result = "skipped"; msg = r.status === "duplicate" ? "Already exists" : r.status === "dup-in-file" ? "Repeated in this file (row " + r.dupInFile + ")" : ""; }
      else { result = "not imported"; msg = "Import stopped before this row"; }
      lines.push([r.line, result, msg].concat(headers.map((h, c) => r.raw[c])).map(csvCell).join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }

  /* ---------------- display helpers (for list / detail UIs) ---------------- */
  // [{key,label,value}] for a row's attributes, labelled by defs (custom_field_defs) then built-ins
  // C5: money-type attributes (rental price, replacement cost, purchase price, rates, salaries) are
  // shown in the studio's currency ("AED 15.00", "\u20b915") instead of a bare number
  const MONEY_KEY = /(price|cost|rate|salary|wage|fee|charge|amount|value|mrp|deposit|allowance)/i;
  function defaultMoney(n) {
    const B = (typeof window !== "undefined" && window.BPStore) || (root && root.BPStore);
    if (B && typeof B.studioMoney === "function") { try { return B.studioMoney(n); } catch (e) {} }
    return null;
  }
  function attrList(entity, attrs, defs, opts) {
    const a = attrs && typeof attrs === "object" ? attrs : {};
    const money = (opts && opts.money) || defaultMoney;
    const lab = new Map(), mType = new Map(); (ENTITIES[entity] ? ENTITIES[entity].fields : []).forEach((f) => { lab.set(f.key, f.label); mType.set(f.key, f.type === "money"); });
    // a built-in money field stays money even if an older import saved its def as "number"
    (defs || []).forEach((d) => { if (d && d.type && !(mType.get(d.key) === true && d.type === "number")) mType.set(d.key, d.type === "money" || (d.type === "number" && (MONEY_KEY.test(d.key) || MONEY_KEY.test(String(d.label || ""))))); });
    const isMoney = (k) => (mType.has(k) ? mType.get(k) : MONEY_KEY.test(k) || MONEY_KEY.test(String(lab.get(k) || "")));
    const fmt = (k, v) => {
      if (typeof v === "boolean") return v ? "Yes" : "No";
      if (isMoney(k)) { const n = typeof v === "number" ? v : (/^\s*-?\d+(\.\d+)?\s*$/.test(String(v)) ? Number(v) : NaN);
        if (isFinite(n)) { const m = money(n); if (m) return m; } }
      return String(v);
    };
    const order = new Map(); (defs || []).forEach((d, i) => { if (d.active !== false) lab.set(d.key, d.label); order.set(d.key, d.active === false ? -1 : i); });
    return Object.keys(a).filter((k) => a[k] != null && a[k] !== "" && order.get(k) !== -1)
      .sort((x, y) => (order.has(x) ? order.get(x) : 1e6) - (order.has(y) ? order.get(y) : 1e6) || x.localeCompare(y))
      .map((k) => ({ key: k, label: lab.get(k) || k.replace(/_/g, " ").replace(/^\w/, (m) => m.toUpperCase()), value: fmt(k, a[k]), raw: a[k] }));
  }

  const api = {
    MAX_ROWS, BATCH, ENTITIES, decode, parseCSV, entityDef, fieldOf, clean, safeText, normHeader, slugKey, sim,
    parseAmount, parsePhone, parseEmail, parseDate, parseBool, parseDiet, parseEmp, parseList,
    sniff, detectHeader, autoMap, mappingToSaved, buildRows, markDuplicates, actionsFor, setAction, summarise,
    payloads, resultsCSV, attrList, normName,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.HelmImportCore = api;
})(typeof window !== "undefined" ? window : null);
