import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {createServer} from 'vite';

const registry = JSON.parse(await readFile(
  new URL('../src/plugins/theme/color-registry.json', import.meta.url),
  'utf8',
));
const cssVariables = Object.fromEntries(registry.colors.map(role => [role.id, role.cssVariable]));

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

function getRole(roleId) {
  const role = registry.colors.find(entry => entry.id === roleId);
  assert.ok(role, `theme registry does not contain color role ${roleId}`);
  return role;
}

function getPaintRole(paintName, property) {
  const role = registry.paintSets[paintName]?.[property];
  assert.equal(typeof role, 'string', `paintSets.${paintName}.${property} must name a color role`);
  getRole(role);
  return role;
}

function matchesState(rule, state) {
  return Object.entries(rule.when).every(([key, value]) => state[key] === value);
}

function resolvePaintName(intent, state) {
  const rule = registry.stateRules.priority.find(candidate => matchesState(candidate, state));
  assert.ok(rule, `theme registry has no state rule for ${JSON.stringify(state)}`);
  const paintName = rule.paint ?? rule.paints?.[intent];
  assert.ok(paintName, `theme registry has no paint for ${intent} and ${JSON.stringify(state)}`);
  return paintName;
}

function expectedButtonPaint(variant, flags, colors) {
  const intent = variant === 'primary' ? 'action' : variant === 'danger' ? 'danger' : 'neutral';
  const state = {...registry.stateRules.defaults, ...flags};
  const paintName = resolvePaintName(intent, state);
  const paint = registry.paintSets[paintName];

  // The neutral paint set takes its foreground and surface from the component context.
  // Secondary buttons use the control surface; ghost buttons and icon buttons stay transparent.
  let foregroundRole = paint.foreground;
  let backgroundRole = paint.background;
  if (paintName === 'neutral') {
    foregroundRole = variant === 'secondary' ? 'text.primary' : 'text.secondary';
    backgroundRole = variant === 'secondary' ? 'surface.control' : null;
  }

  return {
    foreground: colors[foregroundRole],
    background: backgroundRole ? colors[backgroundRole] : colors.$transparent,
    indicator: paint.indicator ? colors[paint.indicator] : null,
    disabledBorder: paint.border === 'state.disabledBorder' ? colors[paint.border] : null,
    paintName,
  };
}

async function readThemeColors(page) {
  return page.evaluate(variables => {
    const rootStyle = getComputedStyle(document.documentElement);
    const probe = document.createElement('span');
    probe.style.position = 'fixed';
    probe.style.visibility = 'hidden';
    document.body.append(probe);
    const result = {};
    for (const [role, variable] of Object.entries(variables)) {
      const value = rootStyle.getPropertyValue(variable).trim();
      if (!value) throw new Error(`theme variable ${variable} for ${role} is missing`);
      probe.style.color = value;
      result[role] = getComputedStyle(probe).color;
    }
    probe.style.backgroundColor = 'transparent';
    result.$transparent = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return result;
  }, cssVariables);
}

async function readButtonStyle(locator) {
  return locator.evaluate(element => {
    const style = getComputedStyle(element);
    const indicator = getComputedStyle(element, '::after');
    return {
      foreground: style.color,
      background: style.backgroundColor,
      border: style.borderTopColor,
      indicatorContent: indicator.content,
      indicator: indicator.borderTopColor,
      indicatorStyle: indicator.borderTopStyle,
    };
  });
}

async function assertButtonPaint(locator, variant, flags, colors, message) {
  const actual = await readButtonStyle(locator);
  const expected = expectedButtonPaint(variant, flags, colors);
  assert.equal(actual.foreground, expected.foreground, `${message}: foreground (${expected.paintName})`);
  assert.equal(actual.background, expected.background, `${message}: background (${expected.paintName})`);

  if (expected.indicator) {
    assert.notEqual(actual.indicatorContent, 'none', `${message}: selected indicator exists`);
    assert.equal(actual.indicator, expected.indicator, `${message}: selected indicator color`);
  } else {
    assert.equal(actual.indicatorContent, 'none', `${message}: no selected indicator`);
  }
  if (expected.disabledBorder) {
    assert.equal(actual.border, expected.disabledBorder, `${message}: disabled border`);
  }
  if (flags.mixed) {
    assert.equal(actual.indicatorStyle, 'dashed', `${message}: mixed state uses a dashed indicator`);
  }
}

async function readSearchStyle(input) {
  return input.evaluate(element => {
    const field = element.closest('.search-field');
    const fieldStyle = getComputedStyle(field);
    const inputStyle = getComputedStyle(element);
    return {
      foreground: inputStyle.color,
      placeholder: getComputedStyle(element, '::placeholder').color,
      caret: inputStyle.caretColor,
      background: fieldStyle.backgroundColor,
      border: fieldStyle.borderTopColor,
      outline: fieldStyle.outlineColor,
      outlineOffset: fieldStyle.outlineOffset,
      outlineWidth: fieldStyle.outlineWidth,
      selectionForeground: getComputedStyle(element, '::selection').color,
      selectionBackground: getComputedStyle(element, '::selection').backgroundColor,
    };
  });
}

async function assertSearchPaint(input, paintName, colors, message) {
  const paint = registry.paintSets[paintName];
  assert.ok(paint, `theme registry does not contain paint set ${paintName}`);
  const actual = await readSearchStyle(input);
  const roles = paintName === 'neutral'
    ? {
        foreground: 'text.primary',
        background: 'surface.control',
        placeholder: 'text.placeholder',
        caret: getPaintRole('caret', 'foreground'),
      }
    : {
        foreground: getPaintRole(paintName, 'foreground'),
        background: getPaintRole(paintName, 'background'),
        placeholder: getPaintRole(paintName, 'foreground'),
        caret: getPaintRole(paintName, 'foreground'),
      };
  for (const role of Object.values(roles)) getRole(role);
  assert.equal(actual.foreground, colors[roles.foreground], `${message}: foreground`);
  assert.equal(actual.background, colors[roles.background], `${message}: background`);
  assert.equal(actual.placeholder, colors[roles.placeholder], `${message}: placeholder`);
  assert.equal(actual.caret, colors[roles.caret], `${message}: caret`);
}

async function assertButtonStates(page, variant, colors) {
  const button = state => page.getByTestId(`button-${variant}-${state}`);
  const neutral = {selected: false, disabled: false, hovered: false, pressed: false};

  await assertButtonPaint(button('normal'), variant, neutral, colors, `${variant} default`);
  await assertButtonPaint(button('selected'), variant, {selected: true}, colors, `${variant} selected`);
  await assertButtonPaint(button('mixed'), variant, {selected: true, mixed: true}, colors, `${variant} mixed`);
  await assertButtonPaint(button('inactive-selected'), variant,
    {selected: true, selectionActive: false}, colors, `${variant} inactive selected`);
  await assertButtonPaint(button('disabled'), variant, {disabled: true}, colors, `${variant} disabled`);
  await assertButtonPaint(button('disabled-selected'), variant,
    {disabled: true, selected: true}, colors, `${variant} disabled selected`);

  await button('normal').hover();
  await assertButtonPaint(button('normal'), variant, {hovered: true}, colors, `${variant} hover`);
  await page.mouse.down();
  await assertButtonPaint(button('normal'), variant, {hovered: true, pressed: true}, colors, `${variant} pressed`);
  await page.mouse.up();
  await page.mouse.move(0, 0);

  await button('selected').hover();
  await assertButtonPaint(button('selected'), variant, {selected: true, hovered: true}, colors, `${variant} selected hover`);
  await page.mouse.down();
  await assertButtonPaint(button('selected'), variant, {selected: true, hovered: true, pressed: true}, colors,
    `${variant} selected pressed`);
  await page.mouse.up();
  await page.mouse.move(0, 0);

  await button('selected').evaluate(element => element.removeAttribute('aria-pressed'));
  await assertButtonPaint(button('selected'), variant, neutral, colors, `${variant} aria-pressed removal restores intent`);
  await button('selected').evaluate(element => element.setAttribute('aria-pressed', 'true'));
}

async function assertIconButtonStates(page, colors) {
  const ordinary = page.getByRole('button', {name: '普通图标按钮', exact: true});
  const selected = page.getByRole('button', {name: '选中图标按钮', exact: true});
  const inactive = page.getByRole('button', {name: '失焦选中图标按钮', exact: true});
  const disabled = page.getByRole('button', {name: '禁用图标按钮', exact: true});

  await assertButtonPaint(ordinary, 'icon', {}, colors, 'icon button default');
  await assertButtonPaint(selected, 'icon', {selected: true}, colors, 'icon button selected');
  await assertButtonPaint(inactive, 'icon', {selected: true, selectionActive: false}, colors,
    'icon button inactive selected');
  await assertButtonPaint(disabled, 'icon', {disabled: true}, colors, 'icon button disabled');

  await ordinary.hover();
  await assertButtonPaint(ordinary, 'icon', {hovered: true}, colors, 'icon button hover');
  await page.mouse.down();
  await assertButtonPaint(ordinary, 'icon', {hovered: true, pressed: true}, colors, 'icon button pressed');
  await page.mouse.up();
  await page.mouse.move(0, 0);

  await selected.hover();
  await assertButtonPaint(selected, 'icon', {selected: true, hovered: true}, colors, 'icon button selected hover');
  await page.mouse.down();
  await assertButtonPaint(selected, 'icon', {selected: true, hovered: true, pressed: true}, colors,
    'icon button selected pressed');
  await page.mouse.up();
  await page.mouse.move(0, 0);

  await selected.evaluate(element => element.setAttribute('aria-pressed', 'mixed'));
  await assertButtonPaint(selected, 'icon', {selected: true, mixed: true}, colors, 'icon button mixed');
  await selected.evaluate(element => element.setAttribute('aria-pressed', 'true'));

  await disabled.evaluate(element => element.setAttribute('aria-pressed', 'true'));
  await assertButtonPaint(disabled, 'icon', {disabled: true, selected: true}, colors,
    'icon button disabled selected');
  await disabled.evaluate(element => element.removeAttribute('aria-pressed'));

  await selected.evaluate(element => element.removeAttribute('aria-pressed'));
  await assertButtonPaint(selected, 'icon', {}, colors, 'icon button aria-pressed removal restores intent');
  await selected.evaluate(element => element.setAttribute('aria-pressed', 'true'));
}

async function assertSearchFieldStates(page, colors) {
  const editable = page.getByTestId('search-editable');
  const invalid = page.getByTestId('search-invalid');
  const readOnly = page.getByTestId('search-readonly');
  const disabled = page.getByTestId('search-disabled');
  const disabledInvalid = page.getByTestId('search-disabled-invalid');

  const neutral = registry.paintSets.neutral;
  const disabledPaint = registry.paintSets.disabled;
  const selectionPaint = registry.paintSets.selection;
  const validationPaint = registry.paintSets.validationDanger;
  const inputStyle = await readSearchStyle(editable);
  assert.equal(inputStyle.border, colors['border.default'], 'SearchField resting border uses the quiet role');
  assert.equal(inputStyle.foreground, colors['text.primary'], 'SearchField input foreground follows the primary text role');
  assert.equal(inputStyle.background, colors['surface.control'], 'SearchField background follows its neutral control surface');
  assert.equal(inputStyle.placeholder, colors['text.placeholder'], 'SearchField placeholder follows its placeholder role');
  assert.equal(inputStyle.caret, colors[getPaintRole('caret', 'foreground')], 'SearchField caret follows the caret paint set');
  assert.equal(neutral.background.context, 'surface', 'neutral paint exposes its contextual background');
  assert.equal(validationPaint.border, 'status.dangerBorder', 'invalid SearchField uses the registry validation border');
  assert.equal(disabledPaint.border, 'state.disabledBorder', 'disabled SearchField uses the registry disabled border');

  await editable.evaluate(element => element.select());
  const selectedTextStyle = await readSearchStyle(editable);
  assert.equal(selectedTextStyle.selectionForeground, colors[selectionPaint.foreground], 'text selection uses registry foreground');
  assert.equal(selectedTextStyle.selectionBackground, colors[selectionPaint.background], 'text selection uses registry background');

  await editable.hover();
  await assertSearchPaint(editable, 'hover', colors, 'editable SearchField hover');
  assert.equal((await readSearchStyle(editable)).border, colors['border.strong'], 'SearchField hover restores the strong border');
  await page.mouse.down();
  await assertSearchPaint(editable, 'pressed', colors, 'editable SearchField pressed');
  await page.mouse.up();
  await page.mouse.move(0, 0);

  await editable.focus();
  const focusedEditable = await readSearchStyle(editable);
  const focusRole = getPaintRole('focus', 'indicator');
  assert.equal(focusedEditable.border, colors[focusRole], 'focused SearchField emphasizes its existing border');
  assert.equal(focusedEditable.outline, focusedEditable.border, 'focus is one continuous stroke');
  assert.equal(focusedEditable.outlineOffset, `-${focusedEditable.outlineWidth}`, 'focus stroke stays inside the field boundary');

  const invalidFieldStyle = await readSearchStyle(invalid);
  assert.equal(invalidFieldStyle.border, colors[validationPaint.border], 'invalid SearchField shows validation border');
  await invalid.focus();
  const focusedInvalid = await readSearchStyle(invalid);
  assert.equal(focusedInvalid.outline, colors[validationPaint.border], 'focused invalid fields retain their validation color');
  assert.equal(focusedInvalid.border, focusedInvalid.outline, 'invalid focus uses a single continuous boundary');
  assert.equal(focusedInvalid.outlineOffset, `-${focusedInvalid.outlineWidth}`, 'invalid focus also stays inside the boundary');

  await readOnly.hover();
  assert.equal(await readOnly.getAttribute('readonly'), '', 'read-only SearchField keeps native readOnly semantics');
  await assertSearchPaint(readOnly, 'neutral', colors, 'read-only SearchField does not take hover paint');
  await page.mouse.down();
  await assertSearchPaint(readOnly, 'neutral', colors, 'read-only SearchField does not take pressed paint');
  await page.mouse.up();
  await page.mouse.move(0, 0);
  await readOnly.evaluate(element => element.select());
  assert.ok(await readOnly.evaluate(element => element.selectionEnd > element.selectionStart),
    'read-only SearchField text remains selectable');

  const disabledStyle = await readSearchStyle(disabled);
  assert.equal(disabledStyle.foreground, colors[disabledPaint.foreground], 'disabled SearchField uses disabled foreground');
  assert.equal(disabledStyle.background, colors[disabledPaint.background], 'disabled SearchField uses disabled background');
  assert.equal(disabledStyle.border, colors[disabledPaint.border], 'disabled SearchField uses disabled border');
  const disabledInvalidStyle = await readSearchStyle(disabledInvalid);
  assert.equal(disabledInvalidStyle.border, colors[disabledPaint.border], 'disabled state suppresses validation border');
  assert.equal(disabledInvalidStyle.placeholder, colors[disabledPaint.foreground], 'disabled placeholder uses disabled foreground');
}

async function assertNativeFieldStates(page, colors) {
  const styleOf = locator => locator.evaluate(element => {
    const style = getComputedStyle(element);
    return {border: style.borderTopColor, background: style.backgroundColor, foreground: style.color,
      outline: style.outlineColor, width: style.outlineWidth, offset: style.outlineOffset};
  });
  for (const id of ['text-field', 'textarea']) {
    const field = page.getByTestId(`${id}-editable`);
    await field.evaluate(element => element.blur());
    await page.mouse.move(0, 0);
    assert.equal((await styleOf(field)).border, colors['border.default'], `${id}: quiet rest`);
    await field.hover();
    assert.equal((await styleOf(field)).border, colors['border.strong'], `${id}: hover identifies interaction`);
    await field.focus();
    const focused = await styleOf(field);
    assert.equal(focused.border, colors['focus.ring'], `${id}: visible focus`);
    assert.equal(focused.outline, focused.border);
    assert.equal(focused.width, '2px');
    assert.equal(focused.offset, '-2px');
    for (const invalid of ['true', 'grammar', 'spelling']) {
      await field.evaluate((element, value) => element.setAttribute('aria-invalid', value), invalid);
      assert.equal((await styleOf(field)).border, colors['status.dangerBorder'], `${id}: invalid focus ${invalid}`);
      assert.equal((await styleOf(field)).outline, colors['status.dangerBorder']);
    }
    await field.evaluate(element => { element.removeAttribute('aria-invalid'); element.readOnly = true; element.blur(); });
    await field.hover();
    assert.equal((await styleOf(field)).border, colors['border.default'], `${id}: readonly keeps rest paint`);
    await field.focus();
    assert.equal((await styleOf(field)).border, colors['focus.ring'], `${id}: readonly remains focusable`);
    await field.evaluate(element => { element.readOnly = false; element.blur(); });
    const disabled = await styleOf(page.getByTestId(`${id}-disabled`));
    assert.equal(disabled.border, colors['state.disabledBorder'], `${id}: fieldset disabled suppresses validation`);
    assert.equal(disabled.background, colors['state.disabledBackground']);
    assert.equal(disabled.foreground, colors['state.disabledForeground']);
  }
  const select = page.getByTestId('field-select');
  await page.mouse.move(0, 0);
  assert.equal((await styleOf(select)).border, colors['border.default'], 'field Select shares the quiet rest border');
  await select.hover();
  assert.equal((await styleOf(select)).border, colors['border.strong'], 'field Select hover keeps a strong boundary');
  await select.focus();
  assert.equal((await styleOf(select)).border, colors['focus.ring'], 'field Select focus stays clear');
  await select.evaluate(element => element.blur());
  await page.mouse.move(0, 0);
}

async function tabTo(page, locator) {
  await page.getByTestId('theme-select').focus();
  for (let count = 0; count < 50; count += 1) {
    await page.keyboard.press('Tab');
    if (await locator.evaluate(element => element === document.activeElement)) return;
  }
  assert.fail('keyboard navigation did not reach the requested focus target');
}

test('UI components follow registry state paints across themes in a real browser', async t => {
  const playwright = loadPlaywright();
  if (!playwright) {
    t.skip('Playwright is not installed; browser-level UI theme checks were not run.');
    return;
  }

  let browser;
  let server;
  const explicitExecutable = process.env.LODESTORY_CHROME_PATH
    ?? process.env.CHROME_EXECUTABLE_PATH
    ?? process.env.CHROME_PATH;
  try {
    try {
      browser = await playwright.chromium.launch({
        headless: true,
        ...(explicitExecutable ? {executablePath: path.resolve(explicitExecutable)} : {}),
      });
    } catch (error) {
      if (!explicitExecutable && missingChromium(error)) {
        t.skip(`Chromium is not installed; browser-level UI theme checks were not run: ${error.message}`);
        return;
      }
      throw error;
    }

    server = await createServer({
      configFile: false,
      cacheDir: 'node_modules/.vite-ui-theme-test',
      root: process.cwd(),
      appType: 'mpa',
      server: {host: '127.0.0.1', port: 0, strictPort: true, hmr: false},
    });
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== 'string');

    const page = await browser.newPage({viewport: {width: 1600, height: 1400}});
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error));
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/ui-theme.html`);
    await page.waitForSelector('#startup-status[hidden]', {state: 'attached'});
    await page.waitForSelector('[data-testid="fixture-app"][data-mount-count="1"]');

    const themeSelect = page.getByTestId('theme-select');
    const editable = page.getByTestId('search-editable');
    await editable.fill('主题切换时保留的用户输入');
    await editable.evaluate(element => { window.__uiThemeSearchInput = element; });

    const themes = [
      {id: 'lodestory.builtin.dark', type: 'dark'},
      {id: 'lodestory.builtin.light', type: 'light'},
      {id: 'lodestory.fixture.cobalt', type: 'dark'},
      {id: 'lodestory.fixture.ember', type: 'dark'},
    ];
    let cobaltSelectedBackground;
    let emberSelectedBackground;

    for (const theme of themes) {
      if (await themeSelect.inputValue() !== theme.id) await themeSelect.selectOption(theme.id);
      await page.waitForFunction(expectedId => document.querySelector('[data-testid="theme-debug"]')?.dataset.themeId === expectedId,
        theme.id);
      const debug = page.getByTestId('theme-debug');
      assert.equal(await debug.getAttribute('data-theme-type'), theme.type, `${theme.id} reports its theme type`);
      assert.equal(await editable.inputValue(), '主题切换时保留的用户输入', `${theme.id} preserves search input value`);
      assert.equal(await editable.evaluate(element => element === window.__uiThemeSearchInput), true,
        `${theme.id} preserves the SearchField input DOM node`);
      assert.equal(await page.getByTestId('fixture-app').getAttribute('data-mount-count'), '1',
        `${theme.id} does not remount the fixture`);

      const colors = await readThemeColors(page);
      for (const variant of ['primary', 'secondary', 'ghost', 'danger']) {
        await assertButtonStates(page, variant, colors);
      }
      await assertIconButtonStates(page, colors);
      await assertSearchFieldStates(page, colors);
      await assertNativeFieldStates(page, colors);
      for (const testId of ['inverse-ghost-button', 'inverse-icon-button']) {
        const inverseStyle = await readButtonStyle(page.getByTestId(testId));
        assert.equal(inverseStyle.foreground, colors['text.inverse'], `${testId} uses inverse foreground on its transparent surface`);
        assert.equal(inverseStyle.background, colors.$transparent, `${testId} preserves the inverse surface underneath`);
      }

      const selectedButton = page.getByTestId('button-secondary-selected');
      const selectedStyle = await readButtonStyle(selectedButton);
      if (theme.id === 'lodestory.fixture.cobalt') cobaltSelectedBackground = selectedStyle.background;
      if (theme.id === 'lodestory.fixture.ember') emberSelectedBackground = selectedStyle.background;
    }

    assert.notEqual(cobaltSelectedBackground, emberSelectedBackground,
      'same-type custom themes replace selected colors by theme ID');
    assert.equal(await page.getByTestId('theme-debug').getAttribute('data-theme-type'), 'dark',
      'both same-type custom themes remain dark themes');

    const inverseButton = page.getByTestId('inverse-focus-button');
    await tabTo(page, inverseButton);
    const inverseFocus = await inverseButton.evaluate(element => {
      const style = getComputedStyle(element);
      return {color: style.outlineColor, offset: style.outlineOffset};
    });
    const currentColors = await readThemeColors(page);
    const inverseFocusRole = getPaintRole('inverseFocus', 'indicator');
    assert.equal(inverseFocus.color, currentColors[inverseFocusRole], 'inverse focus uses inverseFocus indicator');
    const focusDimensions = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        offset: style.getPropertyValue('--ui-focus-offset').trim(),
        width: style.getPropertyValue('--ui-focus-width').trim(),
      };
    });
    assert.equal(inverseFocus.offset, focusDimensions.offset, 'focus ring offset follows the shared focus token');
    assert.equal(focusDimensions.offset, '1px', 'focus ring uses the specified 1px gap');
    assert.equal(focusDimensions.width, '2px', 'focus ring remains 2px wide');

    const inverseSearch = page.getByTestId('inverse-focus-search');
    await inverseSearch.focus();
    const inverseSearchFocus = await readSearchStyle(inverseSearch);
    assert.equal(inverseSearchFocus.outline, currentColors[getPaintRole('focus', 'indicator')],
      'inset SearchField focus adjoins its own control surface, even on an inverse outer surface');
    assert.equal(inverseSearchFocus.outlineOffset, `-${inverseSearchFocus.outlineWidth}`,
      'SearchField does not add an exterior focus ring');

    await page.emulateMedia({forcedColors: 'active'});
    assert.equal(await page.evaluate(() => matchMedia('(forced-colors: active)').matches), true,
      'forced-colors emulation is active');
    const forcedColors = await page.evaluate(() => {
      const probe = document.createElement('span');
      document.body.append(probe);
      probe.style.outlineColor = 'Highlight';
      const highlight = getComputedStyle(probe).outlineColor;
      probe.style.color = 'ButtonText';
      const buttonText = getComputedStyle(probe).color;
      probe.remove();
      return {highlight, buttonText};
    });
    const selectedForHighContrast = page.getByTestId('button-primary-selected');
    await selectedForHighContrast.focus();
    const highContrastStyle = await selectedForHighContrast.evaluate(element => ({
      border: getComputedStyle(element).borderTopColor,
      indicator: getComputedStyle(element, '::after').borderTopColor,
    }));
    assert.equal(highContrastStyle.border, forcedColors.buttonText, 'forced-colors preserves a visible control border');
    assert.equal(highContrastStyle.indicator, forcedColors.highlight, 'forced-colors preserves selected indicator');

    await page.emulateMedia({forcedColors: 'none', reducedMotion: 'reduce'});
    const reducedMotion = await page.evaluate(() => ({
      active: matchMedia('(prefers-reduced-motion: reduce)').matches,
      durations: [...document.querySelectorAll('.button, .icon-button, .search-field')]
        .flatMap(element => getComputedStyle(element).transitionDuration.split(','))
        .map(duration => Number.parseFloat(duration) || 0),
    }));
    assert.equal(reducedMotion.active, true, 'reduced-motion emulation is active');
    assert.ok(reducedMotion.durations.every(duration => duration === 0),
      'UI components do not animate under reduced motion');

    await page.emulateMedia({forcedColors: 'none', reducedMotion: 'no-preference'});
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/ui-dialog.html`);
    await page.waitForSelector('#startup-status[hidden]', {state: 'attached'});
    await page.waitForSelector('[data-testid="standalone-open"]');
    const sizePicker = page.getByTestId('dialog-size');
    await sizePicker.selectOption('regular');
    await page.getByTestId('standalone-open').click();
    await page.waitForSelector('.ui-dialog');
    const dialogMotion = await page.evaluate(() => {
      const popup = document.querySelector('.ui-dialog');
      const backdrop = document.querySelector('.ui-dialog-backdrop');
      if (!popup || !backdrop) throw new Error('Dialog portal did not mount both popup and backdrop.');
      return {
        popupDuration: getComputedStyle(popup).transitionDuration,
        backdropDuration: getComputedStyle(backdrop).transitionDuration,
        size: popup.getAttribute('data-ui-dialog-size'),
        density: popup.getAttribute('data-ui-density'),
        padding: getComputedStyle(popup).paddingLeft,
        width: Math.round(popup.getBoundingClientRect().width),
        focus: document.activeElement?.dataset?.testid ?? null,
      };
    });
    assert.equal(dialogMotion.popupDuration, '0.22s', 'dialog content uses the 220ms shared entry duration');
    assert.equal(dialogMotion.backdropDuration, '0.16s', 'backdrop uses the 160ms shared entry duration');
    assert.equal(dialogMotion.size, 'regular', 'Dialog defaults to the semantic regular preset');
    assert.equal(dialogMotion.density, 'comfortable', 'a Dialog without a density trigger context uses the comfortable default');
    assert.equal(dialogMotion.padding, '24px', 'comfortable density uses the shared 24px dialog padding');
    assert.equal(dialogMotion.width, 560, 'regular Dialog width resolves to 560px at a 16px root size');
    assert.equal(dialogMotion.focus, 'standalone-name', 'initial focus reaches the field without waiting for motion');

    for (const [size, width] of [['narrow', 480], ['wide', 640], ['large', 800]]) {
      await sizePicker.selectOption(size);
      const actualWidth = await page.locator('.ui-dialog').evaluate(element => Math.round(element.getBoundingClientRect().width));
      assert.equal(actualWidth, width, `${size} Dialog preset resolves to ${width}px`);
    }

    await page.keyboard.press('Escape');
    const dialogExit = await page.evaluate(() => {
      const popup = document.querySelector('.ui-dialog');
      const backdrop = document.querySelector('.ui-dialog-backdrop');
      if (!popup || !backdrop) return null;
      return {
        popupEnding: popup.hasAttribute('data-ending-style'),
        popupInert: popup.inert,
        backdropEnding: backdrop.hasAttribute('data-ending-style'),
        popupDuration: getComputedStyle(popup).transitionDuration,
        backdropDuration: getComputedStyle(backdrop).transitionDuration,
      };
    });
    assert.deepEqual(dialogExit, {
      popupEnding: true,
      popupInert: true,
      backdropEnding: true,
      popupDuration: '0.16s',
      backdropDuration: '0.1s',
    }, 'Dialog and backdrop begin their independently timed exits together');
    await page.waitForFunction(() => !document.querySelector('.ui-dialog'), null, {timeout: 1000});
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid ?? null), 'standalone-open',
      'Base UI returns focus to the explicit final target by the time the Dialog exit completes');

    await page.getByTestId('open-project').click();
    await page.waitForSelector('.ui-dialog');
    await page.waitForFunction(() => document.querySelector('.ui-dialog')?.getAttribute('data-ui-density') === 'spacious');
    const welcomeDensity = await page.locator('.ui-dialog').evaluate(element => ({
      density: element.getAttribute('data-ui-density'),
      padding: getComputedStyle(element).paddingLeft,
    }));
    assert.deepEqual(welcomeDensity, {density: 'spacious', padding: '32px'},
      'a NewProjectDialog opened from the spacious welcome context carries that density through its Portal');
    await page.locator('.ui-dialog').evaluate(element => Promise.allSettled(element.getAnimations().map(animation => animation.finished)));
    await page.keyboard.press('Escape');
    const businessExit = await page.locator('.ui-dialog').evaluate(element => ({
      ending: element.hasAttribute('data-ending-style'),
      inert: element.inert,
    }));
    assert.deepEqual(businessExit, {ending: true, inert: true},
      'a controlled business Dialog stays mounted for its exit while becoming inert immediately');
    await page.waitForFunction(() => !document.querySelector('.ui-dialog'), null, {timeout: 1000});
    assert.equal(await page.getByTestId('open-project').evaluate(element => element === document.activeElement), true,
      'Base UI restores focus to the business trigger when the exit finishes');

    await page.getByTestId('open-project').click();
    await page.waitForSelector('.ui-dialog');
    await page.locator('.ui-dialog').evaluate(element => Promise.allSettled(element.getAnimations().map(animation => animation.finished)));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
      const popup = document.querySelector('.ui-dialog');
      return popup?.hasAttribute('data-ending-style')
        && popup.getAnimations().some(animation => animation.playState === 'running' && animation.currentTime > 0);
    });
    const reducedDuringExit = await page.evaluate(() => {
      document.documentElement.dataset.uiMotion = 'reduce';
      return {
        popupTransition: getComputedStyle(document.querySelector('.ui-dialog')).transitionProperty,
        backdropTransition: getComputedStyle(document.querySelector('.ui-dialog-backdrop')).transitionProperty,
      };
    });
    assert.deepEqual(reducedDuringExit, {popupTransition: 'none', backdropTransition: 'none'},
      'switching to reduced motion cancels an active Dialog exit transition');
    await page.waitForFunction(() => !document.querySelector('.ui-dialog') && !document.querySelector('.ui-dialog-backdrop'),
      null, {timeout: 300});
    assert.equal(await page.getByTestId('open-project').evaluate(element => element === document.activeElement), true,
      'Base UI completes Dialog cleanup and restores focus after the transition is cancelled');
    await page.evaluate(() => { delete document.documentElement.dataset.uiMotion; });

    await page.getByTestId('open-project').click();
    await page.waitForSelector('.ui-dialog');
    const initialOpenTransitions = await page.evaluate(() => {
      const popup = document.querySelector('.ui-dialog');
      if (!popup) return [];
      return popup.getAnimations().map(animation => ({
        property: animation.transitionProperty,
        duration: animation.effect?.getTiming().duration,
      }));
    });
    assert.ok(initialOpenTransitions.some(animation => animation.property === 'opacity' && animation.duration === 220),
      'a conditionally mounted open Dialog animates on its first frame');
    assert.ok(initialOpenTransitions.some(animation => animation.property === 'translate' && animation.duration === 220),
      'the initial Dialog entrance uses the offset transition without replacing centering');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.ui-dialog'), null, {timeout: 1000});

    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/ui-select.html`);
    await page.waitForSelector('#startup-status[hidden]', {state: 'attached'});
    const ordinarySelect = page.getByRole('combobox', {name: '普通选择', exact: true});
    await ordinarySelect.click();
    await page.waitForTimeout(180);
    const selectEntry = await page.locator('.ui-select-popup').evaluate(element => ({
      side: element.getAttribute('data-side'),
      duration: getComputedStyle(element).transitionDuration,
      anchor: element.getBoundingClientRect().y,
      triggerBottom: document.querySelector('.ui-select-trigger[aria-label="普通选择"]')?.getBoundingClientRect().bottom,
    }));
    assert.equal(selectEntry.side, 'bottom', 'Select uses the actual collision-resolved side');
    assert.equal(selectEntry.duration, '0.16s', 'Select enters with the shared 160ms duration');
    assert.ok(selectEntry.triggerBottom != null && selectEntry.anchor >= selectEntry.triggerBottom + 3,
      'bottom placement stays anchored at the configured trigger gap');
    await page.keyboard.press('Escape');
    const selectExit = await page.locator('.ui-select-popup').evaluate(element => ({
      ending: element.hasAttribute('data-ending-style'),
      duration: getComputedStyle(element).transitionDuration,
    }));
    assert.deepEqual(selectExit, {ending: true, duration: '0.1s'}, 'Select begins its 100ms exit without an application timer');
    await page.waitForFunction(() => {
      const popup = document.querySelector('.ui-select-popup');
      return !popup || (popup.closest('.ui-select-positioner')?.hidden && !popup.hasAttribute('data-ending-style'));
    }, null, {timeout: 1000});
    assert.equal(await ordinarySelect.evaluate(element => element === document.activeElement), true,
      'Select closes its retained hidden list and restores trigger focus');

    await page.evaluate(() => { document.documentElement.dataset.uiMotion = 'reduce'; });
    await ordinarySelect.click();
    const reducedSelect = await page.locator('.ui-select-popup').evaluate(element => ({
      duration: getComputedStyle(element).transitionDuration,
      offset: getComputedStyle(document.documentElement).getPropertyValue('--ui-motion-offset').trim(),
    }));
    assert.ok(reducedSelect.duration.split(',').every(value => Number.parseFloat(value) === 0),
      'the root reduced-motion preference removes Select transition time');
    assert.equal(reducedSelect.offset, '0px', 'the root reduced-motion preference removes popup travel');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
      const popup = document.querySelector('.ui-select-popup');
      return !popup || (popup.closest('.ui-select-positioner')?.hidden && !popup.hasAttribute('data-ending-style'));
    }, null, {timeout: 300});
    assert.deepEqual(pageErrors.map(error => error.message), []);
  } finally {
    await browser?.close();
    await server?.close();
  }
});
