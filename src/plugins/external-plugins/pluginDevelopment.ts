import type {DevelopmentPluginStatus, ExternalPluginStatus} from "@lodestory/sdk/external-plugins";
import type {DevelopmentBuildStatus, DevelopmentPluginBuild, PluginPackagesService} from "@lodestory/sdk/plugin-packages";

type RestoreView = () => Promise<void>;
type DevelopmentRuntime = {
  status(id: string): ExternalPluginStatus | undefined;
  updateStatus(id: string, status?: ExternalPluginStatus): void;
  isRunning(id: string): boolean;
  stop(id: string): Promise<RestoreView | undefined>;
  load(build: DevelopmentPluginBuild): Promise<void>;
  loadInstalled(id: string): Promise<void>;
};

type Session = {
  folder: string;
  id?: string;
  installedStatus?: ExternalPluginStatus;
  installedSuspended: boolean;
  builds: Map<string, DevelopmentPluginBuild>;
  attempted?: string;
  current?: DevelopmentPluginBuild;
  lastGood?: DevelopmentPluginBuild;
  reloadError?: string;
  closing: boolean;
};

function message(error: unknown) {return error instanceof Error ? error.message : String(error);}

export function createPluginDevelopment(packages: PluginPackagesService, runtime: DevelopmentRuntime,
  enqueue: (work: () => Promise<void>) => Promise<void>, notify: () => void) {
  let session: Session | undefined;
  let snapshot: DevelopmentPluginStatus | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let paused = false;

  function publish(value: Session, state: DevelopmentPluginStatus["state"], error?: string, canRetry?: boolean) {
    const {id, folder, current} = value;
    const revision = current?.revision;
    const pages = id && current ? runtime.status(id)?.pages : undefined;
    if (state === "error" && id && runtime.status(id)?.canRetry === false) canRetry = false;
    if (snapshot?.folder === folder && snapshot.id === id && snapshot.state === state
      && snapshot.revision === revision && snapshot.error === error && snapshot.pages === pages && snapshot.canRetry === canRetry) return;
    snapshot = Object.freeze({folder, id, state, revision, error, pages, canRetry});
    notify();
  }

  function cancelTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function schedule(delay = 500) {
    const value = session;
    if (!value || paused || value.closing || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void enqueue(async () => {
        if (session === value && !paused && !value.closing) await refresh(value);
      }).catch(() => {}).finally(() => schedule());
    }, delay);
  }

  async function discardBuilds(value: Session, keep: ReadonlySet<string>) {
    for (const [revision, build] of value.builds) {
      if (keep.has(revision)) continue;
      await packages.discardDevelopmentBuild(build.token);
      value.builds.delete(revision);
    }
  }

  async function restoreInstalled(value: Session, id: string) {
    await runtime.loadInstalled(id);
    value.installedSuspended = false;
  }

  async function stopCurrent(value: Session, id: string) {
    const wasDevelopment = value.current !== undefined;
    try {return await runtime.stop(id);}
    finally {
      // Core can remove a plugin even if its final cleanup reports an error.
      if (!runtime.isRunning(id)) {
        value.current = undefined;
        if (!wasDevelopment) value.installedSuspended = true;
      }
    }
  }

  async function reload(value: Session, next: DevelopmentPluginBuild) {
    const {id} = next;
    const reopen = runtime.isRunning(id) ? await stopCurrent(value, id) : undefined;

    try {
      await runtime.load(next);
    } catch (error) {
      try {
        if (value.lastGood) {
          await runtime.load(value.lastGood);
          value.current = value.lastGood;
          await reopen?.();
        } else if (value.installedSuspended) {
          await restoreInstalled(value, id);
          await reopen?.();
        }
      } catch (restoreError) {
        throw new Error(`开发版加载失败：${message(error)}。恢复上一版失败：${message(restoreError)}`);
      }
      throw error;
    }
    value.current = value.lastGood = next;
    await reopen?.();
  }

  async function refresh(value: Session, retry = false) {
    let status: DevelopmentBuildStatus;
    try {status = await packages.readDevelopmentStatus(value.folder);}
    catch (error) {
      publish(value, "error", message(error));
      return;
    }
    const {revision, state, error} = status;
    if (state === "building") {
      publish(value, "building");
      return;
    }
    if (state === "error") {
      publish(value, "error", error || "插件构建失败，请查看开发终端。", false);
      return;
    }
    try {
      if (revision && revision !== value.current?.revision && (retry || revision !== value.attempted)) {
        value.attempted = revision;
        publish(value, "reloading");
        let next = value.builds.get(revision);
        if (!next) {
          next = await packages.stageDevelopmentBuild(value.folder, revision);
          value.builds.set(revision, next);
        }
        if (value.id && value.id !== next.id) {
          await discardBuilds(value, new Set(value.lastGood ? [value.lastGood.revision] : []));
          throw new Error("开发项目的插件 ID 已改变。请退出开发模式后重新选择项目。");
        }
        if (!value.id) {
          value.id = next.id;
          value.installedStatus = runtime.status(next.id);
          publish(value, "reloading");
        }
        const keep = new Set([revision]);
        if (value.lastGood) keep.add(value.lastGood.revision);
        await discardBuilds(value, keep);
        await reload(value, next);
        value.reloadError = undefined;
        await discardBuilds(value, new Set([revision]));
      }
      if (value.reloadError) publish(value, "error", value.reloadError);
      else if (state === "stopped") publish(value, "watch-stopped");
      else publish(value, value.current ? "running" : "waiting");
    } catch (error) {
      value.reloadError = message(error);
      publish(value, "error", value.reloadError);
    }
  }

  return {
    owns(id: string) {return session?.id === id;},
    getSnapshot() {return snapshot;},
    start(folder: string) {
      if (session) throw new Error("请先退出当前插件的开发模式。");
      if (!folder.trim()) throw new Error("请选择本地插件项目文件夹。");
      session = {folder, installedSuspended: false, builds: new Map(), closing: false};
      publish(session, "waiting");
      schedule(0);
    },
    async retry() {
      if (!session || session.closing) return;
      session.reloadError = undefined;
      await refresh(session, true);
    },
    async stop() {
      const value = session;
      if (!value) return;
      cancelTimer();
      value.closing = true;
      publish(value, "stopping");
      try {
        const {id} = value;
        let reopen: RestoreView | undefined;
        if (id && value.current && runtime.isRunning(id)) {
          reopen = await stopCurrent(value, id);
        }
        await discardBuilds(value, new Set());
        if (id && value.installedSuspended) {
          await restoreInstalled(value, id);
          await reopen?.();
        } else if (id && !runtime.isRunning(id)) {
          runtime.updateStatus(id, value.installedStatus);
        }
        session = undefined;
        snapshot = null;
        notify();
      } catch (error) {
        publish(value, "error", message(error), false);
        throw error;
      }
    },
    pause() {paused = true; cancelTimer();},
    resume() {paused = false; schedule();},
    async dispose() {
      paused = true;
      cancelTimer();
      const value = session;
      session = undefined;
      snapshot = null;
      if (value) await discardBuilds(value, new Set());
    },
  };
}
