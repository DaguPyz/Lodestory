import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {createServer} from 'vite';

test('page motion preserves editing state, coordinates menus and supports reduced motion', async t => {
  const require = createRequire(import.meta.url);
  let playwright;
  try {
    playwright = require(require.resolve('playwright', {paths: [process.cwd(), path.resolve(path.dirname(process.execPath), '../node_modules')]}));
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    t.skip('Playwright is not installed in this runtime.'); return;
  }
  const browser = await playwright.chromium.launch({headless: true,
    ...(process.env.LODESTORY_CHROME_PATH ? {executablePath: process.env.LODESTORY_CHROME_PATH} : {})});
  const server = await createServer({
    cacheDir: 'node_modules/.vite-page-motion-test',
    resolve: {dedupe: ['react', 'react-dom']},
    // Prebundle this fixture's React graph before lazy editors load. A later
    // optimizer generation must not mix with the renderer already on the page.
    optimizeDeps: {
      entries: ['tests/fixtures/project-index.html'],
      include: ['react', 'react-dom/client', 'quill', '@base-ui/react/scroll-area',
        '@base-ui/react/dialog', '@base-ui/react/menu', '@base-ui/react/select', '@base-ui/react/context-menu'],
    },
    server: {host: '127.0.0.1', port: 0, strictPort: false, hmr: false},
    logLevel: 'error',
  });
  await server.listen();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({viewport: {width: 1440, height: 900}, reducedMotion: 'no-preference'});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const screenshotRoot = process.env.LODESTORY_UI_SCREENSHOTS;
  async function capture(name) {
    if (!screenshotRoot) return;
    await mkdir(screenshotRoot, {recursive: true});
    await page.evaluate(() => Promise.allSettled(document.getAnimations()
      .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished)));
    await page.screenshot({path: path.join(screenshotRoot, `${name}.png`)});
  }
  async function noHorizontalOverflow() {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      'the page must fit the viewport');
  }
  async function assertSelectedPress(locator, name) {
    await locator.hover();
    await page.mouse.down();
    try {
      const paint = await locator.evaluate(element => {
        const style = getComputedStyle(element);
        const probe = document.createElement('span');
        probe.style.color = 'var(--ui-state-selected-pressed-foreground)';
        probe.style.backgroundColor = 'var(--ui-state-selected-pressed-background)';
        element.append(probe);
        const expected = getComputedStyle(probe);
        const result = {foreground: style.color, background: style.backgroundColor,
          expectedForeground: expected.color, expectedBackground: expected.backgroundColor};
        probe.remove();
        return result;
      });
      assert.equal(paint.foreground, paint.expectedForeground, `${name}: selected press foreground`);
      assert.equal(paint.background, paint.expectedBackground, `${name}: selected press background`);
    } finally { await page.mouse.up(); }
  }
  async function assertForcedSelection(locator, name) {
    await page.emulateMedia({forcedColors: 'active'});
    await locator.hover();
    await page.mouse.down();
    try {
      const paint = await locator.evaluate(element => {
        const probe = document.createElement('span');
        probe.style.color = 'HighlightText';
        probe.style.backgroundColor = 'Highlight';
        element.append(probe);
        const actual = getComputedStyle(element), expected = getComputedStyle(probe);
        const result = {color: actual.color, background: actual.backgroundColor,
          expectedColor: expected.color, expectedBackground: expected.backgroundColor};
        probe.remove();
        return result;
      });
      assert.equal(paint.color, paint.expectedColor, `${name}: forced selection text survives pressing`);
      assert.equal(paint.background, paint.expectedBackground, `${name}: forced selection surface survives pressing`);
    } finally {
      await page.mouse.up();
      await page.emulateMedia({forcedColors: 'none'});
    }
  }
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/project-index.html`);
  await page.getByRole('button', {name: '开始新创作', exact: true}).waitFor();
  await assertSelectedPress(page.locator('.navigation-item[aria-current="page"]:not(:disabled)'), 'welcome navigation');
  await assertForcedSelection(page.locator('.navigation-item[aria-current="page"]:not(:disabled)'), 'welcome navigation');
  await capture('welcome-dark');
  await page.getByRole('button', {name: '设置', exact: true}).click();
  await capture('settings-dark');
  await page.locator('input[value="lodestory.builtin.light"]').check();
  await page.getByRole('dialog', {name: '设置', exact: true}).getByRole('button', {name: '关闭', exact: true}).click();
  await capture('welcome-light');
  await page.setViewportSize({width: 720, height: 640});
  await noHorizontalOverflow();
  const currentNavigation = page.locator('.navigation-item[aria-current="page"]:not(:disabled)');
  await page.keyboard.press('Tab');
  await currentNavigation.focus();
  const compactSelection = await currentNavigation.evaluate(element => ({
    hasMarker: !!element.querySelector('.navigation-item-state'),
    paddingStart: getComputedStyle(element).paddingInlineStart,
    paddingEnd: getComputedStyle(element).paddingInlineEnd,
    selectionBorder: getComputedStyle(element, '::after').borderTopWidth,
    focusWidth: getComputedStyle(element).outlineWidth,
    focusOffset: getComputedStyle(element).outlineOffset,
  }));
  assert.equal(compactSelection.hasMarker, false, 'selected navigation has no check marker');
  assert.equal(compactSelection.paddingStart, compactSelection.paddingEnd, 'navigation has no empty marker slot');
  assert.equal(compactSelection.selectionBorder, '0px', 'selection has no colored frame');
  assert.equal(compactSelection.focusWidth, '2px', 'keyboard focus remains visible');
  assert.equal(compactSelection.focusOffset, '1px');
  await capture('welcome-light-narrow');
  await page.setViewportSize({width: 1440, height: 900});
  await page.getByRole('button', {name: '设置', exact: true}).click();
  await page.locator('input[value="lodestory.builtin.dark"]').check();
  await page.getByRole('dialog', {name: '设置', exact: true}).getByRole('button', {name: '关闭', exact: true}).click();

  await page.getByRole('button', {name: '测试故事的更多操作', exact: true}).click();
  const menu = page.locator('.project-menu');
  await menu.waitFor();
  assert.equal(await menu.evaluate(e => getComputedStyle(e).getPropertyValue('--ui-menu-row-height').trim()), '2.5rem',
    'welcome menu retains spacious density across its portal');
  await page.keyboard.press('Escape');
  await menu.waitFor({state: 'detached'});
  assert.equal(await page.getByRole('button', {name: '测试故事的更多操作', exact: true}).evaluate(e => e === document.activeElement), true);

  await page.getByRole('button', {name: '开始新创作', exact: true}).click();
  await page.getByRole('dialog', {name: '新建项目', exact: true}).waitFor();
  await page.getByLabel('小说名称').fill('暂存名称');
  await capture('new-project-dialog');
  await page.getByRole('button', {name: '取消', exact: true}).click();
  await page.locator('.ui-dialog').waitFor({state: 'detached'});
  await page.getByRole('button', {name: '开始新创作', exact: true}).click();
  assert.equal(await page.getByLabel('小说名称').inputValue(), '', 'reopening resets the dismissed draft');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({state: 'detached'});

  await page.getByRole('button', {name: '打开项目 测试故事', exact: true}).click();
  await page.getByRole('toolbar', {name: '工作台工具栏'}).waitFor();
  await page.getByRole('button', {name: '故事大纲.txt', exact: true}).click();
  const editor = page.locator('.ql-editor');
  await editor.waitFor();
  await assertSelectedPress(page.locator('.file-tree-entry[aria-current="page"]'), 'current project file');
  await assertSelectedPress(page.locator('.document-tab-select[aria-current="page"]'), 'current document tab');
  await assertForcedSelection(page.locator('.file-tree-entry[aria-current="page"]'), 'current project file');
  await assertForcedSelection(page.locator('.document-tab-select[aria-current="page"]'), 'current document tab');
  const longFolder = await page.locator('.file-tree-folder-toggle .file-tree-label').first().evaluate(element => {
    const previous = element.textContent;
    element.textContent = '很长的中文目录名称'.repeat(20);
    const style = getComputedStyle(element);
    const result = {whiteSpace: style.whiteSpace, overflow: style.overflow, textOverflow: style.textOverflow,
      clipped: element.scrollWidth > element.clientWidth,
      fits: element.getBoundingClientRect().width <= element.closest('button').getBoundingClientRect().width};
    element.textContent = previous;
    return result;
  });
  assert.deepEqual(longFolder, {whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', clipped: true, fits: true},
    'long folder names remain a clipped single line in the tree');
  await editor.fill('故事的大纲。视觉更新验收');
  const editorHandle = await editor.elementHandle();
  await page.evaluate(() => {
    window.__toolbarTransitionEvents = [];
    document.addEventListener('transitionrun', event => {
      if (event.target instanceof HTMLElement && event.target.matches('.toolbar-menu-popup')) {
        window.__toolbarTransitionEvents.push(event.propertyName);
      }
    });
  });
  await page.getByRole('button', {name: '布局内容', exact: true}).click();
  await page.waitForFunction(() => window.__toolbarTransitionEvents.includes('opacity'), null, {timeout: 1000});
  assert.equal(await page.locator('.toolbar-menu-popup').evaluate(element => getComputedStyle(element).transitionProperty), 'opacity',
    'toolbar menus fade in without moving their final position');
  await capture('toolbar-menu-dark');
  await page.keyboard.press('Escape');
  await page.locator('.toolbar-menu-popup').waitFor({state: 'detached'});
  await page.getByRole('button', {name: '设置', exact: true}).click();
  await page.locator('input[value="lodestory.builtin.light"]').check();
  await page.getByRole('button', {name: '动效', exact: true}).click();
  await page.getByRole('combobox', {name: '动效偏好'}).click();
  await page.getByRole('option', {name: '减少动效', exact: true}).click();
  await page.waitForFunction(() => document.documentElement.dataset.uiMotion === 'reduce');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-duration-normal').trim()), '0ms');
  await capture('settings-light');
  for (const [width, height] of [[1280, 800], [960, 640], [480, 320]]) {
    await page.setViewportSize({width, height});
    await noHorizontalOverflow();
  }
  await page.setViewportSize({width: 1440, height: 900});
  await page.getByRole('dialog', {name: '设置', exact: true}).getByRole('button', {name: '关闭', exact: true}).click();
  assert.equal(await editorHandle.evaluate(e => e.isConnected && e === document.querySelector('.ql-editor')), true,
    'settings and theme changes preserve the same editor instance');
  assert.match(await editor.innerText(), /视觉更新验收/);
  await capture('workbench-light');

  await page.getByRole('button', {name: '布局内容', exact: true}).click();
  await page.getByRole('menu', {name: '布局内容'}).waitFor();
  await page.getByRole('menuitem', {name: '隐藏工程文件', exact: true}).click();
  assert.equal(await page.getByRole('menu', {name: '布局内容'}).isVisible(), true,
    'content toggles keep their menu open');
  await page.getByRole('menuitem', {name: '显示工程文件', exact: true}).click();
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({state: 'detached'});
  assert.equal(await editorHandle.evaluate(e => e.isConnected), true, 'panel toggles do not remount the editor');

  await page.getByRole('toolbar', {name: '工作台工具栏'}).getByRole('button', {name: '测试故事', exact: true}).click();
  await page.getByRole('menuitem', {name: '设置', exact: true}).click();
  await page.getByRole('button', {name: '动效', exact: true}).click();
  await page.getByRole('combobox', {name: '动效偏好'}).click();
  await page.getByRole('option', {name: '跟随系统', exact: true}).click();
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ui-motion'));
  await page.emulateMedia({reducedMotion: 'reduce'});
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-duration-normal').trim()), '0ms',
    'system reduced motion also wins when the application follows the system');
  await page.getByRole('dialog', {name: '设置', exact: true}).getByRole('button', {name: '关闭', exact: true}).click();
  await page.getByRole('button', {name: '布局内容', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('.toolbar-menu-popup')?.contains(document.activeElement));
  await page.keyboard.press('Escape');
  await page.locator('.toolbar-menu-popup').waitFor({state: 'detached'});

  await page.emulateMedia({reducedMotion: 'no-preference'});
  await page.setViewportSize({width: 720, height: 640});
  const navigation = page.locator('.layout-navigation');
  await page.waitForFunction(() => document.querySelector('.layout-navigation')?.dataset.overlay === 'true');
  await navigation.getByRole('button', {name: '收起工程文件', exact: true}).click();
  await navigation.waitFor({state: 'hidden'});
  const filesToggle = page.getByRole('navigation', {name: '工作空间工具'}).getByRole('button', {name: '工程文件', exact: true});
  await filesToggle.click();
  await page.waitForFunction(() => document.querySelector('.layout-navigation')?.dataset.open === 'true');
  assert.equal(await navigation.evaluate(e => getComputedStyle(e).transitionDuration), '0.15s');
  await navigation.evaluate(e => Promise.allSettled(e.getAnimations().map(animation => animation.finished)));
  await navigation.getByRole('button', {name: '收起工程文件', exact: true}).click();
  const closingPanel = await navigation.evaluate(e => ({inert: e.inert, phase: e.dataset.panelPhase, duration: getComputedStyle(e).transitionDuration}));
  assert.deepEqual(closingPanel, {inert: true, phase: 'exiting', duration: '0.15s'},
    'floating panels stop interaction immediately while retaining the exit presentation');
  await filesToggle.click();
  await page.waitForFunction(() => document.querySelector('.layout-navigation')?.dataset.open === 'true');
  assert.equal(await navigation.evaluate(e => !e.hidden && !e.inert), true, 'rapid reversal keeps the latest open state');
  assert.equal(await editorHandle.evaluate(e => e.isConnected), true);
  await navigation.getByRole('button', {name: '收起工程文件', exact: true}).click();
  await navigation.waitFor({state: 'hidden'});

  await page.locator('.document-tab-select').click({button: 'right'});
  await page.locator('.context-menu-popup').waitFor();
  await page.waitForFunction(() => {
    const popup = document.querySelector('.context-menu-popup:not([data-ending-style])');
    return popup && getComputedStyle(popup).transitionProperty === 'opacity';
  });
  assert.equal(await page.locator('.context-menu-popup').evaluate(e => getComputedStyle(e).transitionProperty), 'opacity');
  await page.locator('.document-tabs').click({button: 'right', position: {x: 500, y: 12}});
  assert.equal(await page.locator('.context-menu-popup:visible').count(), 1, 'switching right-click regions leaves one visible menu');
  await page.keyboard.press('Escape');
  await page.locator('.context-menu-popup').waitFor({state: 'detached'});
  assert.deepEqual(errors, [], 'the full-page interaction produces no uncaught browser errors');
});
