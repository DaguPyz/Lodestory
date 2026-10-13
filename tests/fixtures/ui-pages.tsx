import {useState} from "react";
import {EngineCore} from "../../src/plugin-core";
import type {Plugin} from "@lodestory/sdk";
import {createUiPlugin} from "../../src/plugins/ui";
import {uiKey, type UiService} from "@lodestory/sdk/ui";
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

const core = new EngineCore();
await core.start([createErrorUiPlugin(), createUiPlugin(container, {initialPage: "home"}), pagesPlugin]);

declare global {
    interface Window {
        uiPagesTest: {core: EngineCore; ui: UiService};
    }
}

window.uiPagesTest = {core, ui: getUi()};
