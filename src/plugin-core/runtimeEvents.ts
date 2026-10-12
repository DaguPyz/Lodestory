import {createEventKey} from "@lodestory/sdk";

/**
 * 初始插件全部激活、能力和订阅全部生效后，仅由 EngineCore.start 发送一次；插件不能从 context.emit 发布此事件。
 * 只表示插件装配完成；响应者自行执行启动逻辑，不表示 UI 已完成渲染。
 * 当前仅定义共享契约，mountAll 不会自动发送这个通知。
 */
export const pluginsReady = createEventKey<void>("runtime/plugins-ready");
