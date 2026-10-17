import type {LeaveReason, WorkbenchParticipant, WorkbenchParticipation, WorkbenchProject, WorkbenchService, WorkbenchSnapshot} from "@lodestory/sdk/workbench";
import type {UiNavigationApproval, UiNavigationRequest, UiService} from "@lodestory/sdk/ui";

type Resource = {value: WorkbenchParticipation; disposed: boolean; disposal?: Promise<void>};
type Registration = {id: string; start: WorkbenchParticipant["start"]};
type Options = {editorPage: string; welcomePage: string; stopView: () => void};

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

/** 应用级协调器；资源在导航准备阶段创建，全部守卫同意后才提交项目身份。 */
export function createWorkbenchStore(ui: UiService, options: Options) {
  const participants = new Map<string, Registration>();
  const listeners = new Set<() => void>();
  let snapshot: WorkbenchSnapshot = Object.freeze({session: null, active: false, busy: false});
  let resources: Resource[] = [];
  let alive = true;
  let ready = false;
  let sequence = 0;
  let generation = 0;
  let revoking = 0;
  let preparing: Promise<boolean | UiNavigationApproval> | undefined;
  let shuttingDown: Promise<boolean> | undefined;
  let pending: UiNavigationApproval | undefined;
  let stopping: Promise<void> | undefined;

  function checkActive() {
    if (!alive) throw new Error("Workbench service is no longer active.");
  }
  function checkReady() {
    checkActive();
    if (!ready) throw new Error("Workbench is not ready before pluginsReady.");
  }
  function publish(next: WorkbenchSnapshot) {
    if (!alive) return;
    if (revoking) next = {...next, busy: true};
    if (next.session === snapshot.session && next.active === snapshot.active && next.busy === snapshot.busy) return;
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

  async function buildApproval(request: UiNavigationRequest, token: number): Promise<boolean | UiNavigationApproval> {
    const previous = {...snapshot, busy: false};
    const oldResources = resources;
    let nextSession = snapshot.session;
    let nextResources = oldResources;
    const created: Resource[] = [];
    let reason: LeaveReason | undefined;
    try {
      if (request.to.id === options.editorPage) {
        const input = (request.to.params as {project?: unknown} | null)?.project ?? snapshot.session?.project;
        const project = projectValue(input);
        const same = snapshot.session?.project.id === project.id && snapshot.session.project.path === project.path;
        if (!same) {
          if (snapshot.session) reason = "switch";
          nextSession = Object.freeze({id: `workbench-session-${++sequence}`, project});
          nextResources = created;
        }
      } else if (request.to.id === options.welcomePage && snapshot.session) {
        reason = "close";
        nextSession = null;
        nextResources = [];
      } else if (snapshot.session && request.from?.id === options.editorPage) {
        reason = "suspend";
      }

      if (reason && !await allowed(reason, token)) {
        publish({...previous, busy: false});
        return false;
      }
      valid(token);
      if (nextResources === created && nextSession) {
        for (const entry of participants.values()) {
          const value = await entry.start(nextSession);
          if (value && typeof value.dispose === "function") created.push({value, disposed: false});
          if (!value || typeof value.dispose !== "function" || (value.beforeLeave !== undefined && typeof value.beforeLeave !== "function")) {
            throw new TypeError(`Workbench participant '${entry.id}' must return a disposable participation.`);
          }
          valid(token);
        }
      }

      let committed = false;
      let finished = false;
      let finishing: Promise<void> | undefined;
      const approval: UiNavigationApproval = {
        commit() {
          valid(token);
          committed = true;
          resources = nextResources;
          publish({session: nextSession, active: request.to.id === options.editorPage && nextSession !== null, busy: true});
        },
        cancel() {
          if (finished) return finishing;
          finished = true;
          if (committed) resources = oldResources;
          // UI 在 flushSync 中调用 cancel 的同步部分，先恢复旧视图再释放候选资源。
          if (alive && generation === token) publish({...previous, busy: true});
          finishing = (async () => {
            try { await release(created); }
            finally {
              if (pending === approval) pending = undefined;
              if (alive && generation === token) publish(previous);
            }
          })();
          return finishing;
        },
        complete() {
          if (finished) return finishing;
          finished = true;
          finishing = (async () => {
            try { if (nextResources !== oldResources) await release(oldResources); }
            finally {
              if (pending === approval) pending = undefined;
              if (alive && generation === token) publish({...snapshot, busy: false});
            }
          })();
          return finishing;
        },
      };
      pending = approval;
      return approval;
    } catch (error) {
      try { await release(created); }
      finally { if (alive && generation === token) publish(previous); }
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
      if (snapshot.busy) return Promise.resolve(false);
      if (!snapshot.session) return Promise.resolve(true);
      return ui.openPage(options.welcomePage, undefined, {history: "reset"});
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
      const entry = Object.freeze({id: participant.id, start: participant.start});
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
          await shuttingDown?.catch(() => {});
          try { await pending?.cancel?.(); } catch (error) { errors.push(error); }
          try { await release(resources); } catch (error) { errors.push(error); }
          finally {
            resources = [];
            participants.delete(entry.id);
            revoking--;
            publish({session: null, active: false, busy: false});
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
      if (snapshot.busy) return Promise.resolve(false);
      publish({...snapshot, busy: true});
      const operation = buildApproval(request, generation);
      preparing = operation;
      void operation.finally(() => { if (preparing === operation) preparing = undefined; }).catch(() => {});
      return operation;
    },
    shutdown(): Promise<boolean> {
      checkReady();
      if (snapshot.busy) return Promise.resolve(false);
      const token = generation;
      publish({...snapshot, busy: true});
      const operation = (async () => {
        try {
          if (!await allowed("shutdown", token)) return false;
          valid(token);
          options.stopView();
          publish({session: null, active: false, busy: true});
          await release(resources);
          resources = [];
          return true;
        } finally { if (alive && generation === token) publish({...snapshot, busy: false}); }
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
