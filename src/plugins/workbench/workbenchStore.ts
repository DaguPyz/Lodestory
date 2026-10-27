import type {LeaveReason, WorkbenchLoading, WorkbenchParticipant, WorkbenchParticipation, WorkbenchProject, WorkbenchService, WorkbenchSession, WorkbenchSnapshot} from "@lodestory/sdk/workbench";
import type {UiLocation, UiNavigationApproval, UiNavigationRequest, UiService} from "@lodestory/sdk/ui";

type Resource = {value: WorkbenchParticipation; disposed: boolean; disposal?: Promise<void>};
type Registration = {id: string; label?: string; start: WorkbenchParticipant["start"]};
type Options = {editorPage: string; welcomePage: string; stopView: () => void; flushView?: (update: () => void) => void};
type Startup = {target: WorkbenchSession; previous: WorkbenchSnapshot; previousLocation: UiLocation | null;
  restoreByBack: boolean; previousResources: Resource[]; token: number};

function projectValue(input: unknown): WorkbenchProject {
  const project = input as Partial<WorkbenchProject> | null;
  if (!project || [project.id, project.name, project.path].some(value => typeof value !== "string" || !value.trim())) {
    throw new TypeError("Editor page requires a project with an id, name, and path.");
  }
  return Object.freeze({id: project.id!, name: project.name!, path: project.path!});
}

async function release(resources: Resource[]) {
  const errors: unknown[] = [];
  for (const resource of [...resources].reverse()) {
    if (!resource.disposed) {
      resource.disposed = true;
      resource.disposal = Promise.resolve().then(() => resource.value.dispose());
    }
    try { await resource.disposal; } catch (error) { errors.push(error); }
  }
  if (errors.length) throw Object.assign(new Error("Workbench resources failed to clean up."), {errors});
}

/** 应用级协调器；先提交工作台路由，再依序初始化项目参与者。 */
export function createWorkbenchStore(ui: UiService, options: Options) {
  const participants = new Map<string, Registration>();
  const listeners = new Set<() => void>();
  let snapshot: WorkbenchSnapshot = Object.freeze({session: null, active: false, busy: false, loading: null});
  let resources: Resource[] = [];
  let alive = true;
  let ready = false;
  let sequence = 0;
  let generation = 0;
  let revoking = 0;
  let preparing: Promise<boolean | UiNavigationApproval> | undefined;
  let starting: Promise<void> | undefined;
  let shuttingDown: Promise<boolean> | undefined;
  let pending: UiNavigationApproval | undefined;
  let stopping: Promise<void> | undefined;
  let startup: Startup | undefined;
  let recoveryNavigation: {location: UiLocation; snapshot: WorkbenchSnapshot; resources: Resource[]} | undefined;

  function checkActive() {
    if (!alive) throw new Error("Workbench service is no longer active.");
  }
  function checkReady() {
    checkActive();
    if (!ready) throw new Error("Workbench is not ready before pluginsReady.");
  }
  function flushView(update: () => void) { (options.flushView ?? (action => action()))(update); }
  function publish(next: WorkbenchSnapshot) {
    if (!alive) return;
    if (revoking) next = {...next, busy: true};
    if (next.session === snapshot.session && next.active === snapshot.active && next.busy === snapshot.busy
      && next.loading === snapshot.loading) return;
    snapshot = Object.freeze(next);
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { console.error("Workbench listener failed.", {error}); }
    }
  }
  function valid(token: number) {
    if (!alive || generation !== token) throw new Error("Workbench transition was cancelled.");
  }
  async function allowed(reason: LeaveReason, token: number) {
    for (const resource of resources) {
      valid(token);
      if (resource.disposed) continue;
      if (resource.value.beforeLeave && !await resource.value.beforeLeave(reason)) return false;
      valid(token);
    }
    return true;
  }

  function loadingState(completed: number, total: number, current: string | null,
    error: WorkbenchLoading["error"] = null): WorkbenchLoading {
    return Object.freeze({completed, total, current, error});
  }

  function sameLocation(actual: UiLocation | null, expected: UiLocation) {
    if (!actual || actual.id !== expected.id) return false;
    if (Object.is(actual.params, expected.params)) return true;
    if (actual.id !== options.editorPage) return false;
    const actualProject = (actual.params as {project?: Partial<WorkbenchProject>} | null)?.project;
    const expectedProject = (expected.params as {project?: Partial<WorkbenchProject>} | null)?.project;
    return !!actualProject && !!expectedProject && actualProject.id === expectedProject.id
      && actualProject.path === expectedProject.path;
  }

  async function restorePreviousRoute(location: UiLocation | null,
    state: WorkbenchSnapshot, previousResources: Resource[], restoreByBack: boolean) {
    if (!location) return false;
    recoveryNavigation = {location, snapshot: state, resources: previousResources};
    const uiState = ui.getSnapshot();
    if (restoreByBack && uiState.canGoBack) {
      const backed = await ui.back();
      if (!backed) {
        recoveryNavigation = undefined;
        return false;
      }
      if (sameLocation(ui.getSnapshot().current, location)) return true;
    }
    const opened = await ui.openPage(location.id, location.params, {history: "reset"});
    if (!opened) recoveryNavigation = undefined;
    return opened;
  }

  function exposeRecoveryError(start: Startup, message: string) {
    startup = start;
    flushView(() => publish({...start.previous, active: false, busy: true,
      loading: loadingState(0, participants.size, null,
        Object.freeze({participantId: "workbench", message}))}));
  }

  async function initialize(start: Startup) {
    const created: Resource[] = [];
    const entries = [...participants.values()];
    let currentParticipantId = entries[0]?.id ?? "workbench";
    let completed = 0;
    try {
      for (let index = 0; index < entries.length; index++) {
        valid(start.token);
        const entry = entries[index]!;
        currentParticipantId = entry.id;
        publish({...snapshot, busy: true,
          loading: loadingState(index, entries.length, entry.label ?? null)});
        const value = await entry.start(start.target);
        if (value && typeof value.dispose === "function") created.push({value, disposed: false});
        if (!value || typeof value.dispose !== "function" || (value.beforeLeave !== undefined && typeof value.beforeLeave !== "function")) {
          throw Object.assign(new TypeError(`Workbench participant '${entry.id}' must return a disposable participation.`),
            {participantId: entry.id});
        }
        valid(start.token);
        completed = index + 1;
        publish({...snapshot, busy: true,
          loading: loadingState(index + 1, entries.length, entries[index + 1]?.label ?? null)});
      }
      valid(start.token);
      resources = created;
      startup = undefined;
      flushView(() => publish({session: start.target, active: true, busy: true,
        loading: loadingState(completed, entries.length, null)}));
      try { await release(start.previousResources); }
      catch (error) { console.error("Previous workbench resources failed to release after project switch.", {error}); }
      if (alive && generation === start.token && !revoking) {
        publish({session: start.target, active: true, busy: false, loading: null});
      }
    } catch (cause) {
      if (!alive || generation !== start.token || revoking) {
        try { await release(created); } catch (error) { console.error("Cancelled workbench startup cleanup failed.", {error}); }
        return;
      }
      const participantId = typeof (cause as {participantId?: unknown})?.participantId === "string"
        ? (cause as {participantId: string}).participantId : currentParticipantId;
      const message = cause instanceof Error ? cause.message : String(cause);
      const previousSession = start.previous.session;
      // Remove the candidate view from React before releasing any resource it may have read.
      // Keep the transition locked and hide recovery actions until cleanup is complete.
      flushView(() => publish({session: previousSession, active: false, busy: true,
        loading: loadingState(completed, entries.length,
          entries.find(entry => entry.id === participantId)?.label ?? null)}));
      let cleanupError: unknown;
      try { await release(created); } catch (error) { cleanupError = error; }
      if (!alive || generation !== start.token || revoking) return;
      resources = start.previousResources;
      startup = {...start, target: start.target};
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message
        : cleanupError ? String(cleanupError) : undefined;
      const finalMessage = cleanupMessage ? `${message}；清理失败：${cleanupMessage}` : message;
      flushView(() => publish({...snapshot, loading: loadingState(completed, entries.length,
        entries.find(entry => entry.id === participantId)?.label ?? null,
        Object.freeze({participantId, message: finalMessage}))}));
    }
  }

  function launch(start: Startup) {
    startup = start;
    const operation = Promise.resolve().then(() => initialize(start));
    starting = operation;
    void operation.finally(() => { if (starting === operation) starting = undefined; }).catch(() => {});
  }

  async function buildApproval(request: UiNavigationRequest, token: number,
    previous: WorkbenchSnapshot): Promise<boolean | UiNavigationApproval> {
    const oldResources = resources;
    let nextSession = snapshot.session;
    let nextResources = oldResources;
    let needsStart = false;
    let isRecovery = false;
    let recoverySnapshot: WorkbenchSnapshot | undefined;
    let reason: LeaveReason | undefined;
    try {
      const recovery = recoveryNavigation && sameLocation(request.to, recoveryNavigation.location)
        ? recoveryNavigation : undefined;
      if (recovery) {
        isRecovery = true;
        recoverySnapshot = recovery.snapshot;
        nextSession = recovery.snapshot.session;
        nextResources = recovery.resources;
      }

      if (isRecovery) {
        // The target session and route were already prepared before startup began.
      } else if (request.to.id === options.editorPage) {
        const input = (request.to.params as {project?: unknown} | null)?.project ?? snapshot.session?.project;
        const project = projectValue(input);
        const same = snapshot.session?.project.id === project.id && snapshot.session.project.path === project.path;
        if (!same) {
          if (snapshot.session) reason = "switch";
          nextSession = Object.freeze({id: `workbench-session-${++sequence}`, project});
          nextResources = oldResources;
          needsStart = true;
        }
      } else if (request.to.id === options.welcomePage && snapshot.session) {
        reason = "close";
        nextSession = null;
        nextResources = [];
      } else if (snapshot.session && request.from?.id === options.editorPage) {
        reason = "suspend";
      }

      if (reason && !await allowed(reason, token)) {
        publish(previous);
        return false;
      }
      valid(token);

      let committed = false;
      let finished = false;
      let finishing: Promise<void> | undefined;
      const approval: UiNavigationApproval = {
        commit() {
          valid(token);
          committed = true;
          if (!needsStart && nextResources !== oldResources) resources = nextResources;
          const loading = needsStart
            ? loadingState(0, participants.size, [...participants.values()][0]?.label ?? null)
            : null;
          publish({session: nextSession, active: request.to.id === options.editorPage && nextSession !== null,
            busy: true, loading});
        },
        cancel() {
          if (finished) return finishing;
          finished = true;
          if (committed) {
            resources = oldResources;
          }
          // UI 在 flushSync 中调用 cancel 的同步部分，先恢复旧视图再释放候选资源。
          if (alive && generation === token) publish(committed ? previous : {...previous, busy: true});
          finishing = (async () => {
            if (pending === approval) pending = undefined;
            if (alive && generation === token && !committed) publish(previous);
          })();
          return finishing;
        },
        complete() {
          if (finished) return finishing;
          finished = true;
          if (pending === approval) pending = undefined;
          if (!alive || generation !== token) return;
          if (isRecovery) {
            resources = nextResources;
            startup = undefined;
            recoveryNavigation = undefined;
            publish({...recoverySnapshot!, busy: false, loading: null});
            if (nextResources !== oldResources) finishing = release(oldResources);
            return finishing;
          }
          if (needsStart && nextSession) {
            launch({target: nextSession, previous, previousLocation: request.from,
              restoreByBack: request.kind === "open" && request.history !== "reset",
              previousResources: oldResources, token});
            // Navigation has already committed and flushed the workbench view.
            // Do not keep UI navigation in-flight while project participants load;
            // failure recovery must be able to navigate back to the welcome page.
            return;
          } else {
            publish({session: nextSession, active: request.to.id === options.editorPage && nextSession !== null,
              busy: false, loading: null});
            if (nextResources !== oldResources) {
              resources = nextResources;
              finishing = release(oldResources);
              return finishing;
            }
          }
          return finishing;
        },
      };
      pending = approval;
      return approval;
    } catch (error) {
      if (alive && generation === token) publish(previous);
      throw error;
    }
  }

  const service: WorkbenchService = {
    openProject(project) {
      checkReady();
      if (snapshot.busy) return Promise.resolve(false);
      return ui.openPage(options.editorPage, {project: projectValue(project)});
    },
    closeProject() {
      checkReady();
      if (snapshot.busy) return snapshot.loading?.error ? service.returnProject() : Promise.resolve(false);
      if (!snapshot.session) return Promise.resolve(true);
      return ui.openPage(options.welcomePage, undefined, {history: "reset"});
    },
    retryProject() {
      checkReady();
      if (!snapshot.loading?.error || !startup || !snapshot.busy) return Promise.resolve(false);
      const failed = startup;
      const target = Object.freeze({...failed.target, id: `workbench-session-${++sequence}`});
      const retry: Startup = {...failed, target, token: generation};
      flushView(() => publish({session: target, active: true, busy: true,
        loading: loadingState(0, participants.size, [...participants.values()][0]?.label ?? null)}));
      launch(retry);
      return Promise.resolve(true);
    },
    returnProject() {
      checkReady();
      if (!snapshot.loading?.error || !startup || !snapshot.busy) return Promise.resolve(false);
      const failed = startup;
      return restorePreviousRoute(failed.previousLocation, failed.previous, failed.previousResources, failed.restoreByBack);
    },
    getSnapshot() { checkActive(); return snapshot; },
    subscribe(listener) {
      checkActive();
      if (typeof listener !== "function") throw new TypeError("Workbench listener must be a function.");
      // 每次订阅独立，旧取消函数不会移除一次后续订阅。
      const subscription = () => listener();
      listeners.add(subscription);
      return () => { listeners.delete(subscription); };
    },
    registerParticipant(participant) {
      checkActive();
      if (ready) throw new Error("Workbench participants must register before pluginsReady.");
      if (!participant || typeof participant.id !== "string" || !participant.id.trim() || typeof participant.start !== "function") {
        throw new TypeError("Workbench participant requires an id and start function.");
      }
      if (participants.has(participant.id)) throw new Error(`Workbench participant '${participant.id}' is already registered.`);
      if (participant.label !== undefined && (typeof participant.label !== "string" || !participant.label.trim())) {
        throw new TypeError("Workbench participant label must be a non-empty string when provided.");
      }
      const entry = Object.freeze({id: participant.id, ...(participant.label ? {label: participant.label} : {}), start: participant.start});
      participants.set(entry.id, entry);
      let removal: Promise<void> | undefined;
      return () => removal ??= (async () => {
        if (!alive || participants.get(entry.id) !== entry) return;
        if (ready) {
          // 首版撤销贡献先停止整棵 UI，不能在视图仍使用资源时热移除。
          revoking++;
          publish({...snapshot, busy: true});
          const errors: unknown[] = [];
          try { options.stopView(); } catch (error) { errors.push(error); }
          generation++;
          await preparing?.catch(() => {});
          await starting?.catch(() => {});
          await shuttingDown?.catch(() => {});
          try { await pending?.cancel?.(); } catch (error) { errors.push(error); }
          try { await release(resources); } catch (error) { errors.push(error); }
          finally {
            resources = [];
            participants.delete(entry.id);
            revoking--;
            publish({session: null, active: false, busy: false, loading: null});
          }
          if (errors.length) throw Object.assign(new Error("Workbench participant failed to revoke."), {errors});
        }
        participants.delete(entry.id);
      })();
    },
  };

  return {
    service: Object.freeze(service),
    start() { checkActive(); ready = true; },
    prepareNavigation(request: UiNavigationRequest): Promise<boolean | UiNavigationApproval> {
      checkReady();
      const recovering = !!recoveryNavigation && sameLocation(request.to, recoveryNavigation.location);
      if (snapshot.busy && !recovering) return Promise.resolve(false);
      const previous = snapshot;
      publish({...snapshot, busy: true});
      const operation = buildApproval(request, generation, previous);
      preparing = operation;
      void operation.finally(() => { if (preparing === operation) preparing = undefined; }).catch(() => {});
      return operation;
    },
    shutdown(): Promise<boolean> {
      checkReady();
      if (shuttingDown) return shuttingDown;
      const pendingStartup = snapshot.busy ? startup : undefined;
      if (snapshot.busy && !pendingStartup) return Promise.resolve(false);
      const previous = pendingStartup?.previous;
      const token = pendingStartup ? ++generation : generation;
      if (pendingStartup) {
        // Detach the candidate view before cancelling startup so any participation
        // returned by an in-flight start can be released without racing a mounted view.
        flushView(() => publish({...pendingStartup.previous, busy: true, loading: null}));
        startup = undefined;
      } else {
        publish({...snapshot, busy: true});
      }
      let recoveryFailed = false;
      let viewStopped = false;
      const operation = (async () => {
        try {
          if (pendingStartup) {
            await starting?.catch(() => {});
            resources = pendingStartup.previousResources;
          }
          if (!await allowed("shutdown", token)) {
            if (pendingStartup) {
              const restored = await restorePreviousRoute(pendingStartup.previousLocation,
                pendingStartup.previous, pendingStartup.previousResources, pendingStartup.restoreByBack);
              if (!restored) {
                recoveryFailed = true;
                exposeRecoveryError(pendingStartup,
                  "关闭检查未通过，且无法返回原页面。请重试启动，或再次返回原项目。");
              }
            }
            return false;
          }
          valid(token);
          options.stopView();
          viewStopped = true;
          publish({session: null, active: false, busy: true, loading: null});
          await release(resources);
          resources = [];
          return true;
        } catch (error) {
          if (pendingStartup && alive && generation === token && previous && !viewStopped) {
            let restored = false;
            try { restored = await restorePreviousRoute(pendingStartup.previousLocation,
              pendingStartup.previous, pendingStartup.previousResources, pendingStartup.restoreByBack); }
            catch { /* Keep the original save error. */ }
            if (!restored) {
              recoveryFailed = true;
              const detail = error instanceof Error ? error.message : String(error);
              exposeRecoveryError(pendingStartup, `关闭检查失败：${detail}。请重试启动，或再次返回原项目。`);
            } else {
              flushView(() => publish({...previous, busy: false, loading: null}));
            }
          }
          throw error;
        } finally {
          if (alive && generation === token && !recoveryFailed) {
            if (pendingStartup && snapshot.session === previous?.session && snapshot.busy) {
              flushView(() => publish({...snapshot, busy: false, loading: null}));
            } else publish({...snapshot, busy: false});
          }
        }
      })();
      shuttingDown = operation;
      void operation.finally(() => { if (shuttingDown === operation) shuttingDown = undefined; }).catch(() => {});
      return operation;
    },
    dispose(): Promise<void> {
      if (stopping) return stopping;
      alive = false;
      generation++;
      stopping = (async () => {
        const errors: unknown[] = [];
        try {
          try { options.stopView(); } catch (error) { errors.push(error); }
          await preparing?.catch(() => {});
          await starting?.catch(() => {});
          await shuttingDown?.catch(() => {});
          try { await pending?.cancel?.(); } catch (error) { errors.push(error); }
          try { await release(resources); } catch (error) { errors.push(error); }
        } finally {
          resources = [];
          participants.clear();
          listeners.clear();
        }
        if (errors.length) throw Object.assign(new Error("Workbench failed to dispose."), {errors});
      })();
      return stopping;
    },
  };
}
