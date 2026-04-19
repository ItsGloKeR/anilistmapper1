import { load } from 'cheerio';
import * as stringSimilarity from 'string-similarity-js';
import { client } from '../utils/client.js';
import { ANILIST_URL, ANILIST_QUERY, HIANIME_URL, ANIZIP_URL } from '../constants/api-constants.js';

// --- MANUAL MAPPING (AOT EXCEPTIONS) ---
const MANUAL_MAP = {
  '99146': { hianimeId: 'attack-on-titan-season-3-85', range: [0, 12] },
  '104578': { hianimeId: 'attack-on-titan-season-3-85', range: [12, 22] },
  '146903': { hianimeId: 'attack-on-titan-the-final-season-part-3-18329', range: [0, 1] },
  '164244': { hianimeId: 'attack-on-titan-the-final-season-part-3-18329', range: [1, 2] }
};

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

// --- UNIVERSAL LOGIC ---
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

  const getTrailingNum = (t) => t.match(/\d+$/)?.[0];
  const searchNum = getTrailingNum(normalizedSearch);
  const titleNum = getTrailingNum(normalizedTitle);

  if (searchNum !== titleNum) return 0.2;

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

// --- CORE SCRAPING ---
async function getAnimeInfo(anilistId) {
  try {
    const response = await client.post(ANILIST_URL, {
      query: ANILIST_QUERY,
      variables: { id: anilistId }
    });
    const animeData = response.data.data.Media;
    if (!animeData) return null;
    const allTitles = new Set([
      ...(animeData.synonyms || []),
      animeData.title.english,
      animeData.title.romaji
    ].filter(Boolean).filter(t => !(/[\u4E00-\u9FFF]/.test(t))));

    return { id: animeData.id, title: animeData.title, episodes: animeData.episodes, synonyms: [...allTitles] };
  } catch { return null; }
}

async function searchAnime(title, animeInfo) {
  if (MANUAL_MAP[animeInfo.id.toString()]) return MANUAL_MAP[animeInfo.id.toString()].hianimeId;

  try {
    let bestMatch = { score: 0, id: null };
    let seriesMatches = [];
    const titlesToTry = [animeInfo.title.english, animeInfo.title.romaji, ...animeInfo.synonyms]
      .filter(Boolean).filter((t, i, arr) => arr.indexOf(t) === i);

    for (const searchTitle of titlesToTry) {
      const searchUrl = `${HIANIME_URL}/search?keyword=${encodeURIComponent(searchTitle)}`;
      const response = await client.get(searchUrl);
      const $ = load(response.data);

      $('.film_list-wrap > .flw-item').each((_, item) => {
        const el = $(item).find('.film-detail .film-name a');
        const hTitle = el.text().trim();
        const hId = el.attr('href')?.split('/').pop()?.split('?')[0];
        const isTV = $(item).find('.fd-infor .fdi-item').first().text().trim() === 'TV';
        const episodesCount = parseInt($(item).find('.tick-item.tick-eps').text().trim()) || 0;

        if (hId) {
          let score = calculateTitleScore(searchTitle, hTitle);
          if (isTV && animeInfo.episodes > 12) score += 0.05;
          if (animeInfo.episodes && episodesCount === animeInfo.episodes) score += 0.1;

          if (score > 0.4) seriesMatches.push({ id: hId, score });
          if (score > bestMatch.score) bestMatch = { score, id: hId };
        }
      });
      if (bestMatch.score > 0.95) break;
    }
    if (seriesMatches.length > 0) {
      seriesMatches.sort((a, b) => b.score - a.score);
      return seriesMatches[0].id;
    }
    return bestMatch.score > 0.5 ? bestMatch.id : null;
  } catch { return null; }
}

async function getEpisodeIds(hianimeId, anilistId) {
  try {
    const numericId = hianimeId.split('-').pop();
    const episodeUrl = `${HIANIME_URL}/ajax/v2/episode/list/${numericId}`;
    const anizipUrl = `${ANIZIP_URL}?anilist_id=${anilistId}`;

    const [episodeResponse, anizipResponse] = await Promise.all([
      client.get(episodeUrl, { headers: { 'Referer': `${HIANIME_URL}/watch/${hianimeId}`, 'X-Requested-With': 'XMLHttpRequest' } }),
      client.get(anizipUrl).catch(() => ({ data: null }))
    ]);

    if (!episodeResponse.data.html) return { totalEpisodes: 0, episodes: [] };
    const $ = load(episodeResponse.data.html);
    const anizipData = anizipResponse.data;
    let allEpisodes = [];

    $('.ss-list a.ep-item').each((i, el) => {
      const href = $(el).attr('href');
      if (href && href.includes('?ep=')) {
        allEpisodes.push({
          episodeId: `${hianimeId}?ep=${href.split('?ep=')[1]}`,
          originalIndex: i + 1,
          title: $(el).attr('title') || `Episode ${i + 1}`
        });
      }
    });

    // --- APPLY AOT RANGE LOGIC ---
    let finalEpisodes = allEpisodes;
    const mapEntry = MANUAL_MAP[anilistId.toString()];
    if (mapEntry && mapEntry.range) {
      finalEpisodes = allEpisodes.slice(mapEntry.range[0], mapEntry.range[1]);
    }

    const episodesWithMeta = finalEpisodes.map((ep, idx) => {
      const displayNum = idx + 1;
      const meta = anizipData?.episodes?.[displayNum];
      return {
        ...ep,
        number: displayNum,
        title: meta?.title?.en || ep.title,
        image: meta?.image || null,
        overview: meta?.overview || null,
        airDate: meta?.airDate || null,
        runtime: meta?.runtime || null
      };
    });

    return { totalEpisodes: episodesWithMeta.length, episodes: episodesWithMeta };
  } catch { return { totalEpisodes: 0, episodes: [] }; }
}

export async function getEpisodesForAnime(anilistId) {
  const animeInfo = await getAnimeInfo(anilistId);
  if (!animeInfo) throw new Error('AniList Data Failed');

  const hianimeId = await searchAnime(animeInfo.title.english || animeInfo.title.romaji, animeInfo);
  if (!hianimeId) throw new Error('HiAnime ID not found');

  const episodes = await getEpisodeIds(hianimeId, anilistId);
  return { anilistId, hianimeId, title: animeInfo.title.english || animeInfo.title.romaji, ...episodes };
}

export default { getEpisodesForAnime };
