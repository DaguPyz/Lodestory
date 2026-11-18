import type {MessageCatalog} from "@lodestory/sdk/i18n";

export const writingStatusMessages = {
  en: {
    "写作状态": "Writing status",
    "已保存": "Saved",
    "等待保存…": "Waiting to save…",
    "正在保存…": "Saving…",
    "保存失败": "Couldn’t save",
    "未打开文稿": "No manuscript open",
    "统计失败": "Couldn’t count characters",
    "统计中…": "Counting…",
    "文稿 {details}": "Manuscript · {details}",
    "{count} 字": {one: "{count} character", other: "{count} characters"},
  },
} satisfies MessageCatalog;
