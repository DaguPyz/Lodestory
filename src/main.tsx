import {createAppRuntime} from "./app/createAppRuntime";
import {createAppPlugins} from "./app/appPlugins";
import {showUiStartupError} from "./plugins/ui";

const container = document.getElementById("root")!;

async function start() {
    try {
        await createAppRuntime(createAppPlugins(container));
    } catch (error) {
        // The core has already rolled back plugins when startup fails.
        showUiStartupError(container, error);
    }
}

void start();
