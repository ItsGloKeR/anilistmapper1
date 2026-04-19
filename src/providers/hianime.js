import { load } from 'cheerio';
import * as stringSimilarity from 'string-similarity-js';
import { client } from '../utils/client.js';
import { ANILIST_URL, ANILIST_QUERY, HIANIME_URL, ANIZIP_URL } from '../constants/api-constants.js';

// --- MANUAL MAPPING (The Surgical Override for AOT) ---
const MANUAL_MAP = {
  '99146': { hianimeId: 'attack-on-titan-season-3-85', range: [0, 12] },
  '104578': { hianimeId: 'attack-on-titan-season-3-85', range: [12, 22] },
  '146903': { hianimeId: 'attack-on-titan-the-final-season-part-3-18329', range: [0, 1] },
  '164244': { hianimeId: 'attack-on-titan-the-final-season-part-3-18329', range: [1, 2] }
};

// --- THE "OLD LOGIC" (Title Variations & Scoring) ---
const TITLE_REPLACEMENTS = {
  'season': ['s', 'sz'],
  's': ['season', 'sz'],
  'sz': ['season', 's'],
  'two': ['2', 'ii'],
  'three': ['3', 'iii'],
  'four': ['4', 'iv'],
  'part': ['pt', 'p'],
  'episode': ['ep'],
  'chapters': ['ch'],
  'chapter': ['ch'],
  'first': ['1', 'i'],
  'second': ['2', 'ii'],
  'third': ['3', 'iii'],
  'fourth': ['4', 'iv']
};

const wordVariationsCache = new Map();

const normalizeText = (text) => {
  return text?.toLowerCase()
    .replace(/(\d+)/g, ' $1 ') 
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || '';
};

const getWordVariations = (word) => {
  const cacheKey = word.toLowerCase();
  if (wordVariationsCache.has(cacheKey)) return wordVariationsCache.get(cacheKey);

  const variations = new Set([word]);
  const normalized = normalizeText(word);
  variations.add(normalized);

  for (const [key, values] of Object.entries(TITLE_REPLACEMENTS)) {
    if (normalized === key) values.forEach(v => variations.add(v));
    else if (values.includes(normalized)) {
      variations.add(key);
      values.forEach(v => variations.add(v));
    }
  }
  const result = [...variations];
  wordVariationsCache.set(cacheKey, result);
  return result;
};

const calculateTitleScore = (searchTitle, hianimeTitle) => {
  const normalizedSearch = normalizeText(searchTitle);
  const normalizedTitle = normalizeText(hianimeTitle);

  if (normalizedSearch === normalizedTitle) return 1;

  // Strict Number Check
  const getTrailingNum = (t) => t.match(/\d+$/)?.[0];
  if (getTrailingNum(normalizedSearch) !== getTrailingNum(normalizedTitle)) return 0.2;

  const searchWords = normalizedSearch.split(' ');
  const titleWords = normalizedTitle.split(' ');

  const searchVariations = searchWords.map(w => getWordVariations(w));
  const titleVariations = titleWords.map(w => getWordVariations(w));

  let matches = 0;
  for (const sVars of searchVariations) {
    if (titleVariations.some(tVars => tVars.some(v => sVars.includes(v)))) matches++;
  }

  const wordMatchScore = matches / Math.max(searchWords.length, titleWords.length);
  const similarity = stringSimilarity.stringSimilarity(normalizedSearch, normalizedTitle);
  const lengthRatio = Math.min(searchWords.length, titleWords.length) / Math.max(searchWords.length, titleWords.length);

  return ((wordMatchScore * 0.6) + (similarity * 0.4)) * lengthRatio;
};

// --- ANILIST INFO (Including Assets) ---
async function getAnimeInfo(anilistId) {
  const query = `
    query ($id: Int) {
      Media (id: $id, type: ANIME) {
        id
        title { english romaji }
        coverImage { extraLarge color }
        bannerImage
        synonyms
        episodes
        description
      }
    }
  `;

  try {
    const response = await client.post(ANILIST_URL, { query, variables: { id: parseInt(anilistId) } });
    const media = response.data.data.Media;
    if (!media) return null;

    const allTitles = new Set([
      ...(media.synonyms || []),
      media.title.english,
      media.title.romaji
    ].filter(Boolean).filter(t => !(/[\u4E00-\u9FFF]/.test(t))));

    return {
      id: media.id,
      title: media.title,
      banner: media.bannerImage,
      cover: media.coverImage.extraLarge,
      color: media.coverImage.color,
      episodes: media.episodes,
      synonyms: [...allTitles],
      description: media.description
    };
  } catch { return null; }
}

// --- SEARCH & EPISODE LOGIC ---
async function searchAnime(title, animeInfo) {
  // Manual map check first
  if (MANUAL_MAP[animeInfo.id.toString()]) return MANUAL_MAP[animeInfo.id.toString()].hianimeId;

  try {
    let bestMatch = { score: 0, id: null };
    const titlesToTry = [animeInfo.title.english, animeInfo.title.romaji, ...animeInfo.synonyms]
      .filter(Boolean).filter((t, i, arr) => arr.indexOf(t) === i);

    for (const searchTitle of titlesToTry) {
      const response = await client.get(`${HIANIME_URL}/search?keyword=${encodeURIComponent(searchTitle)}`);
      const $ = load(response.data);

      $('.flw-item').each((_, item) => {
        const el = $(item).find('.film-name a');
        const hTitle = el.text().trim();
        const hId = el.attr('href')?.split('/').pop()?.split('?')[0];
        
        const score = calculateTitleScore(searchTitle, hTitle);
        if (score > bestMatch.score) bestMatch = { score, id: hId };
      });
      if (bestMatch.score > 0.95) break;
    }
    return bestMatch.score > 0.5 ? bestMatch.id : null;
  } catch { return null; }
}

async function getEpisodeIds(hianimeId, anilistId) {
  try {
    const numericId = hianimeId.split('-').pop();
    const [epRes, azRes] = await Promise.all([
      client.get(`${HIANIME_URL}/ajax/v2/episode/list/${numericId}`, {
        headers: { 'Referer': `${HIANIME_URL}/watch/${hianimeId}`, 'X-Requested-With': 'XMLHttpRequest' }
      }),
      client.get(`${ANIZIP_URL}?anilist_id=${anilistId}`).catch(() => ({ data: null }))
    ]);

    if (!epRes.data.html) return { totalEpisodes: 0, episodes: [] };
    const $ = load(epRes.data.html);
    let allEpisodes = [];

    $('.ss-list a.ep-item').each((i, el) => {
      const href = $(el).attr('href');
      if (href && href.includes('?ep=')) {
        allEpisodes.push({
          episodeId: `${hianimeId}?ep=${href.split('?ep=')[1]}`,
          title: $(el).attr('title') || `Episode ${i + 1}`
        });
      }
    });

    const mapEntry = MANUAL_MAP[anilistId.toString()];
    const finalEpisodes = mapEntry?.range ? allEpisodes.slice(mapEntry.range[0], mapEntry.range[1]) : allEpisodes;

    const episodesWithMeta = finalEpisodes.map((ep, idx) => {
      const displayNum = idx + 1;
      const meta = azRes.data?.episodes?.[displayNum];
      return {
        ...ep,
        number: displayNum,
        title: meta?.title?.en || ep.title,
        image: meta?.image || null,
        overview: meta?.overview || null
      };
    });

    return { totalEpisodes: episodesWithMeta.length, episodes: episodesWithMeta };
  } catch { return { totalEpisodes: 0, episodes: [] }; }
}

export async function getEpisodesForAnime(anilistId) {
  const animeInfo = await getAnimeInfo(anilistId);
  if (!animeInfo) throw new Error('AniList Data Failed');

  const hId = await searchAnime(null, animeInfo);
  if (!hId) throw new Error('Match not found');

  const episodeData = await getEpisodeIds(hId, anilistId);

  return {
    ...animeInfo,
    hianimeId: hId,
    ...episodeData
  };
}

export default { getEpisodesForAnime };
