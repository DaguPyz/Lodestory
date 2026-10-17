/** 编辑插件自己拥有的内容标识；布局实现只按用途处理，不依赖这些 ID。 */
export const editorContentIds = {
  main: "editor.main",
  auxiliary: "editor.auxiliary",
  actions: "editor.actions",
  status: "editor.status",
} as const;
