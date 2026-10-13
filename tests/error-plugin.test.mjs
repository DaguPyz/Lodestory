import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const runtimeNodeModules = path.resolve(path.dirname(process.execPath), '..', 'node_modules');
  const searchPaths = [process.cwd(), runtimeNodeModules];

  for (const packageName of ['playwright', '@playwright/test']) {
    let resolved;
    try {
      resolved = require.resolve(packageName, { paths: searchPaths });
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') continue;
      throw error;
    }

    const playwright = require(resolved);
    if (!playwright.chromium) {
      throw new Error(`${packageName} is installed but does not expose Chromium.`);
    }
    return playwright;
  }
  return undefined;
}

function isMissingChromiumExecutable(error) {
  return /Executable doesn't exist|Please run.*playwright install/i.test(
    error?.message ?? String(error),
  );
}

test('React 19 error boundaries isolate failures and keep the root usable', async (t) => {
  const playwright = loadPlaywright();
  if (!playwright) {
    t.skip('Playwright is not installed; the browser-level React boundary check was not run.');
    return;
  }

  let browser;
  let server;
  try {
    try {
      browser = await playwright.chromium.launch({ headless: true });
    } catch (error) {
      if (isMissingChromiumExecutable(error)) {
        t.skip(`Chromium is not installed; the browser-level React boundary check was not run: ${error.message}`);
        return;
      }
      throw error;
    }

    server = await createServer({
      configFile: false,
      root: process.cwd(),
      appType: 'mpa',
      server: { host: '127.0.0.1', port: 0, strictPort: true },
    });
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const page = await browser.newPage();

    await page.goto(`${origin}/tests/fixtures/error-boundary.html?mode=local`);
    const counter = page.locator('#b-counter');
    await counter.click();
    await page.evaluate(() => {
      window.__bCounterNode = document.querySelector('#b-counter');
    });
    await page.locator('#trigger-a').click();

    const localErrorView = page.locator('#a-region .app-startup-error[role="alert"]');
    await localErrorView.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#a-content').count(), 0);
    assert.equal(await counter.textContent(), 'B count: 1');
    assert.equal(
      await page.evaluate(() => window.__bCounterNode === document.querySelector('#b-counter')),
      true,
      'the healthy sibling keeps the same DOM node after A fails',
    );
    await counter.click();
    assert.equal(await counter.textContent(), 'B count: 2');
    assert.deepEqual(await page.evaluate(() => window.__uncaughtErrorCalls), []);

    await page.goto(`${origin}/tests/fixtures/error-boundary.html?mode=outer`);
    await page.locator('#trigger-wrapper').click();
    await page.locator('#root > .app-startup-error[role="alert"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#wrapper-content').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__uncaughtErrorCalls), []);
  } finally {
    await browser?.close();
    await server?.close();
  }
});
