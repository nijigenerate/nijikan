const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const [appUrl, modelUrl, output = 'test-output/wasm'] = process.argv.slice(2);
if (!appUrl || !modelUrl) throw new Error('Usage: node scripts/test_wasm.cjs APP_URL MODEL_URL [OUTPUT_DIR]');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const logs = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, serviceWorkers: 'block' });
    page.on('console', m => logs.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', e => logs.push(`PAGEERROR: ${e.message}`));
    await page.addInitScript(() => {
      window.renderAudit = { draws: 0, errors: [] };
      for (const name of ['drawElements', 'drawArrays']) {
        const original = WebGL2RenderingContext.prototype[name];
        WebGL2RenderingContext.prototype[name] = function (...args) {
          original.apply(this, args);
          window.renderAudit.draws++;
          const error = this.getError();
          if (error) window.renderAudit.errors.push({ name, error });
        };
      }
    });
    await page.goto(appUrl);
    await page.evaluate(url => {
      document.querySelector('#modelCombo').value = url;
      document.querySelector('#start').click();
    }, modelUrl);
    await page.waitForFunction(() => window.renderAudit.draws > 300 && document.querySelectorAll('#paramPanel code').length > 0, { }, { timeout: 60000 });
    const parameters = await page.locator('#paramPanel code').allTextContents();
    const before = await page.locator('#cv').screenshot({ path: path.join(output, 'model.png') });
    const parameter = await page.evaluate(() => {
      const slider = document.querySelector('#paramPanel input[type=range]');
      if (!slider) throw new Error('No parameter slider');
      const name = slider.closest('.paramRow').querySelector('code').textContent;
      slider.value = Number(slider.value) === Number(slider.max) ? slider.min : slider.max;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return { name, value: slider.value };
    });
    const drawsBefore = await page.evaluate(() => window.renderAudit.draws);
    await page.waitForFunction(n => window.renderAudit.draws > n + 300, drawsBefore);
    const after = await page.locator('#cv').screenshot({ path: path.join(output, 'parameter.png') });
    assert(!before.equals(after), 'Parameter change did not affect capture');
    await page.evaluate(() => document.querySelector('#stop').click());
    const stopped = await page.evaluate(() => window.renderAudit.draws);
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => window.renderAudit.draws), stopped, 'Stop did not stop drawing');
    await page.evaluate(() => document.querySelector('#start').click());
    await page.waitForFunction(n => window.renderAudit.draws > n + 100, stopped);
    await page.setViewportSize({ width: 800, height: 700 });
    await page.waitForFunction(() => document.querySelector('#cv').width <= 800);
    await page.locator('#cv').screenshot({ path: path.join(output, 'resized.png') });
    const audit = await page.evaluate(() => window.renderAudit);
    assert.equal(audit.errors.length, 0, JSON.stringify(audit.errors));
    assert(!logs.some(s => /PAGEERROR|frame error|GL_INVALID|ERROR:/.test(s)), logs.join('\n'));
    const result = { parameters, changedParameter: parameter, ...audit, stopResume: true, resize: true };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    fs.writeFileSync(path.join(output, 'browser.log'), logs.join('\n'));
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
