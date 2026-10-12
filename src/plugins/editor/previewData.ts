// UI preview data only. No novel directory, file content or Git history is accessed.
// Word counts and the saved indicator are presentation samples, not live file state.
export type PreviewDocument = {
  id: string;
  fileName: string;
  title: string;
  context: string;
  kind: "chapter" | "outline" | "reference";
  paragraphs: string[];
  wordCount: number;
};

export type PreviewTreeNode = {
  id: string;
  name: string;
  children?: PreviewTreeNode[];
  documentId?: string;
  open?: boolean;
};

export const previewDocuments: PreviewDocument[] = [
  {
    id: "rain",
    fileName: "03 雨夜来客.md",
    title: "第三章 雨夜来客",
    context: "第一卷 · 渡口",
    kind: "chapter",
    paragraphs: [
      "雨落在青石阶上，像一封迟迟没有拆开的信。沈砚收起伞，望向渡口尽头那盏摇晃的灯。",
      "河面没有船，只有一层薄雾缓慢地移动。风从水上吹来，带着潮湿的木头气味。",
      "“你在等谁？”身后有人问。",
      "他回过头。一个穿深灰长衣的女子站在雨里，手中握着一只旧信封。信封的边角已经浸湿，名字却仍然清晰。",
      "沈砚看见了自己的名字。",
      "那一刻，远处的钟声恰好响了第三下。",
    ],
    wordCount: 3286,
  },
  {
    id: "fog",
    fileName: "01 雾起.md",
    title: "第一章 雾起",
    context: "第一卷 · 渡口",
    kind: "chapter",
    paragraphs: [
      "清晨的渡口还没有醒。雾从河心升起，把远处的青山和岸边的屋檐连成一片。",
      "沈砚推开木门，取下挂在墙上的船桨。门外，一盏尚未熄灭的灯安静地亮着。",
    ],
    wordCount: 1804,
  },
  {
    id: "ferry",
    fileName: "02 渡口.md",
    title: "第二章 渡口",
    context: "第一卷 · 渡口",
    kind: "chapter",
    paragraphs: [
      "午后的河水很慢，像是也在等待一个迟到的人。",
      "沈砚把船系在岸边，听见青石阶上传来细碎的脚步声。有人停在身后，却迟迟没有开口。",
    ],
    wordCount: 2150,
  },
  {
    id: "outline",
    fileName: "故事大纲.md",
    title: "故事大纲",
    context: "长夜行舟 · 创作资料",
    kind: "outline",
    paragraphs: [
      "第一卷 · 渡口",
      "一封在雨夜送达的旧信，打破了沈砚平静的生活。信中留下的线索，将他引向一段被遗忘的往事。",
      "第二卷 · 远行",
      "沈砚与顾青禾离开渡口，沿河寻找信件的来处。旅途中的每一次相遇，都使过去逐渐清晰。",
    ],
    wordCount: 729,
  },
  {
    id: "people",
    fileName: "人物设定.md",
    title: "人物设定",
    context: "长夜行舟 · 创作资料",
    kind: "reference",
    paragraphs: [
      "沈砚",
      "二十七岁，青石渡口的渡船人。寡言，习惯在黄昏前点亮船头的灯。",
      "顾青禾",
      "携信而来的旅人。深灰长衣，随身带着一枚旧铜铃。",
    ],
    wordCount: 486,
  },
];

export const previewTree: PreviewTreeNode[] = [
  {
    id: "manuscripts", name: "正文", open: true,
    children: [
      { id: "volume-one", name: "第一卷", open: true, children: [
        { id: "file-fog", name: "01 雾起.md", documentId: "fog" },
        { id: "file-ferry", name: "02 渡口.md", documentId: "ferry" },
        { id: "file-rain", name: "03 雨夜来客.md", documentId: "rain" },
      ] },
      { id: "volume-two", name: "第二卷", children: [] },
    ],
  },
  { id: "outlines", name: "大纲", children: [{ id: "file-outline", name: "故事大纲.md", documentId: "outline" }] },
  { id: "people", name: "人物", children: [{ id: "file-people", name: "人物设定.md", documentId: "people" }] },
  { id: "world", name: "世界观", children: [] },
  { id: "materials", name: "素材", children: [] },
];

export const previewPeople = [
  { name: "沈砚", description: "二十七岁，青石渡口的渡船人。寡言，习惯在黄昏前点亮船头的灯。" },
  { name: "顾青禾", description: "携信而来的旅人。深灰长衣，随身带着一枚旧铜铃。" },
];
