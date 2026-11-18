/** Exercise the built-in language provider with the real config store and controlled persistence. */
export function createI18nFixture(load, options = {}) {
  const {createConfigStore} = load("plugins/config/configStore.ts");
  const {createI18nPlugin} = load("plugins/i18n/i18nPlugin.ts");
  const {service: config} = createConfigStore({baseValues: {}, userValues: {}, persist() {}, ...options});
  const plugin = createI18nPlugin();
  let i18n;
  plugin.activate({get: () => config, provide(_key, service) { i18n = service; }});
  return {i18n, stop: () => plugin.deactivate()};
}
