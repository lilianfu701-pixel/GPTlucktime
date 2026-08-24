import type { DemoConversation, DemoCurrentUser, DemoLocale, DemoMatch, DemoPlan, DemoProfile } from "./demo-types";

type ProfileSeed = readonly [string, string, number, string, string, string, string, string, readonly string[], number, `${number}% ${number}%`];

const profileSeeds = [
  ["demo-lina", "Lina", 31, "Shanghai", "China", "Brand strategist", "Long-term relationship", "I love quiet galleries, neighborhood food, and conversations that make a city feel new.", ["Design", "Jazz", "City walks"], 92, "0% 0%"],
  ["demo-marcus", "Marcus", 35, "Toronto", "Canada", "Architect", "Life partner", "Curious about people and places. Weekends usually mean a sketchbook, coffee, and the lake.", ["Architecture", "Cooking", "Travel"], 89, "33.333% 0%"],
  ["demo-aiko", "Aiko", 29, "Kyoto", "Japan", "Museum educator", "Committed relationship", "I collect small stories, practice ceramics, and never say no to an early morning market.", ["Ceramics", "History", "Hiking"], 87, "66.667% 0%"],
  ["demo-daniel", "Daniel", 38, "London", "United Kingdom", "Documentary producer", "Serious dating", "Warm, grounded, and always planning the next dinner with friends.", ["Film", "Running", "Food"], 85, "100% 0%"],
  ["demo-amara", "Amara", 33, "Nairobi", "Kenya", "Product designer", "Life partner", "Building a thoughtful life full of color, community, and really good playlists.", ["Design", "Music", "Community"], 83, "0% 100%"],
  ["demo-sofia", "Sofia", 30, "Mexico City", "Mexico", "Chef", "Long-term relationship", "My happiest days include a shared table, a spontaneous road trip, and something new to learn.", ["Cooking", "Road trips", "Dance"], 81, "33.333% 100%"],
  ["demo-wei", "Wei", 36, "Singapore", "Singapore", "Research lead", "Committed relationship", "Equal parts analytical and adventurous, with a soft spot for bookstores and coastal trails.", ["Books", "Cycling", "Science"], 79, "66.667% 100%"],
  ["demo-noor", "Noor", 28, "Dubai", "United Arab Emirates", "Creative director", "Serious dating", "Optimistic, close to family, and happiest when making beautiful things with kind people.", ["Photography", "Fashion", "Pilates"], 77, "100% 100%"],
] as const satisfies readonly ProfileSeed[];

const zh: Record<string, readonly [string, string, string, string, readonly string[]]> = {
  "demo-lina": ["上海", "中国", "品牌策略师", "长期关系", ["设计", "爵士乐", "城市漫步"]],
  "demo-marcus": ["多伦多", "加拿大", "建筑师", "人生伴侣", ["建筑", "烹饪", "旅行"]],
  "demo-aiko": ["京都", "日本", "博物馆教育工作者", "稳定关系", ["陶艺", "历史", "徒步"]],
  "demo-daniel": ["伦敦", "英国", "纪录片制作人", "认真交往", ["电影", "跑步", "美食"]],
  "demo-amara": ["内罗毕", "肯尼亚", "产品设计师", "人生伴侣", ["设计", "音乐", "社区"]],
  "demo-sofia": ["墨西哥城", "墨西哥", "厨师", "长期关系", ["烹饪", "公路旅行", "舞蹈"]],
  "demo-wei": ["新加坡", "新加坡", "研究负责人", "稳定关系", ["阅读", "骑行", "科学"]],
  "demo-noor": ["迪拜", "阿联酋", "创意总监", "认真交往", ["摄影", "时尚", "普拉提"]],
};

function makeProfiles(locale: DemoLocale): readonly DemoProfile[] {
  return Object.freeze(profileSeeds.map((seed, index) => {
    const [id, name, age, city, country, occupation, goal, bio, interests, compatibility, spritePosition] = seed;
    const translated = zh[id];
    return Object.freeze({
      id, name, age,
      city: locale === "zh-CN" ? translated[0] : city,
      country: locale === "zh-CN" ? translated[1] : country,
      occupation: locale === "zh-CN" ? translated[2] : occupation,
      relationshipGoal: locale === "zh-CN" ? translated[3] : goal,
      bio: locale === "zh-CN" ? `喜欢真诚的交流，也期待和善良、好奇的人一起探索生活。` : bio,
      interests: locale === "zh-CN" ? translated[4] : interests,
      verified: index !== 7,
      online: index % 3 === 0,
      compatibility,
      spritePosition,
    } satisfies DemoProfile);
  }));
}

const conversations: Record<DemoLocale, readonly DemoConversation[]> = {
  en: Object.freeze([
    { id: "conversation-lina", profileId: "demo-lina", unread: 2, preview: "That gallery sounds perfect.", messages: [{ id: "m1", from: "them", text: "That gallery sounds perfect. Would Saturday work?", time: "10:24" }, { id: "m2", from: "me", text: "Saturday afternoon would be lovely.", time: "10:31" }] },
    { id: "conversation-marcus", profileId: "demo-marcus", unread: 0, preview: "I can share my favorite waterfront walk.", messages: [{ id: "m3", from: "them", text: "I can share my favorite waterfront walk.", time: "Yesterday" }] },
    { id: "conversation-amara", profileId: "demo-amara", unread: 1, preview: "Your playlist recommendation was excellent.", messages: [{ id: "m4", from: "them", text: "Your playlist recommendation was excellent.", time: "Monday" }] },
    { id: "conversation-aiko", profileId: "demo-aiko", unread: 0, preview: "The morning market is beautiful this season.", messages: [{ id: "m5", from: "them", text: "The morning market is beautiful this season.", time: "Tuesday" }] },
    { id: "conversation-daniel", profileId: "demo-daniel", unread: 0, preview: "I would love to hear your favorite film.", messages: [{ id: "m6", from: "them", text: "I would love to hear your favorite film.", time: "Wednesday" }] },
    { id: "conversation-sofia", profileId: "demo-sofia", unread: 0, preview: "What dish always feels like home to you?", messages: [{ id: "m7", from: "them", text: "What dish always feels like home to you?", time: "Thursday" }] },
    { id: "conversation-wei", profileId: "demo-wei", unread: 0, preview: "That coastal trail sounds worth the early start.", messages: [{ id: "m8", from: "them", text: "That coastal trail sounds worth the early start.", time: "Friday" }] },
    { id: "conversation-noor", profileId: "demo-noor", unread: 0, preview: "Photography changes how I notice a city.", messages: [{ id: "m9", from: "them", text: "Photography changes how I notice a city.", time: "Saturday" }] },
  ]),
  "zh-CN": Object.freeze([
    { id: "conversation-lina", profileId: "demo-lina", unread: 2, preview: "那个画廊听起来很棒。", messages: [{ id: "m1", from: "them", text: "那个画廊听起来很棒。周六方便吗？", time: "10:24" }, { id: "m2", from: "me", text: "周六下午很好。", time: "10:31" }] },
    { id: "conversation-marcus", profileId: "demo-marcus", unread: 0, preview: "可以和你分享我最喜欢的湖边路线。", messages: [{ id: "m3", from: "them", text: "可以和你分享我最喜欢的湖边路线。", time: "昨天" }] },
    { id: "conversation-amara", profileId: "demo-amara", unread: 1, preview: "你推荐的歌单太棒了。", messages: [{ id: "m4", from: "them", text: "你推荐的歌单太棒了。", time: "周一" }] },
    { id: "conversation-aiko", profileId: "demo-aiko", unread: 0, preview: "这个季节的早市很美。", messages: [{ id: "m5", from: "them", text: "这个季节的早市很美。", time: "周二" }] },
    { id: "conversation-daniel", profileId: "demo-daniel", unread: 0, preview: "很想听听你最喜欢的电影。", messages: [{ id: "m6", from: "them", text: "很想听听你最喜欢的电影。", time: "周三" }] },
    { id: "conversation-sofia", profileId: "demo-sofia", unread: 0, preview: "哪道菜最让你有家的感觉？", messages: [{ id: "m7", from: "them", text: "哪道菜最让你有家的感觉？", time: "周四" }] },
    { id: "conversation-wei", profileId: "demo-wei", unread: 0, preview: "那条海岸步道值得早起。", messages: [{ id: "m8", from: "them", text: "那条海岸步道值得早起。", time: "周五" }] },
    { id: "conversation-noor", profileId: "demo-noor", unread: 0, preview: "摄影改变了我观察城市的方式。", messages: [{ id: "m9", from: "them", text: "摄影改变了我观察城市的方式。", time: "周六" }] },
  ]),
};

export const demoProfiles: Record<DemoLocale, readonly DemoProfile[]> = { en: makeProfiles("en"), "zh-CN": makeProfiles("zh-CN") };
export const demoConversations = conversations;
export const demoMatches: Record<DemoLocale, readonly DemoMatch[]> = {
  en: Object.freeze([{ profileId: "demo-lina", matchedAt: "Today" }, { profileId: "demo-marcus", matchedAt: "Yesterday" }, { profileId: "demo-amara", matchedAt: "3 days ago" }, { profileId: "demo-aiko", matchedAt: "This week" }]),
  "zh-CN": Object.freeze([{ profileId: "demo-lina", matchedAt: "今天" }, { profileId: "demo-marcus", matchedAt: "昨天" }, { profileId: "demo-amara", matchedAt: "3 天前" }, { profileId: "demo-aiko", matchedAt: "本周" }]),
};
export const demoPlans: Record<DemoLocale, readonly DemoPlan[]> = {
  en: Object.freeze([
    { id: "free", name: "Free", price: "$0", description: "Start discovering", features: ["Browse profiles", "Limited likes", "Safety tools"], recommended: false },
    { id: "plus", name: "Plus", price: "$19", description: "More ways to connect", features: ["Unlimited likes", "See visitors", "Advanced filters"], recommended: false },
    { id: "premium", name: "Premium", price: "$29", description: "Our complete experience", features: ["Message freely", "Priority discovery", "Travel mode"], recommended: true },
  ]),
  "zh-CN": Object.freeze([
    { id: "free", name: "免费版", price: "$0", description: "开始发现", features: ["浏览资料", "有限喜欢", "安全工具"], recommended: false },
    { id: "plus", name: "进阶版", price: "$19", description: "更多连接方式", features: ["不限喜欢", "查看访客", "高级筛选"], recommended: false },
    { id: "premium", name: "尊享版", price: "$29", description: "完整体验", features: ["自由发消息", "优先展示", "旅行模式"], recommended: true },
  ]),
};
export const demoCurrentUser: Record<DemoLocale, DemoCurrentUser> = {
  en: Object.freeze({ name: "Alex", age: 34, city: "San Francisco", completion: 78, plan: "Free", bio: "Curious traveler, home cook, and believer in intentional connection.", interests: ["Travel", "Cooking", "Photography"] }),
  "zh-CN": Object.freeze({ name: "Alex", age: 34, city: "旧金山", completion: 78, plan: "免费版", bio: "喜欢旅行与下厨，相信真诚而有目标的连接。", interests: ["旅行", "烹饪", "摄影"] }),
};
