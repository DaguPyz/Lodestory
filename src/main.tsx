import {createAppRuntime} from "./app/createAppRuntime";
import {createAppPlugins} from "./app/appPlugins";
import {showUiStartupError} from "./plugins/ui";

async function start() {
    try {
        await createAppRuntime(createAppPlugins());
    } catch (error) {
        // The core has already rolled back plugins when startup fails.
        showUiStartupError(error);
    }
}

void start();
