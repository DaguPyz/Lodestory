import {convertFileSrc, isTauri} from "@tauri-apps/api/core";
import {createElement, type ComponentType, type ReactNode} from "react";
import {flushSync} from "react-dom";
import type {Plugin, PluginContext, PluginContribution, PluginStopScope} from "@lodestory/sdk";
import {externalPluginsKey, type ExternalPluginOptions, type ExternalPluginStatus, type ExternalPluginsService} from "@lodestory/sdk/external-plugins";
import {layoutExternalCapability, layoutKey, type LayoutContent, type LayoutService} from "@lodestory/sdk/layout";
import {navigationLayoutExternalCapability, navigationLayoutKey, type NavigationLayoutPage, type NavigationLayoutService} from "@lodestory/sdk/navigation-layout";
import {errorUiKey} from "@lodestory/sdk/error";
import {pluginPackagesKey, type PreparedPluginPackage} from "@lodestory/sdk/plugin-packages";
import {pluginRuntimeKey} from "@lodestory/sdk/plugin-runtime";
import {nativeProcessLoaderKey, type NativeProcessInstance} from "@lodestory/sdk/native-process-loader";
import {nativeLibraryLoaderKey} from "@lodestory/sdk/native-library-loader";
import type {UiPageContribution} from "@lodestory/sdk/ui";
import {PluginStopPreparationError, pluginsReady} from "../../plugin-core";
import {installSharedModules} from "./sharedModules";

type Staged = {content: LayoutContent; handle: PluginContribution; attach(handle: PluginContribution): void; removed(): boolean};
type LocalErrorBoundary = ComponentType<{children?: ReactNode; fallback?: ReactNode}>;
type RunningPlugin = {
  stopRequested: boolean;
  recordedDisabled: boolean;
  deactivating: boolean;
  pages(): ExternalPluginStatus["pages"];
};

function failureView() {return createElement("p", {role: "alert"}, "插件界面显示失败，请检查该插件。");}

function cleanContributions(handles: readonly PluginContribution[]) {
  const errors: unknown[] = [];
  for (const handle of [...handles].reverse()) {try {handle();} catch (error) {errors.push(error);}}
  if (errors.length) throw Object.assign(new Error(`贡献清理未完成：${errors.map(text).join("；")}`), {cleanupError: errors});
}

function ownContributions(id: string) {
  const owner = Symbol(id);
  const handles = new Set<PluginContribution>();
  let accepting = true;

  function order(handle: PluginContribution, scope: PluginStopScope) {
    const value = handle.withdrawOrder;
    return typeof value === "function" ? value(scope) : value ?? 0;
  }

  return {
    assertAccepting() {
      if (!accepting) throw new Error("插件正在停用，无法登记界面内容。");
    },
    add<T extends PluginContribution>(handle: T): T {
      handles.add(handle);
      handle.associate(owner);
      return handle;
    },
    has(handle: unknown) {return handles.has(handle as PluginContribution);},
    pause() {accepting = false;},
    resume() {accepting = true;},
    async check(scope: PluginStopScope) {
      for (const handle of handles) await handle.check(scope);
    },
    async withdraw(scope: PluginStopScope) {
      const ordered = [...handles].reverse().map(handle => ({handle, order: order(handle, scope)}));
      ordered.sort((a, b) => a.order - b.order);
      for (const {handle} of ordered) await handle.withdraw(scope);
    },
    cleanup() {cleanContributions([...handles]);},
  };
}

type OwnedContributions = ReturnType<typeof ownContributions>;

/** Hold registrations until activation and persistence have both succeeded. */
function stageLayout(layout: LayoutService, ErrorBoundary: LocalErrorBoundary, owned: OwnedContributions) {
  const staged: Staged[] = [];
  let committed = false;
  function Content({content, contentContext}: {content: LayoutContent; contentContext: Parameters<LayoutContent["render"]>[0]}) {
    return content.render(contentContext);
  }
  function stage(content: LayoutContent): PluginContribution {
    owned.assertAccepting();
    if (!content || typeof content.render !== "function") throw new Error("插件内容必须提供渲染函数。");
    const safeContent = {...content, render: (contentContext: Parameters<LayoutContent["render"]>[0]) =>
      createElement(ErrorBoundary, {fallback: failureView()}, createElement(Content, {content, contentContext}))};
    if (committed) return owned.add(layout.registerContent(safeContent));
    let actual: PluginContribution | undefined;
    let owner: symbol | undefined;
    let disposed = false;
    const handle = owned.add(Object.assign(() => {actual?.(); disposed = true;}, {
      associate(value: symbol) {owner = value; actual?.associate(value);},
      check(scope: PluginStopScope) {if (!disposed) return actual?.check(scope);},
      async withdraw(scope: PluginStopScope) {
        if (disposed || !actual) return;
        await actual.withdraw(scope);
        if (scope === "plugin") disposed = true;
      },
    }));
    staged.push({content: safeContent, handle, removed: () => disposed, attach(value) {
      actual = value;
      if (owner) actual.associate(owner);
      if (disposed) actual();
    }});
    return handle;
  }
  const service: LayoutService = {
    ...layout,
    registerContent: stage,
    registerContents(contents) {return contents.map(stage);},
    show(id) {if (!committed) throw new Error("插件激活期间不能切换现有布局内容。"); layout.show(id);},
    hide(id) {if (!committed) throw new Error("插件激活期间不能隐藏现有布局内容。"); layout.hide(id);},
  };
  return {
    service,
    commit() {
      const pending = staged.filter(item => !item.removed());
      if (!pending.length) {committed = true; return;}
      const handles = layout.registerContents(pending.map(item => item.content));
      try {pending.forEach((item, index) => item.attach(handles[index]));}
      catch (error) {try {cleanContributions(handles);} catch (cleanupError) {throw Object.assign(new Error(text(error)), {cleanupError});} throw error;}
      committed = true;
    },
    cleanup() {cleanContributions(staged.map(item => item.handle));},
  };
}

function stageNavigation(navigation: NavigationLayoutService, ErrorBoundary: LocalErrorBoundary, owned: OwnedContributions) {
  type Item = {page: NavigationLayoutPage; handle: UiPageContribution; attach(value: UiPageContribution): void; removed(): boolean};
  const staged: Item[] = [];
  let committed = false;
  function PageContent({page, pageContext}: {page: NavigationLayoutPage; pageContext: Parameters<NavigationLayoutPage["render"]>[0]}) {
    return page.render(pageContext);
  }
  function stage(page: NavigationLayoutPage): UiPageContribution {
    owned.assertAccepting();
    if (!page || typeof page.render !== "function") throw new Error("插件页面必须提供渲染函数。");
    const safePage = {...page, render: (pageContext: Parameters<NavigationLayoutPage["render"]>[0]) =>
      createElement(ErrorBoundary, {fallback: failureView()}, createElement(PageContent, {page, pageContext}))};
    let actual: UiPageContribution | undefined;
    let owner: symbol | undefined;
    let disposed = false;
    const handle = owned.add(Object.assign(() => {actual?.(); disposed = true;}, {
      associate(value: symbol) {owner = value; actual?.associate(value);},
      check(scope: PluginStopScope) {if (!disposed) return actual?.check(scope);},
      async leave() {if (!disposed) await actual?.leave?.();},
      withdrawOrder(scope: PluginStopScope) {
        const order = actual?.withdrawOrder;
        return typeof order === "function" ? order(scope) : (order ?? 0);
      },
      async withdraw(scope: PluginStopScope) {
        if (disposed || !actual) return;
        await actual.withdraw(scope);
        if (scope === "plugin") disposed = true;
      },
    }));
    const item: Item = {page: safePage, handle, removed: () => disposed, attach(value) {
      actual = value;
      if (owner) actual.associate(owner);
      if (disposed) actual();
    }};
    if (committed) item.attach(navigation.registerPage(safePage));
    staged.push(item);
    return handle;
  }
  const service: NavigationLayoutService = {
    registerPage: stage,
    registerPages(pages) {return pages.map(stage);},
    registerAction(action) {
      owned.assertAccepting();
      if (!committed) throw new Error("外部插件激活时暂不支持登记独立导航操作。");
      return owned.add(navigation.registerAction(action));
    },
  };
  return {
    service,
    pages() {return staged.filter(item => !item.removed()).map(item => Object.freeze({id: item.page.id, label: item.page.navigation.label}));},
    async leave() {for (const {handle} of staged) await handle.leave?.();},
    commit() {
      const pending = staged.filter(item => !item.removed());
      if (!pending.length) {committed = true; return;}
      const handles = navigation.registerPages(pending.map(item => item.page));
      try {pending.forEach((item, index) => item.attach(handles[index]));}
      catch (error) {try {cleanContributions(handles);} catch (cleanupError) {throw Object.assign(new Error(text(error)), {cleanupError});} throw error;}
      committed = true;
    },
    cleanup() {cleanContributions(staged.map(item => item.handle));},
  };
}

function text(error: unknown) {return error instanceof Error ? error.message : String(error);}
function assetUrl(id: string, revision: string, path: string) {
  return `${convertFileSrc(id, "lodestory-plugin")}/${revision}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function loadStyles(id: string, revision: string, paths: readonly string[]) {
  const links: HTMLLinkElement[] = [];
  try {
    for (const path of paths) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.media = "not all";
      link.href = assetUrl(id, revision, path);
      links.push(link);
      await new Promise<void>((resolve, reject) => {
        link.onload = () => resolve();
        link.onerror = () => reject(new Error(`插件样式加载失败：${path}`));
        document.head.append(link);
      });
    }
    return links;
  } catch (error) {
    for (const link of links) link.remove();
    throw error;
  }
}

/** Coordinates package preparation, the existing native loaders and Core activation. */
export function createExternalPluginsPlugin(): Plugin {
  let cleanup: (() => void) | undefined;
  return {
    id: "external-plugins", requires: [pluginPackagesKey, pluginRuntimeKey, nativeProcessLoaderKey, nativeLibraryLoaderKey, layoutKey, navigationLayoutKey, errorUiKey],
    provides: [externalPluginsKey],
    activate(context) {
      const packages = context.get(pluginPackagesKey);
      const runtime = context.get(pluginRuntimeKey);
      const processLoader = context.get(nativeProcessLoaderKey);
      const libraryLoader = context.get(nativeLibraryLoaderKey);
      const layout = context.get(layoutKey);
      const navigation = context.get(navigationLayoutKey);
      const {ErrorBoundary} = context.get(errorUiKey);
      const listeners = new Set<() => void>();
      const running = new Map<string, RunningPlugin>();
      const recoveryNeeded = new Set<string>();
      let snapshot: Readonly<Record<string, ExternalPluginStatus>> = Object.freeze({});
      let active = true;
      let stopping = false;
      let queue = Promise.resolve();
      let restoreTimer: ReturnType<typeof setTimeout> | undefined;
      function update(id: string, status?: ExternalPluginStatus) {
        const next = {...snapshot};
        if (status) next[id] = Object.freeze(status);
        else delete next[id];
        snapshot = Object.freeze(next);
        for (const listener of [...listeners]) {try {listener();} catch (error) {console.error("插件状态通知失败。", error);}}
      }
      function checkRecovery(id: string) {
        if (recoveryNeeded.has(id)) throw new Error("上次插件清理未完成，请保存内容并重新启动应用后再试。");
      }
      async function enable(id: string, restoring: boolean) {
        checkRecovery(id);
        if (running.has(id)) {
          if (snapshot[id]?.state === "enabled") return;
          throw new Error("请先完成插件停用，再重新启用。");
        }
        update(id, {state: "loading"});
        let prepared: PreparedPluginPackage | undefined;
        let backend: NativeProcessInstance | undefined;
        let links: HTMLLinkElement[] = [];
        let mounted = false;
        let persisted = restoring;
        let stage: ReturnType<typeof stageLayout> | undefined;
        let pageStage: ReturnType<typeof stageNavigation> | undefined;
        let child: Plugin | undefined;
        let cleanupOwnedByCore = false;
        try {
          prepared = await packages.prepare(id);
          if (prepared.provides.length) throw new Error("当前版本尚不支持外部插件提供共享能力。");
          const contracts = new Map<string, symbol>([[layoutExternalCapability.id, layoutKey.token], [navigationLayoutExternalCapability.id, navigationLayoutKey.token]]);
          if (prepared.requires.some(key => !contracts.has(key))) throw new Error("插件声明了尚不支持的能力。");
          if (prepared.backend) backend = await (prepared.backend.type === "process" ? processLoader : libraryLoader).load(prepared.backend.entry);
          if (prepared.frontend) {
            installSharedModules();
            links = await loadStyles(id, prepared.assetRevision, prepared.frontend.styles);
            const module = await import(/* @vite-ignore */ assetUrl(id, prepared.assetRevision, prepared.frontend.entry));
            if (typeof module.default !== "function") throw new Error("插件前端入口必须默认导出插件工厂。");
            const options: ExternalPluginOptions = {backend: backend ? Object.freeze({call: backend.call.bind(backend)}) : undefined};
            child = await module.default(options);
            if (!child || child.id !== id || !Array.isArray(child.requires) || !Array.isArray(child.provides) || typeof child.activate !== "function") {
              throw new Error("插件入口返回的插件无效，或其 ID 与清单不一致。");
            }
            const declared = prepared.requires.map(key => contracts.get(key)!);
            if (child.provides.length || child.requires.length !== declared.length
                || child.requires.some(key => !declared.includes(key.token))) {
              throw new Error("插件代码中的能力声明与清单不一致或暂不受支持。");
            }
          } else if (prepared.requires.length) {
            throw new Error("仅后端插件暂不支持声明前端能力依赖。");
          }
          if (!active || stopping) throw new Error("插件加载服务正在停止。");
          const owned = ownContributions(id);
          stage = stageLayout(layout, ErrorBoundary, owned);
          pageStage = stageNavigation(navigation, ErrorBoundary, owned);
          const childPlugin = child;
          const instance = backend;
          const contributionStage = stage;
          const navigationStage = pageStage;
          const styles = links;
          const current: RunningPlugin = {
            stopRequested: false, recordedDisabled: false, deactivating: false,
            pages: () => Object.freeze(navigationStage.pages()),
          };
          const wrapper: Plugin = {
            id,
            requires: [...(childPlugin?.requires ?? []), externalPluginsKey,
              ...(prepared.backend ? [prepared.backend.type === "process" ? nativeProcessLoaderKey : nativeLibraryLoaderKey] : [])],
            provides: [],
            async activate(pluginContext) {
              cleanupOwnedByCore = true;
              pluginContext.onStop({withdrawOrder: 100, async withdraw() {await instance?.close();}});
              pluginContext.onStop({
                withdrawOrder: -200,
                check: owned.check,
                async prepare(scope) {
                  owned.pause();
                  try {
                    if (scope === "plugin" && current.stopRequested && !current.recordedDisabled) {
                      // Child save hooks run first. Leave the current page through its normal guards.
                      await navigationStage.leave();
                      await packages.setEnabled(id, false, true);
                      current.recordedDisabled = true;
                    }
                  } catch (error) {
                    owned.resume();
                    throw error;
                  }
                },
                cancel() {if (!current.recordedDisabled) owned.resume();},
                withdraw: owned.withdraw,
              });
              if (!childPlugin) return;
              const wrapped: PluginContext = {
                ...pluginContext,
                track(participant) {
                  return owned.has(participant) ? participant : pluginContext.track(participant);
                },
                get(key) {
                  if (!childPlugin.requires.some(declared => declared.token === key.token)) {
                    throw new Error(`插件未声明所需能力：${key.id}`);
                  }
                  if (key.token === layoutKey.token) return contributionStage.service as never;
                  if (key.token === navigationLayoutKey.token) return navigationStage.service as never;
                  return pluginContext.get(key);
                },
              };
              await childPlugin.activate(wrapped);
            },
            async deactivate() {
              current.deactivating = true;
              running.delete(id);
              owned.pause();
              const errors: unknown[] = [];
              try {await childPlugin?.deactivate?.();} catch (error) {errors.push(error);}
              try {owned.cleanup();} catch (error) {errors.push(error);}
              for (const link of styles) link.remove();
              try {await instance?.close();} catch (error) {errors.push(error);}
              if (!errors.length) {
                try {await packages.releaseAssets(id);} catch (error) {errors.push(error);}
              }
              if (errors.length) {
                recoveryNeeded.add(id);
                throw new Error(`插件清理未完成：${errors.map(text).join("；")}`);
              }
            },
          };
          await runtime.mount(wrapper);
          mounted = true;
          if (!restoring) {await packages.setEnabled(id, true); persisted = true;}
          flushSync(() => {
            try {
              pageStage!.commit();
              stage!.commit();
              for (const link of links) link.media = "all";
            } catch (error) {
              const failures: unknown[] = [];
              try {stage!.cleanup();} catch (cleanupError) {failures.push(cleanupError);}
              try {pageStage!.cleanup();} catch (cleanupError) {failures.push(cleanupError);}
              if (failures.length) throw Object.assign(new Error(`${text(error)}；界面回滚未完成：${failures.map(text).join("；")}`), {cleanupError: failures});
              throw error;
            }
          });
          running.set(id, current);
          update(id, {state: "enabled", pages: current.pages()});
        } catch (error) {
          const failures: string[] = [];
          let unmountFailed = false;
          const cleanupError = error && typeof error === "object" && "cleanupError" in error
            ? (error as {cleanupError: unknown}).cleanupError : undefined;
          if (cleanupError) failures.push(`清理未完成：${text(cleanupError)}`);
          if (mounted) {
            try {await runtime.unmount(id);} catch (cleanupError) {unmountFailed = true; failures.push(`插件清理未完成：${text(cleanupError)}`);}
          } else if (!cleanupOwnedByCore) {
            for (const link of links) link.remove();
            try {await backend?.close();} catch (cleanupError) {failures.push(`后端清理未完成：${text(cleanupError)}`);}
            if (prepared && !failures.length) {
              try {await packages.releaseAssets(id);} catch (cleanupError) {failures.push(`资源清理未完成：${text(cleanupError)}`);}
            }
          }
          if (persisted && !restoring && !unmountFailed) try {await packages.setEnabled(id, false);} catch (recordError) {failures.push(`启用记录回滚失败：${text(recordError)}`);}
          const recovery = failures.length > 0;
          if (recovery) recoveryNeeded.add(id);
          const message = [text(error), ...failures, ...(recovery ? ["请保存内容并重新启动应用后再试。"] : [])].join("；");
          update(id, {state: "error", error: message, canRetry: !recovery});
          throw new Error(message);
        }
      }
      async function stopInstalled(id: string, operation: "disabling" | "uninstalling") {
        checkRecovery(id);
        const current = running.get(id);
        update(id, {state: operation});
        try {
          if (current) {
            current.stopRequested = true;
            await runtime.unmount(id);
          } else if (operation === "disabling") {
            await packages.setEnabled(id, false, true);
          } else {
            const items = await packages.list();
            if (items.some(item => item.id === id && item.enabled && !item.removalPending)) {
              await packages.setEnabled(id, false, true);
            }
          }
        } catch (error) {
          const canRetry = !current?.deactivating;
          if (!canRetry) recoveryNeeded.add(id);
          const reason = error instanceof PluginStopPreparationError ? error.cause : error;
          const message = [text(reason), ...(!canRetry ? ["请保存内容并重新启动应用后再试。"] : [])].join(" ");
          update(id, {state: "stop-error", error: message, canRetry,
            pages: current && !current.recordedDisabled && !current.deactivating ? current.pages() : undefined});
          throw Object.assign(new Error(message), {cause: error});
        } finally {
          if (current) current.stopRequested = false;
        }
      }
      async function uninstall(id: string) {
        await stopInstalled(id, "uninstalling");
        try {
          await packages.remove(id);
          update(id);
        } catch (error) {
          update(id, {state: "uninstall-error", error: text(error)});
          throw error;
        }
      }
      function enqueue(work: () => Promise<void>) {
        const operation = queue.then(() => {
          if (!active || stopping) throw new Error("插件加载服务正在停止。");
          return work();
        });
        queue = operation.catch(() => {});
        return operation;
      }
      const service: ExternalPluginsService = {
        enable: id => enqueue(() => enable(id, false)),
        disable: id => enqueue(async () => {
          await stopInstalled(id, "disabling");
          update(id, {state: "disabled"});
        }),
        uninstall: id => enqueue(() => uninstall(id)),
        getSnapshot: () => snapshot,
        subscribe(listener) {listeners.add(listener); return () => {listeners.delete(listener);};},
      };
      context.provide(externalPluginsKey, Object.freeze(service));
      context.on(pluginsReady, () => {
        if (!isTauri()) return;
        restoreTimer = setTimeout(() => {
          void enqueue(async () => {
            const items = await packages.list();
            for (const item of items) {
              if (!active || stopping) break;
              if (item.enabled && !item.removalPending) await enable(item.id, true).catch(() => {});
            }
          }).catch(error => console.error("恢复插件失败。", error));
        }, 0);
      });
      context.onStop({async prepare() {stopping = true; await queue;}, cancel() {stopping = false;}});
      cleanup = () => {active = false; stopping = true; if (restoreTimer) clearTimeout(restoreTimer); listeners.clear();};
    },
    deactivate() {cleanup?.(); cleanup = undefined;},
  };
}
