import {convertFileSrc, isTauri} from "@tauri-apps/api/core";
import {createElement, type ComponentType, type ReactNode} from "react";
import {flushSync} from "react-dom";
import type {Plugin, PluginContext, PluginContribution} from "@lodestory/sdk";
import {externalPluginsKey, type ExternalPluginOptions, type ExternalPluginStatus, type ExternalPluginsService} from "@lodestory/sdk/external-plugins";
import {layoutExternalCapability, layoutKey, type LayoutContent, type LayoutService} from "@lodestory/sdk/layout";
import {navigationLayoutExternalCapability, navigationLayoutKey, type NavigationLayoutPage, type NavigationLayoutService} from "@lodestory/sdk/navigation-layout";
import {errorUiKey} from "@lodestory/sdk/error";
import {pluginPackagesKey, type PreparedPluginPackage} from "@lodestory/sdk/plugin-packages";
import {pluginRuntimeKey} from "@lodestory/sdk/plugin-runtime";
import {nativeProcessLoaderKey, type NativeProcessInstance} from "@lodestory/sdk/native-process-loader";
import {nativeLibraryLoaderKey} from "@lodestory/sdk/native-library-loader";
import {pluginsReady} from "../../plugin-core";
import {installSharedModules} from "./sharedModules";

type Staged = {content: LayoutContent; handle: PluginContribution; attach(handle: PluginContribution): void; removed(): boolean};
type LocalErrorBoundary = ComponentType<{children?: ReactNode; fallback?: ReactNode}>;

function failureView() {return createElement("p", {role: "alert"}, "插件界面显示失败，请检查该插件。");}

function cleanContributions(handles: readonly PluginContribution[]) {
  const errors: unknown[] = [];
  for (const handle of [...handles].reverse()) {try {handle();} catch (error) {errors.push(error);}}
  if (errors.length) throw Object.assign(new Error(`贡献清理未完成：${errors.map(text).join("；")}`), {cleanupError: errors});
}

/** Hold registrations until activation and persistence have both succeeded. */
function stageLayout(layout: LayoutService, ErrorBoundary: LocalErrorBoundary) {
  const staged: Staged[] = [];
  let committed = false;
  function Content({content, contentContext}: {content: LayoutContent; contentContext: Parameters<LayoutContent["render"]>[0]}) {
    return content.render(contentContext);
  }
  function stage(content: LayoutContent): PluginContribution {
    if (!content || typeof content.render !== "function") throw new Error("插件内容必须提供渲染函数。");
    const safeContent = {...content, render: (contentContext: Parameters<LayoutContent["render"]>[0]) =>
      createElement(ErrorBoundary, {fallback: failureView()}, createElement(Content, {content, contentContext}))};
    if (committed) return layout.registerContent(safeContent);
    let actual: PluginContribution | undefined;
    let owner: symbol | undefined;
    let disposed = false;
    const handle = Object.assign(() => {disposed = true; actual?.();}, {
      associate(value: symbol) {owner = value; actual?.associate(value);},
      check(scope: "plugin" | "application") {return actual?.check(scope);},
      withdraw(scope: "plugin" | "application") {return actual?.withdraw(scope);},
    });
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

function stageNavigation(navigation: NavigationLayoutService, ErrorBoundary: LocalErrorBoundary) {
  type Item = {page: NavigationLayoutPage; handle: PluginContribution; attach(value: PluginContribution): void; removed(): boolean};
  const staged: Item[] = [];
  let committed = false;
  function PageContent({page, pageContext}: {page: NavigationLayoutPage; pageContext: Parameters<NavigationLayoutPage["render"]>[0]}) {
    return page.render(pageContext);
  }
  function stage(page: NavigationLayoutPage): PluginContribution {
    if (!page || typeof page.render !== "function") throw new Error("插件页面必须提供渲染函数。");
    const safePage = {...page, render: (pageContext: Parameters<NavigationLayoutPage["render"]>[0]) =>
      createElement(ErrorBoundary, {fallback: failureView()}, createElement(PageContent, {page, pageContext}))};
    if (committed) return navigation.registerPage(safePage);
    let actual: PluginContribution | undefined;
    let owner: symbol | undefined;
    let disposed = false;
    const handle = Object.assign(() => {disposed = true; actual?.();}, {
      associate(value: symbol) {owner = value; actual?.associate(value);},
      check(scope: "plugin" | "application") {return actual?.check(scope);},
      withdrawOrder(scope: "plugin" | "application") {
        const order = actual?.withdrawOrder;
        return typeof order === "function" ? order(scope) : (order ?? 0);
      },
      withdraw(scope: "plugin" | "application") {return actual?.withdraw(scope);},
    });
    staged.push({page: safePage, handle, removed: () => disposed, attach(value) {
      actual = value;
      if (owner) actual.associate(owner);
      if (disposed) actual();
    }});
    return handle;
  }
  const service: NavigationLayoutService = {
    registerPage: stage,
    registerPages(pages) {return pages.map(stage);},
    registerAction(action) {
      if (!committed) throw new Error("外部插件激活时暂不支持登记独立导航操作。");
      return navigation.registerAction(action);
    },
  };
  return {
    service,
    pages() {return staged.filter(item => !item.removed()).map(item => Object.freeze({id: item.page.id, label: item.page.navigation.label}));},
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
function assetUrl(id: string, path: string) {
  return `${convertFileSrc(id, "lodestory-plugin")}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function loadStyles(id: string, paths: readonly string[]) {
  const links: HTMLLinkElement[] = [];
  try {
    for (const path of paths) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.media = "not all";
      link.href = assetUrl(id, path);
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
      const recoveryNeeded = new Set<string>();
      let snapshot: Readonly<Record<string, ExternalPluginStatus>> = Object.freeze({});
      let active = true;
      let stopping = false;
      let queue = Promise.resolve();
      let restoreTimer: ReturnType<typeof setTimeout> | undefined;
      function update(id: string, status: ExternalPluginStatus) {
        snapshot = Object.freeze({...snapshot, [id]: Object.freeze(status)});
        for (const listener of [...listeners]) {try {listener();} catch (error) {console.error("插件状态通知失败。", error);}}
      }
      async function perform(id: string, restoring: boolean) {
        if (!active || stopping) throw new Error("插件加载服务正在停止。");
        if (recoveryNeeded.has(id)) throw new Error("上次插件清理未完成，请保存内容并重新启动应用后再试。");
        if (snapshot[id]?.state === "enabled") return;
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
            links = await loadStyles(id, prepared.frontend.styles);
            const module = await import(/* @vite-ignore */ assetUrl(id, prepared.frontend.entry));
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
          stage = stageLayout(layout, ErrorBoundary);
          pageStage = stageNavigation(navigation, ErrorBoundary);
          const childPlugin = child;
          const instance = backend;
          const contributionStage = stage;
          const navigationStage = pageStage;
          const styles = links;
          const wrapper: Plugin = {
            id,
            requires: [...(childPlugin?.requires ?? []), externalPluginsKey,
              ...(prepared.backend ? [prepared.backend.type === "process" ? nativeProcessLoaderKey : nativeLibraryLoaderKey] : [])],
            provides: [],
            async activate(pluginContext) {
              cleanupOwnedByCore = true;
              pluginContext.onStop({withdrawOrder: 100, async withdraw() {await instance?.close();}});
              if (!childPlugin) return;
              const wrapped: PluginContext = {
                ...pluginContext,
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
              const errors: unknown[] = [];
              try {await childPlugin?.deactivate?.();} catch (error) {errors.push(error);}
              try {contributionStage.cleanup();} catch (error) {errors.push(error);}
              try {navigationStage.cleanup();} catch (error) {errors.push(error);}
              for (const link of styles) link.remove();
              try {await instance?.close();} catch (error) {errors.push(error);}
              try {await packages.releaseAssets(id);} catch (error) {errors.push(error);}
              if (errors.length) throw new Error(`插件清理未完成：${errors.map(text).join("；")}`);
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
          update(id, {state: "enabled", pages: Object.freeze(pageStage.pages())});
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
            if (prepared) try {await packages.releaseAssets(id);} catch (cleanupError) {failures.push(`资源清理未完成：${text(cleanupError)}`);}
          }
          if (persisted && !restoring && !unmountFailed) try {await packages.setEnabled(id, false);} catch (recordError) {failures.push(`启用记录回滚失败：${text(recordError)}`);}
          const recovery = failures.length > 0;
          if (recovery) recoveryNeeded.add(id);
          const message = [text(error), ...failures, ...(recovery ? ["请保存内容并重新启动应用后再试。"] : [])].join("；");
          update(id, {state: "error", error: message, canRetry: !recovery});
          throw new Error(message);
        }
      }
      function enqueue(id: string, restoring = false) {
        const operation = queue.then(() => perform(id, restoring));
        queue = operation.catch(() => {});
        return operation;
      }
      const service: ExternalPluginsService = {
        enable: id => enqueue(id),
        getSnapshot: () => snapshot,
        subscribe(listener) {listeners.add(listener); return () => {listeners.delete(listener);};},
      };
      context.provide(externalPluginsKey, Object.freeze(service));
      context.on(pluginsReady, () => {
        if (!isTauri()) return;
        restoreTimer = setTimeout(() => {
          void packages.list().then(items => {
            for (const item of items) if (item.enabled && active && !stopping) void enqueue(item.id, true).catch(() => {});
          }).catch(error => console.error("恢复插件失败。", error));
        }, 0);
      });
      context.onStop({async prepare() {stopping = true; await queue;}, cancel() {stopping = false;}});
      cleanup = () => {active = false; stopping = true; if (restoreTimer) clearTimeout(restoreTimer); listeners.clear();};
    },
    deactivate() {cleanup?.(); cleanup = undefined;},
  };
}
