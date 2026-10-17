import {useState} from "react";
import {EngineCore} from "../../src/plugin-core";
import type {Plugin} from "@lodestory/sdk";
import {createUiPlugin} from "../../src/plugins/ui";
import {uiKey, type UiService} from "@lodestory/sdk/ui";
import {configKey, type ConfigItem, type ConfigService, type ConfigValue, type ReadonlyConfig} from "@lodestory/sdk/config";
import {createErrorUiPlugin} from "../../src/plugins/error-ui";
import {errorUiKey} from "@lodestory/sdk/error";

let ui: UiService | undefined;

function getUi(): UiService {
    if (!ui) throw new Error("The UI page plugin has not activated yet.");
    return ui;
}

function HomePage() {
    return <main data-page="home">
        <h1>UI pages test</h1>
        <button type="button" id="open-project" onClick={() => getUi().openPage("project", {project: "Alpha"})}>
            Open project Alpha
        </button>
    </main>;
}

function ProjectPage({project, active}: {project: string; active: boolean}) {
    const [draft, setDraft] = useState("initial draft");
    return <main data-page="project" data-active={String(active)}>
        <h1>Project: {project}</h1>
        <label htmlFor="project-draft">Draft</label>
        <input
            id="project-draft"
            aria-label="Draft"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <output id="draft-value">{draft}</output>
        <button type="button" id="open-preview" onClick={() => getUi().openPage("preview", {source: "project"})}>
            Open preview
        </button>
    </main>;
}

function PreviewPage({active}: {active: boolean}) {
    return <main data-page="preview" data-active={String(active)}>
        <h1>Preview page</h1>
        <button type="button" id="back-to-project" onClick={() => getUi().back()}>
            Back
        </button>
    </main>;
}

const pagesPlugin: Plugin = {
    id: "ui-pages-test",
    requires: [uiKey, errorUiKey],
    provides: [],
    activate(context) {
        ui = context.get(uiKey);
        const {ErrorBoundary} = context.get(errorUiKey);
        ui.registerPage({id: "home", render: () => <ErrorBoundary><HomePage/></ErrorBoundary>});
        ui.registerPage({
            id: "project",
            render: ({params, active}) => {
                const project = (params as {project?: string} | undefined)?.project ?? "(unknown)";
                return <ErrorBoundary><ProjectPage project={project} active={active}/></ErrorBoundary>;
            },
        });
        ui.registerPage({
            id: "preview",
            render: ({active}) => <ErrorBoundary><PreviewPage active={active}/></ErrorBoundary>,
        });
    },
};

const container = document.getElementById("app-root");
if (!container) throw new Error("UI pages fixture root element was not found.");

const configItems = new Map<string, ConfigItem<ConfigValue>>();
const configValues = new Map<string, ConfigValue>();
const configListeners = new Map<string, Set<() => void>>();
const configService: ConfigService = {
    register<T extends ConfigValue>(item: ConfigItem<T>) {
        if (configItems.has(item.id)) throw new Error(`Configuration '${item.id}' is already registered.`);
        configItems.set(item.id, item as ConfigItem<ConfigValue>);
        return () => { if (configItems.get(item.id) === item) configItems.delete(item.id); };
    },
    getSnapshot<T extends ConfigValue>(item: ConfigItem<T>) {
        return (configValues.has(item.id) ? configValues.get(item.id) : item.defaultValue) as ReadonlyConfig<T>;
    },
    async set<T extends ConfigValue>(item: ConfigItem<T>, value: T) {
        if (!item.validate(value)) throw new TypeError(`Configuration '${item.id}' is invalid.`);
        configValues.set(item.id, value);
        for (const listener of [...(configListeners.get(item.id) ?? [])]) listener();
    },
    async reset<T extends ConfigValue>(item: ConfigItem<T>) {
        configValues.delete(item.id);
        for (const listener of [...(configListeners.get(item.id) ?? [])]) listener();
    },
    subscribe<T extends ConfigValue>(item: ConfigItem<T>, listener: () => void) {
        let listeners = configListeners.get(item.id);
        if (!listeners) configListeners.set(item.id, listeners = new Set());
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
};
const configPlugin: Plugin = {
    id: "ui-pages-test-config",
    requires: [],
    provides: [configKey],
    activate(context) { context.provide(configKey, configService); },
};

const core = new EngineCore();
await core.start([configPlugin, createErrorUiPlugin(), createUiPlugin(container), pagesPlugin]);

declare global {
    interface Window {
        uiPagesTest: {core: EngineCore; ui: UiService};
    }
}

window.uiPagesTest = {core, ui: getUi()};
