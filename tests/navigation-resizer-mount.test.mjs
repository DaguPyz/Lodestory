import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createServer} from 'vite';

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const runtimeNodeModules = path.resolve(path.dirname(process.execPath), '..', 'node_modules');
  for (const name of ['playwright', '@playwright/test']) {
    let resolved;
    try { resolved = require.resolve(name, {paths: [process.cwd(), runtimeNodeModules]}); }
    catch (error) { if (error.code === 'MODULE_NOT_FOUND') continue; throw error; }
    const playwright = require(resolved);
    if (!playwright.chromium) throw new Error(`${name} does not expose Chromium.`);
    return playwright;
  }
  return undefined;
}

function missingChromium(error) {
  return /Executable doesn't exist|Please run.*playwright install/i.test(error?.message ?? String(error));
}

function stubLayoutChrome() {
  const ui = '\0navigation-resizer-test-ui';
  return {
    name: 'navigation-resizer-test-chrome',
    enforce: 'pre',
    resolveId(source, importer) {
      const from = importer?.split('?')[0].replaceAll('\\', '/') ?? '';
      if (!from.endsWith('/src/plugins/default-layout/DefaultLayout.tsx')) return undefined;
      if (source === '@lodestory/ui') return ui;
      return undefined;
    },
    load(id) {
      if (id === ui) return `import React from 'react';
        export function Button({children, ...props}) { return React.createElement('button', props, children); }
        export function IconButton({label, children, ...props}) { return React.createElement('button', {...props, 'aria-label': label}, children); }
        export function Icon({name}) { return React.createElement('span', {'data-icon': name}); }
        export function SearchField(props) { return React.createElement('input', props); }
        export function Select({value, onValueChange, options, ...props}) {
          return React.createElement('select', {...props, value, onChange: event => onValueChange(event.target.value)},
            options.map(option => React.createElement('option', {key: option.value, value: option.value, disabled: option.disabled}, option.label)));
        }`;
      return undefined;
    },
  };
}

test('real layout mounts the resizer, previews its width, and persists only on pointer release', async t => {
  const playwright = loadPlaywright();
  if (!playwright) {
    t.skip('Playwright is not installed; browser-level navigation-resizer test was not run.');
    return;
  }

  let browser;
  let server;
  let temp;
  try {
    temp = await mkdtemp(path.join(tmpdir(), 'lodestory-navigation-resizer-'));
    try { browser = await playwright.chromium.launch({headless: true}); }
    catch (error) {
      if (missingChromium(error)) {
        t.skip(`Chromium is not installed; browser-level navigation-resizer test was not run: ${error.message}`);
        return;
      }
      throw error;
    }
    server = await createServer({
      configFile: false,
      cacheDir: path.join(temp, 'vite-cache'),
      root: process.cwd(),
      appType: 'mpa',
      plugins: [stubLayoutChrome()],
      server: {host: '127.0.0.1', port: 0, strictPort: true},
    });
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== 'string');
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error));
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/navigation-resizer-mount.html`);
    await page.evaluate(() => window.__navigationResizeHarness.mount());
    await page.waitForFunction(() => Boolean(window.__navigationResizeHarness && document.querySelector('.layout-navigation-resizer')));
    await page.waitForFunction(() => {
      const workspace = document.querySelector('.layout-workspace');
      const navigation = document.querySelector('.layout-navigation');
      const handle = document.querySelector('.layout-navigation-resizer');
      return handle?.getAttribute('aria-valuenow') === '420'
        && workspace?.style.getPropertyValue('--cmp-layout-user-navigation-width') === '420px'
        && Math.abs((navigation?.getBoundingClientRect().width ?? 0) - 420) < 0.5
        && document.querySelector('#body-editor-probe');
    });
    assert.equal(await page.locator('#body-editor-probe').inputValue(), '正文内容保持不变');
    assert.equal((await page.evaluate(() => window.__navigationResizeHarness.getState())).mounts, 1);
    await page.evaluate(() => { window.__navigationEditorNode = document.querySelector('#body-editor-probe'); });

    const navigationPicker = page.getByRole('combobox', {name: '切换导航内容'});
    await navigationPicker.selectOption('outline-test');
    await page.waitForFunction(() => window.__navigationResizeHarness.getState().shownNavigationId === 'outline-test');
    assert.equal(await page.getByText('大纲面板').isVisible(), true, 'the layout Select routes its chosen entry to store.show');
    assert.equal(await page.evaluate(() => document.querySelector('#body-editor-probe') === window.__navigationEditorNode), true,
      'changing the navigation panel preserves the mounted editor node');

    const handle = page.locator('.layout-navigation-resizer');
    const handleBox = await handle.boundingBox();
    assert.ok(handleBox, 'resizer handle has a browser layout box');
    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 40, startY, {steps: 4});
    await page.waitForFunction(() => document.querySelector('.layout-workspace')?.style
      .getPropertyValue('--cmp-layout-user-navigation-width') === '460px');
    await page.waitForFunction(() => Math.abs(
      (document.querySelector('.layout-navigation')?.getBoundingClientRect().width ?? 0) - 460,
    ) < 0.5);
    assert.deepEqual((await page.evaluate(() => window.__navigationResizeHarness.getState())).writes, [],
      'drag preview changes the rendered width without writing configuration');
    assert.equal(await page.locator('#body-editor-probe').inputValue(), '正文内容保持不变');
    assert.equal(await page.evaluate(() => document.querySelector('#body-editor-probe') === window.__navigationEditorNode), true,
      'resizing does not remount the editor DOM node');

    await page.mouse.up();
    await page.waitForFunction(() => window.__navigationResizeHarness.getState().writes.length === 1);
    assert.deepEqual((await page.evaluate(() => window.__navigationResizeHarness.getState())).writes, [460]);
    assert.equal(await handle.getAttribute('data-dragging'), null, 'pointer release clears dragging state');
    assert.deepEqual(pageErrors.map(error => error.message), []);
  } finally {
    await browser?.close();
    await server?.close();
    if (temp) await rm(temp, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
});
