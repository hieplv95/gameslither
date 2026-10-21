'use strict';
// Công cụ viết bài tự động cho blog: gợi ý chủ đề + viết bài chuẩn SEO bằng Claude, kèm ảnh.
// Chữ: Claude API (ANTHROPIC_API_KEY). Ảnh, theo thứ tự ưu tiên:
//   1. VERTEX_KEY_FILE → ảnh do Gemini vẽ qua Vertex AI (Google Cloud, khoá service account dạng JSON)
//   2. OPENAI_API_KEY → ảnh minh hoạ do AI vẽ (gpt-image)
//   3. PEXELS_API_KEY → ảnh kho miễn phí từ Pexels (có ghi nguồn)
//   4. không có key nào → ảnh bìa SVG tự vẽ (tiêu đề + hình rắn), không có ảnh trong bài
// Ảnh do AI vẽ được đóng logo GameSlither ở góc dưới phải (BLOG_IMAGE_LOGO=0 để tắt).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');
const blog = require('./blog');

const MODEL = process.env.BLOG_MODEL || 'claude-opus-5';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const VERTEX_IMAGE_MODEL = process.env.VERTEX_IMAGE_MODEL || 'gemini-3.1-flash-image';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'global';
let client = null;
// Chỉ dùng đúng ANTHROPIC_API_KEY trong .env (tính phí vào tài khoản API của key đó).
// Tắt hẳn các nguồn đăng nhập khác của SDK (ANTHROPIC_AUTH_TOKEN, hồ sơ `ant auth login` trên máy)
// để không vô tình dùng thông tin đăng nhập nào khác có sẵn trong môi trường.
const ai = () => {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Chưa cấu hình ANTHROPIC_API_KEY trong file .env.');
  return (client ||= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, authToken: null }));
};

function capabilities() {
  return {
    text: !!process.env.ANTHROPIC_API_KEY,
    model: MODEL,
    image: process.env.VERTEX_KEY_FILE ? 'vertex' : process.env.OPENAI_API_KEY ? 'openai'
      : process.env.PEXELS_API_KEY ? 'pexels' : 'svg',
  };
}

// ---------------------------------------------------------------- bối cảnh website
const SITE_FACTS = `GameSlither is a free, browser-based multiplayer online snake game in the style of Slither.io.
- Players steer a snake with the mouse or touch, eat glowing pellets to grow, and try to make other snakes crash into their body.
- Boost: hold left click, Space or the ⚡ button (boosting costs length and drops pellets behind you).
- Public rooms always hold about 40 snakes: real players plus AI snakes that step aside as more players join (up to 50 players per room). AI snakes have three personalities: shy ones avoid bigger snakes, hunters try to cut off smaller snakes, gluttons rush to the pellets of defeated snakes.
- Real-time leaderboard, minimap, kill feed ("X defeated Y"), explosion effects, sound effects (with mute button) and vibration on phones.
- After each death a result screen shows max length, kills, time alive, best rank and coins earned, with a Share button that creates a result image.
- Private rooms: create a room and share its 4-character code or an invite link (?room=CODE) with friends.
- 6 free snake skins: Classic (12 colors), Neon Cyber, Golden Dragon, Rainbow Candy, Jungle Python, Galaxy.
- Coins: free play earns coins (+1 per 10 length reached, +5 per snake taken down). Coins have no money value. The shop sells 23 country-flag skins (the 20 most populous countries plus the UK, Italy and Spain) for 500 coins each.
- Daily missions: 3 new missions every day (play N games, defeat N snakes, reach a length, survive N minutes in one life) that pay coins instantly.
- Daily login reward: 20 → 200 coins for days 1–7 of a login streak, then the cycle repeats.
- 4 achievement skins that cannot be bought: Inferno (reach length 1,500 in one life), Frost (survive 10 minutes in one life), Shadow (defeat 5 snakes in one life), Aurora (log in 7 days in a row).
- Hall of fame: weekly (from Monday) and all-time rankings of the longest snake in one life.
- Account recovery code to restore coins and skins on another device or after clearing browser data.
- Works on desktop, mobile and tablet browsers; no download, no sign-up.
- Available in 11 languages.
GameSlither is independent and NOT affiliated with Slither.io or Lowtech Studios. "Slither io" may be used only to describe the genre/style.`;

// Nhóm chủ đề: dùng để ép gợi ý đa dạng, chọn hướng trong trang quản trị và thống kê độ phủ của blog.
// label hiện trong trang quản trị, hint giải thích cho AI.
const CLUSTERS = [
  { key: 'genre', label: 'Từ khoá thể loại (slither io…)', hint: 'searches that use the genre name "slither io" / "slither.io style" (the genre term itself)' },
  { key: 'generic', label: 'Game rắn nói chung', hint: 'generic snake-game searches without the word slither, as natives type them (e.g. "snake game online", Vietnamese "game rắn săn mồi")' },
  { key: 'io', label: 'Game .io nói chung', hint: '.io games and free browser multiplayer games in general (best io games, games like agar.io…)' },
  { key: 'compare', label: 'So sánh game khác', hint: 'comparisons and alternatives: Agar.io, Wormate.io, Little Big Snake, Snake.io, Google Snake, Nokia Snake…' },
  { key: 'strategy', label: 'Mẹo & chiến thuật', hint: 'advanced tactics: encircling, cutting off, boosting, surviving big fights, growing fast' },
  { key: 'beginner', label: 'Người mới', hint: 'first steps, controls, common beginner mistakes, how to play' },
  { key: 'skins', label: 'Skin, xu & thành tích', hint: 'skins, coins, the shop, achievement skins, daily missions, login rewards' },
  { key: 'friends', label: 'Chơi với bạn bè', hint: 'private rooms, invite links, playing with friends, family or classmates, mini tournaments' },
  { key: 'mobile', label: 'Điện thoại & thiết bị', hint: 'playing on phones, tablets, Chromebooks, school computers; lag, controls and performance on devices' },
  { key: 'culture', label: 'Lịch sử & văn hoá game rắn', hint: 'history of snake games (Nokia, arcade Blockade), records, trivia, psychology, why snake games are addictive' },
  { key: 'parents', label: 'Phụ huynh & an toàn', hint: 'parents, teachers, kids safety, screen time, educational value' },
  { key: 'updates', label: 'Cập nhật & tính năng mới', hint: 'GameSlither features and updates: hall of fame, missions, AI snake personalities, share cards, events' },
  { key: 'questions', label: 'Câu hỏi hay gặp', hint: 'one narrow question people type into Google per article ("why does my snake…", "can you…", "is it possible to…", "what happens if…"), People Also Ask style' },
  { key: 'names', label: 'Tên & nickname', hint: 'nickname ideas, cool/funny snake names, team and clan names, name generators, naming tips for io games' },
  { key: 'skills', label: 'Kỹ năng & lợi ích', hint: 'what snake/io games train: reflexes, focus, hand-eye coordination, quick decisions; short game breaks for students and office workers' },
  { key: 'events', label: 'Mùa, lễ & thử thách', hint: 'seasonal and occasion angles: holidays, school breaks, weekends, self-made challenges, mini tournaments with rules, streaming/recording ideas' },
];
const CLUSTER_KEYS = CLUSTERS.map(c => c.key);

// So khớp gần đúng 2 cụm chữ (bỏ dấu, chữ thường): từng từ với ngôn ngữ có dấu cách, từng cặp ký tự với tiếng Trung/Nhật.
// Bỏ từ nối tiếng Anh để "How to … in …" không bị coi là giống nhau.
const STOP = new Set('the an and or of to in on at for with your you my is are be how what why which when where can do does vs it its this that from'.split(' '));
function tokens(s) {
  const t = String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
  if (/[぀-ヿ㐀-鿿]/.test(t)) {
    const c = t.replace(/[^\p{L}\p{N}]/gu, '');
    const out = new Set();
    for (let i = 0; i < c.length - 1; i++) out.add(c.slice(i, i + 2));
    return out;
  }
  return new Set(t.split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1 && !STOP.has(w)));
}
function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}
const sameKeyword = (a, b) => [...tokens(a)].sort().join(' ') === [...tokens(b)].sort().join(' ');
// Hai chủ đề { title, keyword, keywords? } coi là trùng: cùng từ khoá (hoặc gần như cùng; với bài đã có thì so với
// mọi từ khoá của bài), tiêu đề giống nhau, hoặc gộp tiêu đề + từ khoá giống nhau từ 35% trở lên
// (trước đây mức này chỉ cảnh báo "gần giống bài đã có").
const sameKw = (x, y) => x && y && (sameKeyword(x, y) || similarity(x, y) > 0.7);
function isDup(a, b) {
  if ((a.keywords || [a.keyword]).some(k => sameKw(k, b.keyword))) return true;
  return similarity(a.title, b.title) >= 0.5 || similarity(`${a.title} ${a.keyword}`, `${b.title} ${b.keyword}`) >= 0.35;
}
function postTopic(p) {
  const keywords = (p.keywords || '').split(',').map(k => k.trim()).filter(Boolean);
  return { title: p.title, keyword: keywords[0] || '', keywords };
}
// Mỗi bài so khớp theo tiêu đề AI đặt và cả chủ đề gốc dùng để viết (thường chính là tiêu đề gợi ý)
const postTopics = posts => posts.flatMap(p => {
  const t = postTopic(p);
  return p.topic && p.topic !== p.title ? [t, { ...t, title: p.topic }] : [t];
});

const LENGTHS = { short: '700–900', medium: '1300–1600', long: '2200–2600' };
const TONES = {
  friendly: 'friendly, energetic and conversational, like an experienced gamer talking to a friend',
  expert: 'authoritative and analytical, like a veteran strategy guide writer',
  news: 'neutral and informative, like a gaming news editor',
  beginner: 'patient and very clear, explaining everything for complete beginners',
};

function langOf(code) {
  const L = blog.BY_CODE.get(code);
  if (!L) throw new Error('Ngôn ngữ không hợp lệ');
  return L;
}

// Gọi Claude với đầu ra JSON theo schema; trả về object đã parse.
// Dùng streaming (bài dài, tránh timeout) + fallbacks: "default" (nếu model chính từ chối, API tự chạy lại bằng model dự phòng).
async function askJson({ system, prompt, schema, maxTokens = 64000, effort }) {
  const stream = ai().beta.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema }, ...(effort ? { effort } : {}) },
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('AI từ chối viết chủ đề này. Hãy thử chủ đề khác.');
  if (msg.stop_reason === 'max_tokens') throw new Error('Bài viết quá dài, AI bị cắt giữa chừng. Hãy chọn độ dài ngắn hơn.');
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try { return JSON.parse(text); } catch { throw new Error('AI trả về dữ liệu không đọc được. Hãy thử lại.'); }
}

function friendlyError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'ANTHROPIC_API_KEY không hợp lệ.';
  if (e instanceof Anthropic.RateLimitError) return 'Đang bị giới hạn tốc độ gọi Claude API, thử lại sau ít phút.';
  if (e instanceof Anthropic.BadRequestError) return `Claude API từ chối yêu cầu: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `Lỗi Claude API (${e.status || 'mạng'}): ${e.message}`;
  return e.message || String(e);
}

// ---------------------------------------------------------------- gợi ý chủ đề
const TOPICS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['topics', 'classified'],
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'keyword', 'cluster', 'intent', 'difficulty', 'priority', 'angle'],
        properties: {
          title: { type: 'string', description: 'Working headline in the target language' },
          keyword: { type: 'string', description: 'Main search keyword in the target language, exactly as native speakers type it into Google' },
          cluster: { type: 'string', enum: CLUSTER_KEYS },
          intent: { type: 'string', enum: ['informational', 'how-to', 'comparison', 'list', 'news'] },
          difficulty: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How hard it is for a small new site to reach page 1 for the keyword' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Overall value for this blog now: demand, ranking chance, fit with the game, gap in coverage' },
          angle: { type: 'string', description: 'One sentence (target language): what makes this article useful/unique' },
        },
      },
    },
    classified: {
      type: 'array', description: 'One entry per article listed under "Unclassified existing articles" (empty array if none)',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'cluster'],
        properties: { id: { type: 'integer' }, cluster: { type: 'string', enum: CLUSTER_KEYS } },
      },
    },
  },
};

const GENRE_RE = /slither/i;
const MAX_COUNT = 30;
const ROUNDS = 3, ROUNDS_BUDGET_MS = 150_000;   // gọi AI thêm vòng nữa khi lọc trùng xong còn thiếu (trong giới hạn thời gian)

// Gợi ý chủ đề. clusters: các nhóm biên tập viên chọn (rỗng = trộn đa dạng). Trả về { topics, classified }:
// topics không trùng (bài đã có, mọi gợi ý trước đó, và lẫn nhau); classified = nhóm cho các bài cũ chưa phân loại.
async function suggestTopics({ lang, seed = '', clusters = [], count = 10 }) {
  const L = langOf(lang);
  count = Math.min(MAX_COUNT, Math.max(3, count));
  const picked = clusters.filter(c => CLUSTER_KEYS.includes(c));
  const posts = db.postsOfLang(lang);
  const past = db.recentIdeas(lang, 5000);   // mọi gợi ý từng đưa ra: đang chờ, đã viết, đã bỏ qua
  const cov = db.coverage(lang);
  const unclassified = posts.filter(p => !p.cluster).slice(0, 60);
  const maxPer = Math.max(2, Math.ceil(count / 8)), maxGenre = Math.max(2, Math.round(count / 8));
  const taken = [...postTopics(posts), ...past];
  const out = [], rejected = [], perCluster = {};
  let genre = 0, classified = [];
  const started = Date.now();

  for (let round = 0; round < ROUNDS && out.length < count; round++) {
    if (round && Date.now() - started > ROUNDS_BUDGET_MS) break;
    const need = count - out.length;
    const full = picked.length ? [] : CLUSTER_KEYS.filter(k => (perCluster[k] || 0) >= maxPer);
    const clusterList = CLUSTERS.filter(c => !full.includes(c.key))
      .map(c => `- ${c.key}: ${c.hint} — ${cov.posts[c.key] || 0} articles, ${(cov.ideas[c.key] || 0) + (perCluster[c.key] || 0)} pending ideas`).join('\n');
    const focus = picked.length
      ? `Only suggest topics in these clusters: ${picked.join(', ')}. Spread the topics evenly across them, and inside a cluster vary the keyword head terms (no two keywords may start with the same two words).`
      : `Mix clusters: use at least ${Math.min(need, 6)} different clusters, at most ${maxPer} topics per cluster, and prefer clusters with few articles and few pending ideas.
At most ${Math.max(1, maxGenre - genre)} keywords may contain the genre term "slither" (in any spelling). Most keywords must be ones people type WITHOUT that word.`;
    const r = await askJson({
      system: `You are an SEO content strategist for a gaming website.\n\n${SITE_FACTS}`,
      prompt: `Suggest ${Math.min(50, need * 2 + 4)} blog article topics for the GameSlither blog, written in ${L.name} (${L.htmlLang}) for readers searching in that language.
${seed ? `Focus area requested by the editor: "${seed}".\n` : ''}
Topic clusters (with current coverage of this blog in ${L.name}):
${clusterList}

${focus}

Keyword rules:
- Write keywords the way native ${L.name} speakers actually search in Google — their own everyday words and spelling, not a literal translation of English keywords. English loanwords are fine only where natives really use them.
- Prefer specific long-tail keywords with a realistic chance for a small new site over broad head terms.
- No two topics may target the same keyword or the same search intent.
- Every topic must be naturally relevant to GameSlither so the article can link to the game. Topics about GameSlither's own features (missions, achievement skins, hall of fame, AI snake personalities, invite links, share cards) are welcome because no other site covers them.

The blog already covers many topics, so the obvious ones are taken. Find fresh, narrow angles instead of rewording old ones:
- one specific question per article (why / can / what happens if / how long / how many…)
- modifiers: device (phone, iPad, Chromebook, school laptop, keyboard vs mouse), audience (kids, teens, adults, classmates, couples, office workers), situation (5-minute break, rainy day, after school, weekend with friends)
- formats: checklist, myth vs fact, glossary of terms, one-tactic deep dive, records and numbers, challenge ideas, name ideas, seasonal guide
- A new topic must answer a different search query than every listed article and suggestion — same subject with a new title is a duplicate.

Do NOT repeat or closely paraphrase any of these existing articles:
${posts.map(p => { const t = postTopic(p); return `- ${t.title}${t.keyword ? ` [${t.keyword}]` : ''}`; }).join('\n') || '(none yet)'}

Do NOT repeat or closely paraphrase any of these earlier suggestions (already suggested, written or rejected by the editor):
${[...out, ...past].slice(0, 500).map(i => `- ${i.title} [${i.keyword}]`).join('\n') || '(none yet)'}
${rejected.length ? `\nThese were just rejected as too close to existing topics — go in a clearly different direction:\n${rejected.slice(-40).map(i => `- ${i.title} [${i.keyword}]`).join('\n')}\n` : ''}
Unclassified existing articles — put each one into the best cluster in "classified":
${round ? '(none)' : unclassified.map(p => `- id ${p.id}: ${p.title}`).join('\n') || '(none)'}`,
      schema: TOPICS_SCHEMA,
      maxTokens: 32000,
      effort: 'medium',
    });
    if (!round) classified = r.classified || [];

    // Lọc lại phía server: AI đôi khi vẫn lặp hoặc dồn vào một nhóm
    for (const t of r.topics || []) {
      if (out.length >= count) break;
      if (!CLUSTER_KEYS.includes(t.cluster)) continue;
      if (picked.length && !picked.includes(t.cluster)) continue;
      if (taken.some(x => isDup(x, t)) || out.some(x => isDup(x, t))) { rejected.push(t); continue; }
      if (!picked.length) {
        if ((perCluster[t.cluster] || 0) >= maxPer) continue;
        if (GENRE_RE.test(t.keyword) && genre >= maxGenre) continue;
      }
      perCluster[t.cluster] = (perCluster[t.cluster] || 0) + 1;
      if (GENRE_RE.test(t.keyword)) genre++;
      out.push(t);
    }
  }
  const ids = new Set(unclassified.map(p => p.id));
  classified = classified.filter(c => ids.has(c.id) && CLUSTER_KEYS.includes(c.cluster));
  return { topics: out, classified };
}

// Gợi ý đang chờ để hiện trong trang quản trị. Gợi ý nào đã trùng một bài đã có (vd. bài viết tay sau đó)
// hoặc trùng một gợi ý cũ hơn thì tự chuyển sang 'duplicate' và không hiện nữa.
function openIdeas(lang) {
  const taken = postTopics(db.postsOfLang(lang)), out = [];
  for (const i of db.openIdeas(lang, 1000).reverse()) {   // cũ → mới: giữ gợi ý có trước
    if (taken.some(x => isDup(x, i)) || out.some(x => isDup(x, i))) db.setIdeaStatus(i.id, 'duplicate');
    else out.push(i);
  }
  return out.reverse();
}
// Gợi ý đang chờ khớp với chủ đề sắp viết: vẫn tìm ra khi biên tập viên đã sửa chữ sau khi bấm gợi ý
function matchIdea(lang, title, keyword) {
  return db.openIdeas(lang, 1000).find(i => i.title === title || isDup(i, { title, keyword })) || null;
}

// ---------------------------------------------------------------- viết bài
const ARTICLE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'slug', 'metaDescription', 'keywords', 'excerpt', 'content', 'faq', 'images'],
  properties: {
    title: { type: 'string' },
    slug: { type: 'string' },
    metaDescription: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    excerpt: { type: 'string' },
    content: { type: 'string' },
    faq: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['question', 'answer'],
      properties: { question: { type: 'string' }, answer: { type: 'string' } } } },
    images: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['prompt', 'searchQuery', 'alt'],
      properties: { prompt: { type: 'string' }, searchQuery: { type: 'string' }, alt: { type: 'string' } } } },
  },
};

async function writeArticle({ lang, topic, keyword = '', length = 'medium', tone = 'friendly', images = 2, notes = '' }) {
  const L = langOf(lang);
  const nImages = Math.max(1, Math.min(4, Number(images) || 1));
  const related = db.publishedPosts(lang, 30).map(p => `- ${p.title}: ${blog.postPath(L, p.slug)}`).join('\n') || '(none yet)';
  const system = `You are a senior SEO copywriter and a native ${L.name} speaker writing for the GameSlither blog.

${SITE_FACTS}

Writing rules:
- Write entirely in natural, fluent ${L.name} (${L.htmlLang}) — idiomatic, as a native writer would, never a translation. Keep proper names (GameSlither, Slither.io) as-is.
- Be genuinely helpful and specific (E-E-A-T): concrete tips, examples, numbers only when they are facts about GameSlither listed above. Never invent statistics, studies, quotes, release dates or features.
- Never claim GameSlither is Slither.io or affiliated with it.
- No fluff, no keyword stuffing; use the main keyword naturally (title, first paragraph, one H2, conclusion) and related terms/synonyms elsewhere.`;

  const prompt = `Write a blog article.

Topic: ${topic}
Main keyword: ${keyword || '(choose the best one for this topic)'}
Length of "content": ${LENGTHS[length] || LENGTHS.medium} words (or the equivalent for ${L.name}).
Tone: ${TONES[tone] || TONES.friendly}.
${notes ? `Editor's extra instructions: ${notes}\n` : ''}
Internal links you may use (Markdown links, use 2–4 where relevant):
- GameSlither home / play now: ${L.path}
- How to play: ${L.path}#how-to-play
- Snake skins: ${L.path}#snake-skins
- GameSlither vs Slither.io: ${L.path}#vs-slither-io
Existing blog articles in this language:
${related}

Field requirements:
- title: compelling SEO title in ${L.name}, 45–60 characters, contains the main keyword near the start. Do not append the site name.
- slug: lowercase ASCII only (a-z, 0-9, hyphens), 3–7 words, transliterate if the language is not Latin-script, no stop words, no dates.
- metaDescription: 140–158 characters in ${L.name}, includes the keyword, ends with a soft call to action.
- keywords: 5–8 keyword phrases in ${L.name} (main keyword first).
- excerpt: 1–2 sentences (max 200 characters) for article cards.
- content: GitHub-flavored Markdown. Do NOT include the H1 title. Start with a 2–3 sentence intro paragraph that answers the searcher's question directly. Then 4–7 "##" sections with descriptive headings (some with "###" subsections), short paragraphs, bullet or numbered lists, and at least one comparison table if it fits the topic. Use **bold** sparingly for key terms. End with a short conclusion section that invites the reader to play GameSlither (link ${L.path}). No raw HTML. Do not put an FAQ section inside content.
- Images: provide exactly ${nImages} item(s) in "images". images[0] is the cover. ${nImages > 1 ? `Place a line containing exactly [[IMAGE 2]]${nImages > 2 ? `, [[IMAGE 3]]` : ''}${nImages > 3 ? `, [[IMAGE 4]]` : ''} on its own line inside content, each after a relevant section (not the cover).` : 'Do not put image markers in content.'}
  - prompt: English description of one in-game GameSlither moment that illustrates the section, seen from the game's top-down camera: how many snakes, their sizes and skins (Classic single-color, Neon Cyber, Golden Dragon, Rainbow Candy, Jungle Python, Galaxy, or a country-flag skin), what they are doing (e.g. a long snake coiling around a smaller one, two snakes racing for the pellets a defeated snake left behind, a snake boosting with a glow). Describe only the scene — the game's visual style is supplied separately. No text, UI, real people or real-world objects.
  - searchQuery: 2–4 English words for a stock photo search (e.g. "gamer playing laptop").
  - alt: descriptive alt text in ${L.name} (max 120 characters), include the keyword naturally in the first image's alt only.
- faq: 3–5 questions real users would search in ${L.name}, with concise 1–3 sentence answers (plain text, may contain Markdown links).`;

  const r = await askJson({ system, prompt, schema: ARTICLE_SCHEMA });
  return normalizeArticle(r, L, nImages);
}

function clean(s, max) {
  return String(s || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);
}
function toSlug(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 10).join('-').slice(0, 80).replace(/-+$/, '');
}
function uniqueSlug(lang, slug, exceptId = 0) {
  let s = toSlug(slug) || `bai-viet-${Date.now().toString(36)}`, n = 2;
  const base = s;
  while (db.slugTaken(lang, s, exceptId)) s = `${base}-${n++}`;
  return s;
}
function normalizeArticle(r, L, nImages) {
  return {
    title: clean(r.title, 120),
    slug: uniqueSlug(L.code, r.slug || r.title),
    description: clean(r.metaDescription, 320),
    keywords: (r.keywords || []).map(k => clean(k, 80)).filter(Boolean).slice(0, 10).join(', '),
    excerpt: clean(r.excerpt, 300),
    content: clean(r.content, 60000),
    faq: (r.faq || []).map(f => [clean(f.question, 300), clean(f.answer, 1200)]).filter(f => f[0] && f[1]).slice(0, 8),
    images: (r.images || []).slice(0, nImages).map(i => ({ prompt: clean(i.prompt, 1500), query: clean(i.searchQuery, 80), alt: clean(i.alt, 160) })),
  };
}

// ---------------------------------------------------------------- ảnh
// Mô tả đúng giao diện game thật để ảnh AI giống GameSlither, không phải tranh tưởng tượng.
const GAME_LOOK = `It must look exactly like a real screenshot of the 2D browser game GameSlither (flat top-down camera, no perspective):
- floor: dark charcoal-navy (#10151b) tiled with slightly lighter, evenly spaced flat hexagons
- food: many small round glowing pellets in assorted bright colors (pink, cyan, green, yellow, purple, orange) scattered evenly
- snakes: smooth tubes made of round overlapping segments that taper toward the tail, a thin darker outline, a soft glossy highlight along the back, a rounded head with two big round cartoon eyes (white with dark pupils)
- skins are clean flat patterns on the body (single color with stripes, gold dragon scales, rainbow candy, neon chevrons, jungle diamonds, galaxy sparkles, or a country flag) — no realistic reptile scales, no 3D render, no fantasy lighting, no landscape
Crisp, clean game graphics. Absolutely no text, letters, numbers, player names, UI, leaderboard, logos or watermarks.`;
const STYLE = `Style: ${GAME_LOOK}`;
// Ảnh mẫu dựng bằng chính code vẽ của game (assets/game-ref-*.jpg), gửi kèm cho Gemini để bám theo
const GAME_REFS = ['game-ref-1.jpg', 'game-ref-2.jpg'].map(f => {
  try { return fs.readFileSync(path.join(__dirname, 'assets', f)).toString('base64'); } catch { return null; }
}).filter(Boolean);

async function openaiImage(prompt) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_IMAGE_MODEL, prompt: `${prompt}\n\n${STYLE}`, size: '1536x1024', quality: 'medium', output_format: 'webp', n: 1 }),
    signal: AbortSignal.timeout(180_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(j.error && j.error.message) || res.statusText}`);
  const b64 = j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) throw new Error('OpenAI không trả về ảnh');
  return Buffer.from(b64, 'base64');
}

// ---- Vertex AI: khoá service account (JSON) → access token (1 giờ, ký JWT bằng private key) → Gemini vẽ ảnh
let vertexKey = null, vertexToken = null;
function vertexCreds() {
  if (!vertexKey) {
    let k;
    try { k = JSON.parse(fs.readFileSync(process.env.VERTEX_KEY_FILE, 'utf8')); }
    catch (e) { throw new Error(`Không đọc được VERTEX_KEY_FILE (${e.code || e.message})`); }
    if (!k.client_email || !k.private_key) throw new Error('VERTEX_KEY_FILE không phải khoá service account dạng JSON.');
    vertexKey = k;
  }
  return vertexKey;
}
async function vertexAccessToken() {
  if (vertexToken && vertexToken.exp > Date.now() + 60_000) return vertexToken.value;
  const k = vertexCreds(), now = Math.floor(Date.now() / 1000);
  const tokenUri = k.token_uri || 'https://oauth2.googleapis.com/token';
  const part = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
    iss: k.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: tokenUri, iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(k.private_key, 'base64url');
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Google: đăng nhập bằng service account lỗi (${j.error_description || j.error || res.status})`);
  vertexToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return vertexToken.value;
}
async function vertexImage(prompt) {
  const k = vertexCreds();
  const project = process.env.VERTEX_PROJECT || k.project_id;
  const host = VERTEX_LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${VERTEX_LOCATION}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${project}/locations/${VERTEX_LOCATION}/publishers/google/models/${VERTEX_IMAGE_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await vertexAccessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [
        { text: `The attached images are real screenshots of the game GameSlither. Draw a NEW scene in exactly the same visual style (same floor, pellets, snake shapes, eyes, outlines and skin patterns) — do not copy their layout.\n\n${GAME_LOOK}` },
        ...GAME_REFS.map(data => ({ inlineData: { mimeType: 'image/jpeg', data } })),
        { text: `Scene to draw: ${prompt}` },
      ] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:2' } },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Vertex AI (${VERTEX_IMAGE_MODEL}) ${res.status}: ${(j.error && j.error.message) || res.statusText}`);
  const c = j.candidates && j.candidates[0];
  const img = ((c && c.content && c.content.parts) || []).find(p => p.inlineData && p.inlineData.data);
  if (!img) throw new Error(`Vertex AI không trả về ảnh (${(j.promptFeedback && j.promptFeedback.blockReason) || (c && c.finishReason) || 'không rõ lý do'})`);
  return Buffer.from(img.inlineData.data, 'base64');
}

// ---- đóng logo + lưu ảnh AI (chuyển sang WebP cho nhẹ). Thiếu thư viện sharp thì lưu nguyên ảnh gốc.
let sharp = null;
try { sharp = require('sharp'); } catch { /* chưa cài sharp */ }
const LOGO_FILE = path.join(__dirname, 'assets', 'logo-badge.png');
const extOf = b => (b[0] === 0x89 ? 'png' : b[0] === 0xff ? 'jpg' : 'webp');
async function saveAiImage(buf, slug) {
  if (!sharp) return blog.saveMedia(buf, extOf(buf), slug);
  let img = sharp(buf);
  if (process.env.BLOG_IMAGE_LOGO !== '0') {
    const { width, height } = await img.metadata();
    const w = Math.round(width * 0.22), margin = Math.round(width * 0.025);
    const logo = await sharp(LOGO_FILE).resize({ width: w }).toBuffer({ resolveWithObject: true });
    img = img.composite([{ input: logo.data, left: width - w - margin, top: height - logo.info.height - margin }]);
  }
  return blog.saveMedia(await img.webp({ quality: 86 }).toBuffer(), 'webp', slug);
}

async function pexelsImage(query, slug, skip = 0) {
  const u = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query || 'video game')}&orientation=landscape&per_page=${skip + 1}`;
  const res = await fetch(u, { headers: { Authorization: process.env.PEXELS_API_KEY }, signal: AbortSignal.timeout(30_000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Pexels: ${j.error || res.status}`);
  const ph = j.photos && j.photos[Math.min(skip, j.photos.length - 1)];
  if (!ph) throw new Error(`Pexels không có ảnh cho "${query}"`);
  const img = await fetch(ph.src.large2x || ph.src.large, { signal: AbortSignal.timeout(60_000) });
  if (!img.ok) throw new Error('Không tải được ảnh Pexels');
  const type = img.headers.get('content-type') || '';
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  return { src: blog.saveMedia(Buffer.from(await img.arrayBuffer()), ext, slug), credit: `[${ph.photographer}](${ph.photographer_url}) / [Pexels](${ph.url})` };
}

// Ảnh bìa SVG tự vẽ: nền tối, rắn neon uốn lượn, tiêu đề bài (ngắt dòng đơn giản).
function svgCover(title, slug) {
  const x = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const words = String(title).split(/\s+/), lines = [];
  const cjk = /[　-鿿]/.test(title), max = cjk ? 16 : 28;
  if (cjk) for (let i = 0; i < title.length; i += max) lines.push(title.slice(i, i + max));
  else for (const w of words) { const l = lines[lines.length - 1]; if (l && (l + ' ' + w).length <= max) lines[lines.length - 1] = l + ' ' + w; else lines.push(w); }
  const shown = lines.slice(0, 4), fs = shown.length > 3 ? 60 : 70, y0 = 512 - (shown.length - 1) * fs * 0.62;
  let seed = 0; for (const ch of slug) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = seed % 360;
  const pts = []; for (let i = 0; i <= 40; i++) pts.push(`${(i * 40).toFixed(0)},${(900 + Math.sin(i / 3 + seed) * 60).toFixed(0)}`);
  const dots = Array.from({ length: 40 }, (_, i) => {
    const px = (seed * (i + 7) * 97) % 1536, py = (seed * (i + 3) * 61) % 1024;
    return `<circle cx="${px}" cy="${py}" r="${4 + (i % 5)}" fill="hsl(${(hue + i * 37) % 360},90%,65%)" opacity=".55"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1024" viewBox="0 0 1536 1024">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b0f14"/><stop offset="1" stop-color="hsl(${hue},45%,14%)"/></linearGradient>
<linearGradient id="s" x1="0" x2="1"><stop offset="0" stop-color="#7cff6b"/><stop offset=".5" stop-color="#22d3ee"/><stop offset="1" stop-color="#fbbf24"/></linearGradient></defs>
<rect width="1536" height="1024" fill="url(#g)"/>${dots}
<polyline points="${pts.join(' ')}" fill="none" stroke="url(#s)" stroke-width="46" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>
<text x="96" y="140" font-family="system-ui,Segoe UI,sans-serif" font-size="44" font-weight="900" fill="#e8eef5">Game<tspan fill="#7cff6b">Slither</tspan></text>
${shown.map((l, i) => `<text x="96" y="${(y0 + i * fs * 1.2).toFixed(0)}" font-family="system-ui,Segoe UI,Noto Sans,sans-serif" font-size="${fs}" font-weight="800" fill="#ffffff">${x(l)}</text>`).join('\n')}
</svg>`;
  return { src: blog.saveMedia(Buffer.from(svg), 'svg', slug), credit: '' };
}

// Lỗi tạm thời (vượt giới hạn số ảnh mỗi phút 429, máy chủ bận 5xx, hết giờ chờ) → thử lại sau 20 giây, rồi 45 giây
const RETRY_WAITS = [20_000, 45_000];
const isTransient = e => /\b(429|500|502|503|504)\b|exhausted|unavailable|quota|rate limit|timeout|timed out|aborted/i.test(e.message);
async function withRetry(fn) {
  for (let k = 0; ; k++) {
    try { return await fn(); } catch (e) {
      if (k >= RETRY_WAITS.length || !isTransient(e)) throw e;
      console.warn(`[blog] tạo ảnh lỗi tạm thời (${e.message}) → thử lại sau ${RETRY_WAITS[k] / 1000}s`);
      await new Promise(r => setTimeout(r, RETRY_WAITS[k]));
    }
  }
}

// Tạo 1 ảnh theo nhà cung cấp đang có; lỗi thì trả null (không làm hỏng cả bài) và ghi lý do vào errors.
// strict: báo lỗi ra ngoài ngay, không thử lại (nút tạo ảnh trong trang quản trị — Nginx chỉ chờ 60 giây).
async function makeImage(img, { slug, title, index = 0, cover = false, strict = false, errors = null }) {
  const kind = capabilities().image;
  if (kind === 'svg') return cover ? svgCover(title, slug) : null;
  const generate = async () => {
    if (kind === 'pexels') return pexelsImage(img.query, slug, index);
    const buf = kind === 'vertex' ? await vertexImage(img.prompt) : await openaiImage(img.prompt);
    return { src: await saveAiImage(buf, slug), credit: '' };
  };
  if (strict) return generate();
  try { return await withRetry(generate); } catch (e) {
    console.warn(`[blog] tạo ảnh lỗi: ${e.message}`);
    if (errors) errors.push(e.message);
    return cover ? svgCover(title, slug) : null;
  }
}

// Ảnh đã tạo nhưng bài không có dòng [[IMAGE n]] tương ứng → chèn trước các tiêu đề "##", rải đều trong bài.
function addMissingMarkers(content, made) {
  const missing = [];
  for (let k = 1; k < made.length; k++) {
    if (made[k] && !new RegExp(`^[ \\t]*\\[\\[IMAGE ${k + 1}\\]\\][ \\t]*$`, 'm').test(content)) missing.push(k);
  }
  if (!missing.length) return content;
  const lines = content.split('\n');
  // bỏ các tiêu đề ngay sau một ảnh có sẵn, để 2 ảnh không đứng sát nhau
  const prevLine = i => { while (--i >= 0 && !lines[i].trim()); return i >= 0 ? lines[i] : ''; };
  const heads = lines.map((l, i) => (/^##\s/.test(l) && !/\[\[IMAGE \d\]\]/.test(prevLine(i)) ? i : -1)).filter(i => i > 0);
  const at = missing.map((k, j) => [heads.length ? heads[Math.min(heads.length - 1, Math.max(1, Math.round((j + 1) * heads.length / (missing.length + 1))))] : lines.length, k]);
  for (const [i, k] of at.sort((x, y) => y[0] - x[0])) lines.splice(i, 0, `[[IMAGE ${k + 1}]]`, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------- tác vụ nền
// Viết bài mất 1–3 phút → chạy nền, trang quản trị hỏi tiến độ qua jobId.
const jobs = new Map();   // id -> { status, step, postId, error, startedAt }
const MAX_RUNNING = 3;

function startJob(opts) {
  if (!capabilities().text) throw new Error('Chưa cấu hình ANTHROPIC_API_KEY trong file .env.');
  if ([...jobs.values()].filter(j => j.status === 'running').length >= MAX_RUNNING) throw new Error('Đang viết tối đa 3 bài cùng lúc, đợi xong rồi thử lại.');
  const id = Math.random().toString(36).slice(2, 10);
  const job = { id, status: 'running', step: 'Đang viết nội dung…', postId: 0, error: '', startedAt: Date.now(), topic: opts.topic };
  jobs.set(id, job);
  for (const [k, j] of jobs) if (Date.now() - j.startedAt > 6 * 3600_000) jobs.delete(k);   // dọn tác vụ cũ
  // gợi ý biến khỏi danh sách ngay khi bắt đầu viết (không đợi 1–3 phút); viết lỗi thì trả lại để viết lại
  if (opts.ideaId) db.setIdeaStatus(opts.ideaId, 'used');

  (async () => {
    const a = await writeArticle(opts);
    const L = langOf(opts.lang);
    job.step = 'Đang tạo ảnh…';
    const credits = [];
    let cover = '', coverAlt = '';
    const made = [], errors = [];
    for (let i = 0; i < a.images.length; i++) {
      job.step = `Đang tạo ảnh ${i + 1}/${a.images.length}…`;
      made[i] = await makeImage(a.images[i], { slug: a.slug, title: a.title, index: i, cover: i === 0, errors });
      if (made[i] && made[i].credit) credits.push(made[i].credit);
    }
    if (made[0]) { cover = made[0].src; coverAlt = a.images[0].alt; }
    const wanted = Math.max(1, Math.min(4, Number(opts.images) || 1));
    const notes = [];
    if (a.images.length < wanted) notes.push(`AI chỉ mô tả ${a.images.length}/${wanted} ảnh`);
    if (errors.length) notes.push(`${errors.length} ảnh không tạo được: ${errors[0]}`);
    const content = addMissingMarkers(a.content, made).replace(/^[ \t]*\[\[IMAGE (\d)\]\][ \t]*$/gm, (_, n) => {
      const k = Number(n) - 1, m = made[k];
      return m && k > 0 ? `![${a.images[k].alt.replace(/[\[\]]/g, '')}](${m.src})` : '';
    }).replace(/\n{3,}/g, '\n\n');
    job.step = 'Đang lưu…';
    job.postId = db.savePost({
      lang: L.code, slug: a.slug, title: a.title, description: a.description, keywords: a.keywords, excerpt: a.excerpt,
      content, faq: a.faq, cover, cover_alt: coverAlt, credit: [...new Set(credits)].join(', '), topic: opts.topic,
      status: opts.publish ? 'published' : 'draft',
    });
    if (CLUSTER_KEYS.includes(opts.cluster)) db.setPostCluster(job.postId, opts.cluster);
    job.status = 'done';
    job.step = (opts.publish ? 'Đã đăng bài.' : 'Đã lưu bản nháp.') + (notes.length ? ` ⚠️ ${notes.join(' · ')}` : '');
  })().catch(e => {
    console.error('[blog] viết bài lỗi:', e);
    if (opts.ideaId) db.setIdeaStatus(opts.ideaId, 'suggested');
    job.status = 'error';
    job.error = friendlyError(e);
  });
  return job;
}

module.exports = { capabilities, CLUSTERS, MAX_COUNT, openIdeas, matchIdea, suggestTopics: o => suggestTopics(o).catch(e => { throw new Error(friendlyError(e)); }),
  startJob, getJob: id => jobs.get(id) || null, makeImage, uniqueSlug, toSlug };
