import {createAppPlugins} from "./app/appPlugins";
import {startApplication} from "./app/startApplication";
import {showUiShutdownError, showUiStartupError} from "./plugins/ui";

async function start() {
    try {
        await startApplication(createAppPlugins(), showUiShutdownError);
    } catch (error) {
        // The core has already rolled back plugins when startup fails.
        showUiStartupError(error);
    }
}

void start();
