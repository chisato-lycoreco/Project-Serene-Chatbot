/**
 * core/lexicon.js — 情绪分类用的词表：默认中立，人格可以加自己的。
 *
 * 为什么要有这一层：`classifyMessage` 原来把「老婆、亲亲、宝贝、乖、听话、吃醋」
 * 直接烧在正则里。那等于**默认每个用户都是恋人**——换一个人格、换一个用户，
 * 同一句话还是会被读成同一种关系。
 *
 * 现在分成两份：
 *   - 默认词表只放「换谁都成立」的说法（关心、道歉、狠话、玩笑……）；
 *   - 关系性的说法（爱称、哄人的口头禅、吃醋）由人格在 `lexicon` 里显式给，
 *     不给就是没有——她不会替用户脑补一段关系。
 *
 * 人格侧写法（`personas/*.json`）：
 *
 *   "lexicon": {
 *     "address": ["小满"],                       // 字面量，会转义
 *     "affection": ["宝贝", "老婆"],             // 正则片段，会拼进分类
 *     "coax": ["乖乖", "听话"],
 *     "jealousy": ["女同事", "前女友"]
 *   }
 *
 * 每个键对应 `EVENT_EFFECTS` 里的一个事件；`address` 是例外，只认称呼。
 * 拼出来的正则不合法时抛错——人格写错了应该在加载时就知道，而不是静默失效。
 */

/** 默认词表：只放不依赖具体关系的说法。空数组 = 默认不猜这一类。 */
export const DEFAULT_PATTERNS = Object.freeze({
  affection: ["喜欢你", "爱你", "想你了", "想你", "抱抱", "可爱", "好看", "漂亮", "温柔", "辛苦", "夸你"],
  care: ["累不累", "吃没吃", "吃饭了吗", "早点睡", "休息", "别熬夜", "喝水", "照顾", "冷不冷", "热不热"],
  conflict: ["滚", "分手", "受够了", "你根本", "有病", "不想理你", "你走吧", "讨厌你"],
  scold: ["闭嘴", "烦死", "别烦我", "凭什么", "懒得", "随便你", "你懂什么"],
  coax: ["别生气", "别气了", "不气了", "消消气", "好啦好啦", "我哄你", "哄哄你"],
  repair: ["对不起", "抱歉", "我错了", "是我不好", "不该凶", "原谅我"],
  goodnight: ["晚安", "睡了", "去睡", "睡觉", "困了", "躺下"],
  humor: ["哈哈", "笑死", "搞笑", "绷不住", "离谱", "绝了", "乐死", "梗"],
  rejection: [
    "我(还|这|正)?在忙",
    "这(会|会儿)在忙",
    "忙完(再)?(说|聊|回)",
    "没空",
    "先不聊",
    "回头说",
    "晚点(再)?(说|聊|回)",
    "等会(儿)?再说",
    "别闹",
  ],
  share: ["我今天", "我刚", "我跟你说", "你猜", "分享", "听歌", "看剧", "游戏", "工作", "项目", "股票", "直播"],
  /**
   * 吃醋默认**不猜**。
   *
   * 「对方提到别的女性」是关系设定，不是情绪机制。人格想让她会吃醋，
   * 就在自己的 lexicon 里写词；不写，这句话就只是普通一句话。
   */
  jealousy: [],
});

/** 词表里允许出现的键（也是事件名）。`address` 单独处理。 */
export const LEXICON_GROUPS = Object.freeze(Object.keys(DEFAULT_PATTERNS));

/** `address` 不是正则片段，是名字：字面量匹配，边界更严。 */
export function addressMatcher(names) {
  const list = (Array.isArray(names) ? names : [names])
    .map((name) => String(name ?? "").trim())
    .filter(Boolean);
  if (!list.length) return null;
  const escaped = list.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?:^|[，。！？；：、\\s])(?:${escaped.join("|")})(?:[，,。！？!?~～\\s]|$)`);
}

/**
 * 合并默认词表和人格词表，编译成一组正则。
 *
 * 人格的同名键是**追加**，不是替换：她可以多一种被哄的方式，但不会因此
 * 失去「别生气了」这种通用说法。
 *
 * @param {object|null} lexicon 人格档案里的 `lexicon`
 * @returns {{address: RegExp|null} & Record<string, RegExp|null>}
 */
export function resolveLexicon(lexicon = null) {
  const out = { address: addressMatcher(lexicon?.address) };
  for (const group of LEXICON_GROUPS) {
    const extra = lexicon?.[group];
    const patterns = [
      ...(DEFAULT_PATTERNS[group] ?? []),
      ...(Array.isArray(extra) ? extra : []).map(String).map((item) => item.trim()).filter(Boolean),
    ];
    if (!patterns.length) {
      out[group] = null;
      continue;
    }
    try {
      out[group] = new RegExp(`(?:${patterns.join("|")})`);
    } catch (error) {
      throw new Error(`人格词表 lexicon.${group} 不是合法的正则片段：${error.message}`);
    }
  }
  return out;
}
