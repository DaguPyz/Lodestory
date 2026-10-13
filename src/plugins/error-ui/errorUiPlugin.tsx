import type {Plugin} from "@lodestory/sdk";
import {errorUiKey, type ErrorUiService} from "@lodestory/sdk/error";
import {ErrorBoundary} from "./ErrorBoundary";
import {ErrorView} from "./ErrorView";

const errorUiService: ErrorUiService = Object.freeze({ErrorBoundary, ErrorView});

/** Provides stable page-level error boundary and view components without depending on UI. */
export function createErrorUiPlugin(): Plugin {
    return {
        id: "error-ui",
        requires: [],
        provides: [errorUiKey],

        activate(context) {
            context.provide(errorUiKey, errorUiService);
        },
    };
}
