import {createServiceKey} from "./ServiceKey.js";

import type {ThemeColorId} from "./themeColors.js";

/**
 * 标准颜色名称集合，例如 `surface.content`、`text.primary`。
 * 作者填写配色、UI 实现读取角色颜色时使用；由标准登记表生成，不能自行增加组件专属名称。
 */
export type {ThemeColorId} from "./themeColors.js";

/**
 * 主题的明暗属性：`dark` 表示深色外观，`light` 表示浅色外观。
 * 用于选择标准缺省值、匹配系统外观和协调原生窗口；具体主题仍按 ID 区分。
 * 多套主题可以具有同一属性，明暗不形成主题层级，也不限制每个局部表面的颜色。
 */
export type ThemeType = "dark" | "light";

/**
 * 作者编写主题，或贡献插件调用 `registerTheme` 时提供的配色定义。
 * 内置与自定义主题使用同一结构；允许只填写部分颜色，由管理器解析成 `ResolvedTheme`。
 */
export type ThemeDefinition = Readonly<{
    /** 为 JSON 编辑器提供 Schema 提示；宿主不按此地址联网加载或执行校验器。 */
    $schema?: string;
    /** 主题文件结构版本，当前固定为 1；与应用版本、主题包发行版本分别管理。 */
    schemaVersion: 1;
    /**
     * 登记、选择和保存偏好时使用的稳定身份，例如 `example.ink.dark`。
     * 格式为“发行者.包名.主题名”，各段以小写字母开头，可含数字和分词短横线，总长不超过 144 字符。
     * 改展示名称时保留 ID；同一目录中不能重复登记此 ID。
     */
    id: string;
    /** 设置页等界面显示的名称；1 至 80 字符，不得全为空白或含控制字符，不承担身份匹配。 */
    name: string;
    /** 供管理器补齐缺省颜色、匹配系统策略和设置原生明暗外观；用户选择依然使用 id。 */
    type: ThemeType;
    /**
     * 作者按视觉用途覆盖的颜色表，例如 `{ "surface.content": "#171A23" }`。
     * 仅接受标准名称与 #RRGGBB / #RRGGBBAA；非完全不透明色只用于登记表允许的角色。
     * 缺项按 type 使用标准缺省值及引用，空对象表示全部采用缺省值；不继承另一主题。
     */
    colors: Readonly<Partial<Record<ThemeColorId, string>>>;
}>;

/** 主题管理插件使用的选择配置，只引用主题 ID，不携带配色或区分主题来源。 */
export type ThemeConfig = Readonly<{
    /** 没有有效偏好时首次选择的主题 ID；初始插件登记完成后必须能在目录中找到。 */
    defaultThemeId: string;
    /** 所选主题不可用时按明暗属性回退的主题 ID，同时作为默认系统槽位；须分别匹配 dark/light。 */
    fallbackThemeIds: Readonly<Record<ThemeType, string>>;
}>;

/**
 * 用户希望如何选择主题，供设置页提交、偏好保存及窗口同步使用。
 * 它记录选择意图；要知道当前实际显示哪套配色，应读取 `ThemeSnapshot.theme`。
 * 从存储恢复时，所选 ID 可能暂未登记，因此意图与实际回退主题可以不同。
 */
export type ThemePreference =
    | Readonly<{
        /** 用户指定一套固定主题时使用；系统明暗变化不改变此选择。 */
        mode: "fixed";
        /** 固定选择的主题 ID，例如 `example.ink.dark`，不是 dark / light 属性值。 */
        themeId: string;
    }>
    | Readonly<{
        /** 用户选择“跟随系统”时使用；保存两个主题 ID，不创建第三套配色。 */
        mode: "system";
        /** 系统为浅色时选择的主题 ID；对应主题的 type 必须为 light，可以是自定义主题。 */
        lightThemeId: string;
        /** 系统为深色时选择的主题 ID；对应主题的 type 必须为 dark，可以是自定义主题。 */
        darkThemeId: string;
    }>;

/**
 * 管理器校验并补齐颜色后生成的不可变主题记录，用于实际绘制或主题预览。
 * 内置与自定义主题使用同一种结果；调用方读取它，不需要自行补色或重复解析默认引用。
 */
export type ResolvedTheme = Readonly<{
    /** 原主题的稳定 ID；用于目录选中判断、预览标识及与用户偏好匹配。 */
    id: string;
    /** 原主题的展示名称；用于主题卡片、当前主题说明等界面文案。 */
    name: string;
    /** 原主题的明暗属性；用于筛选系统策略的候选项及协调原生窗口外观。 */
    type: ThemeType;
    /** 全部标准角色的最终色值；Canvas 等非 CSS 绘制可直接按角色读取，不再存在缺项。 */
    colors: Readonly<Record<ThemeColorId, string>>;
    /**
     * DOM 应用和独立预览所用的完整 CSS 自定义属性表，键如 `--ui-surface-workspace`。
     * 包含角色映射、组合阴影与 `--ui-color-scheme`，因此值不全是单个颜色字面量。
     */
    cssVariables: Readonly<Record<string, string>>;
}>;

/**
 * 一次读取主题目录、用户偏好、实际配色与错误状态的不可变快照。
 * 设置页据此渲染选项与提示，其他 UI 据此绘制；配合 subscribe 使用可持续跟进变化。
 */
export type ThemeSnapshot = Readonly<{
    /** 用户保存或本次会话选择的意图；所选主题暂不可用时仍保留，便于稍后恢复。 */
    preference: ThemePreference;
    /** 当前实际主题；初始登记期间或目录为空时为 null，UI 需处理空状态。所选主题缺失时为回退结果。 */
    theme: ResolvedTheme | null;
    /** 已登记主题的平级列表，供设置页列出选项和预览；同时包含内置主题及自定义贡献。 */
    themes: readonly ResolvedTheme[];
    /** 配置的回退主题 ID，供设置页初始化系统槽位；对应主题也可能被普通贡献者撤销。 */
    fallbackThemeIds: Readonly<Record<ThemeType, string>>;
    /**
     * 当前请求但不可用的主题 ID，供界面解释回退原因；正常时为 null。
     * 系统策略只报告当前明暗槽位的结果，不表示另一个槽位也已可用。
     */
    unavailableThemeId: string | null;
    /** 偏好保存失败或收到其他窗口广播的保存失败状态；会话内仍应用选择，设置页可提示并调用 retry。 */
    persistenceError: boolean;
    /** 原生窗口外观同步失败；界面配色仍可使用，设置页可提示并调用 retry。 */
    windowError: boolean;
}>;

/**
 * 主题管理器向设置页、配色贡献者及其他 UI 插件提供的共享能力。
 * 消费插件在 requires 中声明 themeKey，再通过 context.get(themeKey) 获取服务。
 * 页面负责读取和提交选择；贡献者负责登记与撤销自己的主题，平台同步由管理器处理。
 */
export type ThemeService = {
    /**
     * 初次渲染或收到订阅通知后读取当前状态。
     * 快照内容未变时返回相同对象，可作为 React useSyncExternalStore 的 getSnapshot。
     */
    getSnapshot(): ThemeSnapshot;

    /**
     * 订阅目录、选择、实际主题或错误状态变化，供设置页和自定义绘制刷新。
     * 登记订阅时不立即回调；变化通知不携带参数，回调中通过 getSnapshot 读取新状态。
     * @param listener 同步执行的变化通知函数，不应抛出异常或执行耗时工作。
     * @returns 取消此监听函数订阅的函数；组件退出或插件停用时调用，可重复调用。
     */
    subscribe(listener: () => void): () => void;

    /**
     * 所有主题贡献插件（包括内置）在激活或运行中加载配色时，通过此入口加入统一目录。
     * 登记会校验并复制解析数据，不主动修改用户偏好；若偏好正等待该 ID，则恢复应用它。
     * 当前接口不安装或持久化主题包，也未执行运行时 B 对比度警告；每次启动须重新登记。
     * @param theme 作者提供的主题定义，内置与自定义配色使用相同结构。
     * @returns 撤销本次登记的函数；贡献者停用时调用，可重复调用，且不影响后来同 ID 的新登记。
     * 撤销当前所选主题会触发回退并保留原偏好，重新登记后自动恢复；撤销最后一项后 theme 为 null。
     * @throws 定义格式、字段、颜色或默认引用无效，或 ID 已被登记时抛出错误。
     */
    registerTheme(theme: ThemeDefinition): () => void;

    /**
     * 用户选择主题卡片或修改系统策略槽位时调用，保存并同步偏好；界面启动后立即应用配色。
     * 若在初始插件登记期间调用，实际配色会等到根视图准备阶段再应用。
     * 保存失败不撤销本次会话选择；原生同步异步完成，其结果通过快照中的错误状态报告。
     * @param preference 固定主题 ID，或系统浅色与深色时各自使用的主题 ID。
     * @throws 偏好结构无效、引用的 ID 未登记，或系统槽位与主题明暗属性不匹配时抛出错误。
     */
    setPreference(preference: ThemePreference): void;

    /**
     * 设置页在 persistenceError 或 windowError 为 true 时提供的重试动作。
     * 重新保存当前 preference 并重试原生窗口同步，结果通过订阅快照观察；不更换用户选择。
     * 不负责重新安装或加载缺失主题，所选 ID 暂不可用时仍保留原偏好。
     */
    retry(): void;
};

/**
 * 主题管理服务的共享能力标识；管理器声明 provides，消费插件声明 requires 并调用 context.get。
 * 所有参与方必须从 SDK 导入同一个 themeKey，不能用相同字符串自行创建另一标识。
 * 配色贡献者通过该服务登记主题，不替换全局管理服务；其停用时撤销自己的登记和订阅。
 */
export const themeKey = createServiceKey<ThemeService>("app/theme");
