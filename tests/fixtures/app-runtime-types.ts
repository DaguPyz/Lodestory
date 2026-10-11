import { createAppRuntime } from "../../src/app/createAppRuntime";
import { createServiceKey } from "../../src/plugin-core/ServiceKey";
import type { Plugin } from "../../src/plugin-core/Plugin";

type Reader = { read(): number };
const readerKey = createServiceKey<Reader>("example/reader");
const readerPlugin: Plugin = {
  id: "reader",
  requires: [],
  provides: [readerKey],
  activate(context) {
    context.provide(readerKey, { read: () => 42 });
  },
};

async function checkRuntimeTypes() {
  const runtime = await createAppRuntime([readerPlugin]);
  const reader = runtime.get(readerKey);
  const value: number = reader.read();
  // @ts-expect-error The value returned by this key is a number.
  const wrongValue: string = reader.read();
  await runtime.stop();
  return [value, wrongValue];
}

void checkRuntimeTypes;
