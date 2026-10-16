/* demo.js — the public read-only Demo Studio (/demo).
   A guided look at Helm with a bundled, made-up studio. It never talks to a server:
     1. no Supabase: SUPABASE_CONFIG is frozen blank and every non-GET / API / cross-origin
        request is refused (fetch, XHR, sendBeacon, WebSocket) — same guard as try.js;
     2. data: the fictional DATA object below (no real studio, client or person);
     3. views by #hash, built with DOM APIs + textContent only (no HTML string sinks);
     4. every "action" button only shows a read-only toast. */
(function () {
  'use strict';
  var W = window, D = document;
  try { Object.defineProperty(W, 'HELM_DEMO', { value: true, writable: false, configurable: false }); } catch (e) {}
  try { Object.defineProperty(W, 'SUPABASE_CONFIG', { value: Object.freeze({ url: '', anonKey: '' }), writable: false, configurable: false }); } catch (e) {}

  /* ---- 1. network guard ---- */
  function okUrl(u, method) {
    if (String(method || 'GET').toUpperCase() !== 'GET') return false;
    var url; try { url = new URL(String(u), location.href); } catch (e) { return false; }
    if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
    if (url.origin === location.origin) return !/^\/(api|functions|rest|auth|storage|realtime)(\/|$)/.test(url.pathname);
    return false;
  }
  W.__demoOk = okUrl;   // tests / debugging only
  var realFetch = W.fetch;
  if (realFetch) {
    W.fetch = function (input, init) {
      var u = input && typeof input === 'object' && 'url' in input ? input.url : input;
      var m = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
      if (!okUrl(u, m)) return Promise.reject(new TypeError('Demo: network request blocked'));
      return realFetch.apply(this, arguments);
    };
  }
  if (W.XMLHttpRequest) {
    var open = W.XMLHttpRequest.prototype.open;
    W.XMLHttpRequest.prototype.open = function (m, u) {
      if (!okUrl(u, m)) throw new TypeError('Demo: network request blocked');
      return open.apply(this, arguments);
    };
  }
  try { if (navigator.sendBeacon) navigator.sendBeacon = function () { return false; }; } catch (e) {}
  if (W.WebSocket) W.WebSocket = function () { throw new TypeError('Demo: network request blocked'); };

  /* ---- 2. fictional data (amounts in INR) ---- */
  var DATA = {
    studio: 'Marigold Events',
    kpis: { pipeline: 1865000, booked: 2340000, received: 1512000, events: 6 },
    months: [['Jun', 420000], ['Jul', 380000], ['Aug', 610000], ['Sep', 540000], ['Oct', 720000], ['Nov', 930000]],
    upcoming: [
      { name: 'Ananya & Rohan — Wedding reception', date: '2026-11-07', guests: 320, status: 'Confirmed' },
      { name: 'Sterling Labs — Annual offsite dinner', date: '2026-11-14', guests: 140, status: 'Confirmed' },
      { name: 'Meera turns 60 — Garden lunch', date: '2026-11-21', guests: 80, status: 'Advance due' },
      { name: 'Kapoor family — Sangeet night', date: '2026-11-27', guests: 220, status: 'On hold' }
    ],
    tasks: [['Send revised quote to Kapoor family', 'Today'], ['Confirm florist for Ananya & Rohan', 'Tomorrow'], ['Collect advance — Meera turns 60', 'Fri']],
    leads: {
      'New': [['Priya S.', 'Engagement · ~150 guests · Dec'], ['Northwind Foods', 'Product launch · 90 guests'], ['Arjun M.', 'Birthday · 60 guests']],
      'Contacted': [['Kapoor family', 'Sangeet · 220 guests · 27 Nov'], ['Lakeview School', 'Annual day · 400 guests']],
      'Quote sent': [['Meera turns 60', 'Garden lunch · 80 guests'], ['Bluebird Tech', 'Team dinner · 70 guests']],
      'Won': [['Ananya & Rohan', 'Reception · 320 guests'], ['Sterling Labs', 'Offsite dinner · 140 guests']]
    },
    quotes: [
      ['Q-1042', 'Ananya & Rohan', 'Wedding reception', 485000, 'Accepted'],
      ['Q-1043', 'Sterling Labs', 'Offsite dinner', 312000, 'Accepted'],
      ['Q-1046', 'Meera turns 60', 'Garden lunch', 148000, 'Sent'],
      ['Q-1047', 'Kapoor family', 'Sangeet night', 396000, 'Draft'],
      ['Q-1048', 'Bluebird Tech', 'Team dinner', 126000, 'Viewed']
    ],
    proposal: {
      client: 'Ananya & Rohan', event: 'Wedding reception', date: 'Saturday, 7 November 2026', venue: 'Lotus Banquet Hall', guests: 320,
      lines: [['Venue décor — floral stage + entrance arch', 1, 145000], ['Dinner buffet — 4 mains, 2 desserts (per plate)', 320, 650], ['Lighting & sound package', 1, 58000], ['Photo booth with props', 1, 22000], ['Event coordination team (6 people)', 1, 52000]],
      taxRate: 0.18
    },
    event: {
      name: 'Ananya & Rohan — Wedding reception', date: 'Sat 7 Nov 2026 · 6:30 pm', venue: 'Lotus Banquet Hall', guests: 320,
      tasks: [['Final guest count from client', 1], ['Stage floral mock-up approved', 1], ['Lighting rig booked', 1], ['Seating plan (2D) shared with venue', 1], ['Menu tasting with couple', 0], ['Crew call sheet sent', 0], ['Day-of run sheet printed', 0]],
      runsheet: [['4:00 pm', 'Crew arrives, décor setup'], ['6:00 pm', 'Sound check, lights on'], ['6:30 pm', 'Guests arrive, welcome drinks'], ['7:30 pm', 'Couple entry'], ['8:15 pm', 'Dinner service opens'], ['11:00 pm', 'Wrap and load-out']],
      vendors: [['Petal House Florists', 'Décor', 'Confirmed'], ['BrightBeam Lights', 'Lighting & sound', 'Confirmed'], ['Saffron Kitchen', 'Catering', 'Tasting due']]
    },
    settlement: {
      quote: 485000,
      payments: [['Advance', '2026-09-02', 150000, 1], ['Second instalment', '2026-10-10', 200000, 1], ['Balance (due after the event)', '2026-11-08', 135000, 0]],
      bills: [['Saffron Kitchen', 'Catering', 182000, 182000], ['Petal House Florists', 'Décor', 74000, 74000], ['BrightBeam Lights', 'Lighting & sound', 31000, 20000]],
      expenses: [['Crew travel & meals', 12500], ['Printing & signage', 6500]]
    }
  };

  /* ---- 3. helpers ---- */
  var inr = (function () {
    var f; try { f = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }); } catch (e) { f = null; }
    return function (n) { return f ? f.format(n) : '₹' + Math.round(n); };
  })();
  function fmtDate(iso) {
    var d = new Date(iso + 'T00:00:00');
    try { return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return iso; }
  }
  function h(tag, cls, kids) {
    var el = D.createElement(tag);
    if (cls) el.className = cls;
    (Array.isArray(kids) ? kids : kids == null ? [] : [kids]).forEach(function (k) {
      if (k == null || k === false) return;
      el.appendChild(typeof k === 'string' || typeof k === 'number' ? D.createTextNode(String(k)) : k);
    });
    return el;
  }
  var SVGNS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs) { var el = D.createElementNS(SVGNS, tag); for (var k in attrs) el.setAttribute(k, attrs[k]); return el; }
  function pill(text) {
    var map = { Confirmed: 'ok', Accepted: 'ok', Paid: 'ok', Won: 'ok', 'Advance due': 'wt', Sent: '', Viewed: '', 'Part-paid': 'wt', 'Tasting due': 'wt', 'On hold': 'mu', Draft: 'mu', Due: 'wt' };
    return h('span', 'dm-pill' + (map[text] ? ' ' + map[text] : ''), text);
  }
  function head(title, sub, btns) {
    return h('div', 'dm-head', [h('div', null, [h('h1', null, title), sub ? h('p', null, sub) : null]),
      btns ? h('div', 'dm-btns', btns.map(function (b, i) { return roBtn(b, i === 0); })) : null]);
  }
  function roBtn(label, primary) {
    var b = h('button', 'dm-btn' + (primary ? ' primary' : ''), label);
    b.type = 'button'; b.setAttribute('data-ro', '1');
    return b;
  }
  function card(title, kids, cls) { return h('section', 'dm-card' + (cls ? ' ' + cls : ''), [title ? h('h2', null, title) : null].concat(kids)); }
  function table(cols, rows, numCols) {
    numCols = numCols || [];
    var thead = h('thead', null, h('tr', null, cols.map(function (c, i) { var th = h('th', numCols.indexOf(i) >= 0 ? 'num' : null, c); th.scope = 'col'; return th; })));
    var tbody = h('tbody', null, rows.map(function (r) {
      var tr = h('tr', r.cls || null, r.cells.map(function (c, i) { return h('td', numCols.indexOf(i) >= 0 ? 'num dm-money' : null, c); }));
      return tr;
    }));
    return h('div', 'dm-scroll', h('table', 'dm-table', [thead, tbody]));
  }
  function endCta(text) {
    var a = h('a', 'dm-btn primary', 'Start your 8-day free trial');
    a.href = '/login?trial=1#signup';
    var a2 = h('a', 'dm-btn', 'Try the 2D/3D planner');
    a2.href = '/try';
    return h('div', 'dm-end', [h('p', null, text), h('div', 'dm-btns', [a2, a])]);
  }
  function link(text, hash) { var a = h('a', null, text); a.href = '#' + hash; return a; }

  /* ---- views ---- */
  var V = {};
  V.dashboard = function () {
    var k = DATA.kpis;
    var kpi = function (l, v, sub) { return card(null, [h('div', 'lbl', l), h('div', 'val', v), h('div', 'sub', sub)], 'dm-kpi'); };
    var max = Math.max.apply(null, DATA.months.map(function (m) { return m[1]; }));
    var svg = s('svg', { 'class': 'dm-chart', viewBox: '0 0 600 160', preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Booked revenue by month, June to November' });
    DATA.months.forEach(function (m, i) {
      var bh = Math.round((m[1] / max) * 120), x = 20 + i * 97;
      svg.appendChild(s('rect', { 'class': 'bar', x: x, y: 130 - bh, width: 60, height: bh, rx: 6 }));
      var t = s('text', { x: x + 30, y: 150, 'text-anchor': 'middle' }); t.textContent = m[0]; svg.appendChild(t);
    });
    return [
      head('Good evening, Marigold', 'Here is your studio at a glance.', ['New quote', 'Add lead']),
      h('div', 'dm-grid dm-kpis', [kpi('Open pipeline', inr(k.pipeline), '7 open leads'), kpi('Booked', inr(k.booked), 'this season'), kpi('Received', inr(k.received), '65% of booked'), kpi('Upcoming events', String(k.events), 'next 45 days')]),
      h('div', 'dm-grid dm-two', [
        card('Booked revenue', [svg, h('p', 'dm-note', 'Accepted quotes by event month.')]),
        card('Today', [h('ul', 'dm-list', DATA.tasks.map(function (t) { return h('li', null, [h('span', 't', t[0]), h('span', 's', t[1])]); }))])
      ]),
      h('div', 'dm-grid', [card('Upcoming events', [h('ul', 'dm-list', DATA.upcoming.map(function (e) {
        return h('li', null, [h('span', null, [h('span', 't', e.name), h('br'), h('span', 's', fmtDate(e.date) + ' · ' + e.guests + ' guests')]), pill(e.status)]);
      })), h('p', 'dm-note', [link('Open the reception workspace →', 'event')])])]),
      endCta('Like what you see? Your own studio is ready in two minutes.')
    ];
  };
  V.leads = function () {
    return [
      head('Leads', 'Every enquiry, from first message to booked.', ['Add lead']),
      h('div', 'dm-board', Object.keys(DATA.leads).map(function (col) {
        var items = DATA.leads[col];
        return h('section', 'dm-col', [h('h2', null, [h('span', null, col), h('span', 'dm-pill mu', String(items.length))])].concat(items.map(function (l) {
          return h('div', 'dm-lead', [h('div', 't', l[0]), h('div', 's', l[1])]);
        })));
      })),
      endCta('Capture leads from your website form, WhatsApp or by hand.')
    ];
  };
  V.quotes = function () {
    return [
      head('Quotes', 'Build a priced quote from your own menu and packages.', ['New quote']),
      card(null, [table(['Quote', 'Client', 'Event', 'Total', 'Status'], DATA.quotes.map(function (q) {
        return { cells: [q[0], q[1], q[2], inr(q[3]), pill(q[4])] };
      }), [3]), h('p', 'dm-note', ['Clients get a branded proposal link — ', link('see one', 'proposal'), '.'])]),
      endCta('Send your first quote today.')
    ];
  };
  V.proposal = function () {
    var p = DATA.proposal, sub = 0;
    var rows = p.lines.map(function (l) { var amt = l[1] * l[2]; sub += amt; return { cells: [l[0], String(l[1]), inr(l[2]), inr(amt)] }; });
    var tax = Math.round(sub * p.taxRate);
    rows.push({ cls: 'tot', cells: ['Subtotal', '', '', inr(sub)] });
    rows.push({ cells: ['GST 18%', '', '', inr(tax)] });
    rows.push({ cls: 'tot', cells: ['Total', '', '', inr(sub + tax)] });
    return [
      head('Client proposal', 'What your client sees when you share a quote.', ['Approve & pay advance']),
      h('div', 'dm-prop', [
        h('div', 'hero', [h('h2', null, p.client + ' — ' + p.event), h('p', null, p.date + ' · ' + p.venue + ' · ' + p.guests + ' guests')]),
        card('Your package', [table(['Item', 'Qty', 'Rate', 'Amount'], rows, [1, 2, 3])]),
        h('p', 'dm-note', 'Prepared by Marigold Events. Sample proposal — prices are illustrative.')
      ]),
      endCta('Proposals with one-click approval and online advance payments.')
    ];
  };
  V.calendar = function () {
    var byDay = { 7: ['Ananya & Rohan', ''], 14: ['Sterling Labs', ''], 21: ['Meera turns 60', ''], 27: ['Kapoor sangeet', 'hold'], 3: ['Site visit — Lotus', ''], 18: ['Menu tasting', ''] };
    var cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(function (d) { return h('div', 'dow', d); });
    // November 2026 starts on a Sunday → 6 leading days from October (26–31).
    for (var i = 26; i <= 31; i++) cells.push(h('div', 'dm-day out', h('span', 'n', String(i))));
    for (var d = 1; d <= 30; d++) {
      var ev = byDay[d];
      cells.push(h('div', 'dm-day', [h('span', 'n', String(d)), ev ? h('span', 'dm-ev' + (ev[1] ? ' ' + ev[1] : ''), ev[0]) : null]));
    }
    for (var j = 1; j <= 6; j++) cells.push(h('div', 'dm-day out', h('span', 'n', String(j))));
    return [
      head('Calendar · November 2026', 'Events, holds and site visits in one view.', ['New event']),
      h('div', 'dm-cal', cells),
      h('p', 'dm-note', 'Amber = date on hold. Helm warns you before you double-book a date or your stock.'),
      endCta('Never double-book a weekend again.')
    ];
  };
  V.event = function () {
    var e = DATA.event, done = e.tasks.filter(function (t) { return t[1]; }).length;
    var prog = s('svg', { viewBox: '0 0 100 8', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    prog.appendChild(s('rect', { x: 0, y: 0, width: Math.round(done / e.tasks.length * 100), height: 8 }));
    var plan = h('a', 'dm-btn', 'Open floor plan in 2D/3D'); plan.href = '/try';
    return [
      head(e.name, e.date + ' · ' + e.venue + ' · ' + e.guests + ' guests', ['Share run sheet', 'Message crew']),
      h('div', 'dm-grid dm-two', [
        card('Checklist · ' + done + ' of ' + e.tasks.length + ' done', [h('div', 'dm-prog', prog), h('ul', 'dm-list dm-tasks', e.tasks.map(function (t) {
          return h('li', t[1] ? 'done' : null, [h('span', 'chk'), h('span', 't', t[0])]);
        }))]),
        h('div', 'dm-grid', [
          card('Run sheet', [h('ul', 'dm-list', e.runsheet.map(function (r) { return h('li', null, [h('span', 's', r[0]), h('span', 't', r[1])]); }))]),
          card('Vendors', [h('ul', 'dm-list', e.vendors.map(function (v) { return h('li', null, [h('span', null, [h('span', 't', v[0]), h('br'), h('span', 's', v[1])]), pill(v[2])]); }))]),
          card('Floor plan', [h('p', 'dm-note', 'Lay out tables, stage and décor to scale, then walk it in 3D.'), plan])
        ])
      ]),
      h('p', 'dm-note', [link('See the settlement and profit for this event →', 'settlement')]),
      endCta('Run every event from one workspace.')
    ];
  };
  V.settlement = function () {
    var st = DATA.settlement;
    var received = st.payments.reduce(function (a, p) { return a + (p[3] ? p[2] : 0); }, 0);
    var bills = st.bills.reduce(function (a, b) { return a + b[2]; }, 0);
    var billsPaid = st.bills.reduce(function (a, b) { return a + b[3]; }, 0);
    var exp = st.expenses.reduce(function (a, x) { return a + x[1]; }, 0);
    var net = st.quote - bills - exp;
    var pl = h('ul', 'dm-list dm-pl', [
      h('li', null, [h('span', null, 'Quote total (revenue, before GST)'), h('span', 'dm-money', inr(st.quote))]),
      h('li', 'minus', [h('span', null, 'Vendor bills'), h('span', 'dm-money', '− ' + inr(bills))]),
      h('li', 'minus', [h('span', null, 'Other expenses'), h('span', 'dm-money', '− ' + inr(exp))]),
      h('li', 'net', [h('span', null, 'Net profit'), h('span', 'dm-money', inr(net))])
    ]);
    return [
      head('Settlement · Ananya & Rohan', 'Money in, money out, and what you kept.', ['Record payment', 'Add vendor bill']),
      h('div', 'dm-grid dm-kpis', [
        card(null, [h('div', 'lbl', 'Received'), h('div', 'val', inr(received)), h('div', 'sub', 'of ' + inr(st.quote))], 'dm-kpi'),
        card(null, [h('div', 'lbl', 'Client balance'), h('div', 'val', inr(st.quote - received)), h('div', 'sub', received >= st.quote ? 'fully settled' : 'due ' + fmtDate(st.payments[st.payments.length - 1][1]))], 'dm-kpi'),
        card(null, [h('div', 'lbl', 'Vendor bills'), h('div', 'val', inr(bills)), h('div', 'sub', inr(bills - billsPaid) + ' still to pay')], 'dm-kpi'),
        card(null, [h('div', 'lbl', 'Margin'), h('div', 'val', Math.round(net / st.quote * 100) + '%'), h('div', 'sub', 'after bills + expenses')], 'dm-kpi')
      ]),
      h('div', 'dm-grid dm-two', [
        h('div', 'dm-grid', [
          card('Client payments', [table(['Milestone', 'Date', 'Amount', 'Status'], st.payments.map(function (p) { return { cells: [p[0], fmtDate(p[1]), inr(p[2]), pill(p[3] ? 'Paid' : 'Due')] }; }), [2])]),
          card('Vendor bills', [table(['Vendor', 'For', 'Bill', 'Paid', 'Status'], st.bills.map(function (b) {
            return { cells: [b[0], b[1], inr(b[2]), inr(b[3]), pill(b[3] >= b[2] ? 'Paid' : 'Part-paid')] };
          }), [2, 3])])
        ]),
        card('Profit & loss', [pl, h('p', 'dm-note', 'Profit = quote total before GST − vendor bills − other expenses. Bills count when entered, even if not yet paid.')])
      ]),
      endCta('Know your real profit on every event.')
    ];
  };

  /* ---- 4. router, theme, read-only toast ---- */
  var ORDER = ['dashboard', 'leads', 'quotes', 'proposal', 'calendar', 'event', 'settlement'];
  var TITLES = { dashboard: 'Dashboard', leads: 'Leads', quotes: 'Quotes', proposal: 'Client proposal', calendar: 'Calendar', event: 'Event workspace', settlement: 'Settlement & P&L' };
  function render(focus) {
    var view = (location.hash || '').replace(/^#/, '');
    if (ORDER.indexOf(view) < 0) view = 'dashboard';
    var main = D.getElementById('main');
    if (!main) return;
    while (main.firstChild) main.removeChild(main.firstChild);
    V[view]().forEach(function (n) { if (n) main.appendChild(n); });
    var navs = D.querySelectorAll('.dm-nav[data-view]');
    for (var i = 0; i < navs.length; i++) {
      if (navs[i].getAttribute('data-view') === view) { navs[i].setAttribute('aria-current', 'page'); try { var side = navs[i].parentNode; if (side.scrollWidth > side.clientWidth) side.scrollLeft = Math.max(0, navs[i].offsetLeft - 16); } catch (e) {} } else navs[i].removeAttribute('aria-current');
    }
    D.title = TITLES[view] + ' · Demo Studio · Helm Events';
    if (focus) { try { main.focus({ preventScroll: true }); } catch (e) {} W.scrollTo(0, 0); }
  }
  var toastT = 0;
  function toast(msg) {
    var t = D.getElementById('dmToast'); if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 3200);
  }
  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function initTheme() {
    var root = D.documentElement, sel = D.getElementById('dmTheme'), mode = D.getElementById('dmMode');
    if (sel) {
      sel.value = root.getAttribute('data-pt') || 'cobalt';
      sel.addEventListener('change', function () { root.setAttribute('data-pt', sel.value); root.setAttribute('data-hb-theme', sel.value); store('helm.shellb.theme', sel.value); });
    }
    if (mode) mode.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next); store('bps.theme', next);
    });
  }
  function boot() {
    initTheme();
    D.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-ro]') : null;
      if (b) { ev.preventDefault(); toast('This is a read-only demo. Start a free trial to do this for real.'); }
    });
    W.addEventListener('hashchange', function () { render(true); });
    render(false);
  }
  W.__demoData = DATA;   // tests only
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', boot); else boot();
})();
