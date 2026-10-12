import { EngineCore } from "../../src/plugin-core";
import { createServiceKey, createEventKey, type Plugin } from "@lodestory/sdk";

const documentKey = createServiceKey<{ read(): string }>("document");
const configKey = createServiceKey<{ fontSize: number }>("config");
const editorKey = createServiceKey<{ open(): string }>("editor");
const documentSaved = createEventKey<{ documentId: string }>("document/saved");

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
    const unsubscribe: () => void = context.on(documentSaved, ({ documentId }) => {
      const id: string = documentId;
      void id;
      // @ts-expect-error 事件监听保留 payload 的具体类型。
      const invalidId: number = documentId;
      void invalidId;
    });
    unsubscribe();
    const notification: Promise<void> = context.emit(documentSaved, { documentId: "doc-01" });
    void notification;
    // @ts-expect-error 发布的数据必须符合事件契约。
    void context.emit(documentSaved, { documentId: 42 });
    // @ts-expect-error 不允许监听不兼容的数据类型。
    context.on(documentSaved, (_payload: number) => {});

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
