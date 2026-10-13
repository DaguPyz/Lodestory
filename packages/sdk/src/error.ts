import type { ComponentType, ReactNode } from "react";
import { createServiceKey } from "./ServiceKey.js";

/** Local page-level failure view boundary exposed by the error UI plugin. */
export type ErrorUiService = {
  /** Stable boundary component; page plugins can wrap their own page subtree. */
  readonly ErrorBoundary: ComponentType<{ readonly children?: ReactNode }>;
  /** Stable view rendered when ErrorBoundary catches an error. */
  readonly ErrorView: ComponentType;
};

/** Shared capability provided by the error UI plugin and consumed by UI/page plugins. */
export const errorUiKey = createServiceKey<ErrorUiService>("app/error-ui");
