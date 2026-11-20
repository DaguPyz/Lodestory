import type {Translate} from "@lodestory/sdk/i18n";

export const sourceText: Translate = (source, options) => {
  const values = options?.values;
  if (!values) return source;
  return source.replace(/\{([A-Za-z][\w]*)\}/g, (token, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : token);
};
