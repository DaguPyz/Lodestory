import { EngineCore, createServiceKey, type Plugin } from "../../src/plugin-core";

const documentKey = createServiceKey<{ read(): string }>("document");
const configKey = createServiceKey<{ fontSize: number }>("config");
const editorKey = createServiceKey<{ open(): string }>("editor");

export const editorPlugin: Plugin = {
  id: "editor",
  requires: [documentKey, configKey],
  provides: [editorKey],
  activate(context) {
    const document = context.get(documentKey);
    const config = context.get(configKey);
    const content: string = document.read();
    const fontSize: number = config.fontSize;
    context.provide(editorKey, { open: () => `${fontSize}: ${content}` });

    // @ts-expect-error 能力查询保留具体接口类型。
    const invalid: number = document.read();
    void invalid;
    // @ts-expect-error 提供的实现必须符合能力契约。
    context.provide(editorKey, { open: () => 42 });
  },
};

// @ts-expect-error requires 是必填声明。
export const missingRequires: Plugin = { id: "missing-requires", provides: [], activate() {} };
// @ts-expect-error provides 是必填声明。
export const missingProvides: Plugin = { id: "missing-provides", requires: [], activate() {} };

export function mountReadonlyBatch(core: EngineCore): Promise<void> {
  const plugins = [editorPlugin] as const;
  return core.mountAll(plugins);
}
