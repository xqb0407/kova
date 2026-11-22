/** 更新日志的数据形状：由 scripts/build-changelog.mjs 从 CHANGELOG.md 生成。 */

export type ChangelogSection = {
  /** 原始分区标题（Added / Changed / Fixed…），展示层负责本地化 */
  title: string;
  /** 条目正文：保留行内 Markdown（粗体、行内代码、链接） */
  items: string[];
};

export type ChangelogEntry = {
  version: string;
  /** 发版日期（CHANGELOG 里的 `YYYY-MM-DD`；缺失为 null） */
  date: string | null;
  /** 版本标题与第一个分区之间的导语（如“首个开源正式版。”） */
  intro: string | null;
  sections: ChangelogSection[];
};
