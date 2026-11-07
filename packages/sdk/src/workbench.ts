import {createServiceKey} from "./ServiceKey.js";
import type {PluginAsyncContribution} from "./Plugin.js";

/** 已由项目管理功能打开的项目；工作台不负责创建目录或维护最近项目。 */
export type WorkbenchProject = {
  readonly id: string;
  readonly name: string;
  readonly path: string;
};

/** 一次项目编辑环境；关闭后再打开同一项目也会生成新的 id。 */
export type WorkbenchSession = {
  readonly id: string;
  readonly project: WorkbenchProject;
};

/** 稳定、不可变的快照；暂时离页保留 session，busy 期间暂停新的业务修改。 */
export type WorkbenchSnapshot = {
  readonly session: WorkbenchSession | null;
  readonly active: boolean;
  readonly busy: boolean;
  /** Startup step status; errors keep the workspace locked until retry or return. */
  readonly loading: WorkbenchLoading | null;
};

export type WorkbenchLoading = Readonly<{
  completed: number;
  total: number;
  /** Optional user-facing label supplied by the participant, never its internal ID. */
  current: string | null;
  error: Readonly<{participantId: string; message: string}> | null;
}>;

export type LeaveReason = "suspend" | "switch" | "close" | "shutdown" | "unload";
type Awaitable<T> = T | Promise<T>;

/** 每次 start 返回独立资源；检查可以保存数据，dispose 在停止视图使用后执行。 */
export type WorkbenchParticipation = {
  beforeLeave?(reason: LeaveReason): Awaitable<boolean>;
  dispose(): Awaitable<void>;
};

/** 应用启动时登记一次，按登记顺序随每个项目启动，按逆序结束。 */
export type WorkbenchParticipant = {
  readonly id: string;
  readonly label?: string;
  /** 创建失败时参与者自行释放尚未返回的部分资源。 */
  readonly start: (session: WorkbenchSession) => Awaitable<WorkbenchParticipation>;
};

export type WorkbenchService = {
  openProject(project: WorkbenchProject): Promise<boolean>;
  closeProject(): Promise<boolean>;
  retryProject(): Promise<boolean>;
  returnProject(): Promise<boolean>;
  getSnapshot(): WorkbenchSnapshot;
  subscribe(listener: () => void): () => void;
  /** 启动期登记，句柄须由贡献插件用 context.track 关联；在线停用只检查和释放此参与者的会话资源。 */
  registerParticipant(participant: WorkbenchParticipant): PluginAsyncContribution;
};

/** 一个应用装配一个工作台；业务插件不依赖具体工作台实现。 */
export const workbenchKey = createServiceKey<WorkbenchService>("app/workbench");
