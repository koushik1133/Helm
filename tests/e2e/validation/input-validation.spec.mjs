// Wave 16 — shared input validation + global numeric hardening.
// Runs in a real browser (store-api.js is browser-only). Loads login.html, which
// pulls in store-api.js without needing an authenticated session.
import { test, expect } from '@playwright/test';

const PAGE = '/login.html';

test.describe('@validation shared validators + global number hardener', () => {
  test('BPStore.validate enforces business-semantic rules', async ({ page }) => {
    await page.goto(PAGE);
    await page.waitForFunction(() => window.BPStore && window.BPStore.validate);
    const r = await page.evaluate(() => {
      const V = window.BPStore.validate;
      return {
        countNeg: V.count('-5').ok,
        countText: V.count('10abc').ok,
        countOk: V.count('300').value,
        pctOver: V.pct('-12345678').ok,
        pctOk: V.pct('50').value,
        moneyNeg: V.money('-100').ok,
        moneySci: V.money('1e9').ok,
        moneyOk: V.money('1500.5').value,
        dimZero: V.dimension('0').ok,
        dimOk: V.dimension('10.5').value,
        phoneGarbage: V.phone('9765432ZL0456709O~').ok,
        phoneOk: V.phone('+91 98765 43210').value,
        emailBad: V.email('nope').ok,
        emailOk: V.email(' Me@Ex.COM ').value,
      };
    });
    expect(r.countNeg).toBe(false);
    expect(r.countText).toBe(false);
    expect(r.countOk).toBe(300);
    expect(r.pctOver).toBe(false);
    expect(r.pctOk).toBe(50);
    expect(r.moneyNeg).toBe(false);
    expect(r.moneySci).toBe(false);              // no scientific notation
    expect(r.moneyOk).toBe(1500.5);
    expect(r.dimZero).toBe(false);               // dimension must be > 0
    expect(r.dimOk).toBe(10.5);
    expect(r.phoneGarbage).toBe(false);
    expect(r.phoneOk).toBe('+919876543210');     // normalized
    expect(r.emailBad).toBe(false);
    expect(r.emailOk).toBe('me@ex.com');         // trimmed + lowercased
  });

  test('global hardener clamps every number input (incl. dynamically-added)', async ({ page }) => {
    await page.goto(PAGE);
    await page.waitForFunction(() => window.BPStore && window.BPStore.validate);
    const r = await page.evaluate(async () => {
      const mk = (attrs) => { const el = document.createElement('input'); el.type = 'number'; Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v)); document.body.appendChild(el); return el; };
      const qty = mk({ min: '0' });
      const pct = mk({ min: '0', max: '100' });
      await new Promise((res) => setTimeout(res, 80));   // MutationObserver + boot
      const out = { hardened: qty.getAttribute('data-hardened') };
      qty.value = '-11111'; qty.dispatchEvent(new Event('blur')); out.negClampedTo = qty.value;
      pct.value = '250'; pct.dispatchEvent(new Event('blur')); out.pctClampedTo = pct.value;
      out.minusBlocked = !qty.dispatchEvent(new KeyboardEvent('keydown', { key: '-', cancelable: true }));
      out.eBlocked = !qty.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', cancelable: true }));
      qty.remove(); pct.remove();
      return out;
    });
    expect(r.hardened).toBe('1');
    expect(r.negClampedTo).toBe('0');            // negative clamped to min
    expect(r.pctClampedTo).toBe('100');          // over-max clamped
    expect(r.minusBlocked).toBe(true);
    expect(r.eBlocked).toBe(true);
  });
});
