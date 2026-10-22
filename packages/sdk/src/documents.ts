import {createServiceKey} from "./ServiceKey.js";
import {createEventKey, type EventKey} from "./EventKey.js";

export type DocumentSaveState = "saved" | "pending" | "saving" | "error";

/** 一次工作台会话内打开的文档；ID 由服务分配，路径相对于项目根目录。 */
export type OpenDocument = Readonly<{
  id: string;
  path: string;
  fileName: string;
  content: string;
  saveState: DocumentSaveState;
  saveError: string | null;
}>;

/** 深只读、稳定快照；目录列表、对话框、光标和布局不属于文档状态。 */
export type DocumentSnapshot = Readonly<{
  documents: readonly OpenDocument[];
  activeId: string | null;
  openingPath: string | null;
  creating: boolean;
  /** A project-relative path being deleted; only one deletion may run at a time. */
  deletingPath: string | null;
  blocked: boolean;
  /** 操作错误；单个文档的保存错误位于其 saveError。 */
  error: string | null;
}>;

/** 由文档插件拥有生命周期，消费者不能创建、销毁或绕过会话检查。 */
export type DocumentWorkspace = {
  getSnapshot(): DocumentSnapshot;
  subscribe(listener: () => void): () => void;
  /** 已打开时复用；迟到的打开结果不得抢回更新的选择。 */
  open(path: string): Promise<boolean>;
  /** 创建后加入打开列表；返回实际文件名和路径，失败返回 null。 */
  create(parentPath: string, name: string): Promise<OpenDocument | null>;
  /** 在现有目录下创建单层子目录；不覆盖或递归创建。 */
  createDirectory(parentPath: string, name: string): Promise<string | null>;
  /** 将当前文档内容另存为同目录的新文档，并在成功后打开新文档。 */
  saveAs(documentId: string, fileName: string, content: string): Promise<void>;
  /** 删除项目内的受支持文档；有未保存更改时须显式确认丢弃。 */
  deleteDocument(path: string, options?: { discardChanges?: boolean }): Promise<boolean>;
  select(id: string): boolean;
  /** 更新共享内容，并由文档插件安排自动保存。 */
  update(id: string, content: string): boolean;
  /** 先保存再关闭，保存失败时保留并选择该文档。 */
  close(id: string): Promise<boolean>;
  /** 按传入顺序逐个关闭调用时的文档；失败或会话不可操作时停止，保留剩余文档。不包含之后新开的文档。 */
  closeMany(ids: readonly string[]): Promise<boolean>;
  save(id: string): Promise<boolean>;
  saveAll(): Promise<boolean>;
  clearError(): void;
};

export type DocumentsService = {
  /** 只读取已有会话；会话结束后返回 null，同一会话始终返回同一对象。 */
  getWorkspace(sessionId: string): DocumentWorkspace | null;
};

export type DocumentCreateRequest = Readonly<{sessionId: string; parentPath?: string}>;
export type DocumentRevealRequest = Readonly<{sessionId: string; documentId: string}>;

/** 一个应用装配一个文档管理实现；不依赖具体正文、文件树或布局。 */
export const documentsKey = createServiceKey<DocumentsService>("app/documents");
/** UI 请求新建交互，由装配的创建交互提供者展示对话框，不直接创建文件。 */
export const documentCreateRequested: EventKey<DocumentCreateRequest> = createEventKey("app/documents/create-requested");
/** 文档状态已提交后请求界面展示；接收方须核对当前 sessionId。 */
export const documentRevealRequested: EventKey<DocumentRevealRequest> = createEventKey("app/documents/reveal-requested");
