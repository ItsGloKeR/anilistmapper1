import { load } from 'cheerio';
import * as stringSimilarity from 'string-similarity-js';
import { client } from '../utils/client.js';
import { ANILIST_URL, ANILIST_QUERY, HIANIME_URL, ANIZIP_URL } from '../constants/api-constants.js';

// --- MANUAL MAPPING FOR ATTACK ON TITAN ---
const AOT_MANUAL_MAP = {
  // Season 3 Part 2
  '99147': {
    hianimeId: 'attack-on-titan-season-3-162',
    slice: [12, 22], // Start at index 12 (Ep 13), end at index 22
  },
  // Final Season (Part 1)
  '110277': {
    hianimeId: 'attack-on-titan-the-final-season-1614',
  },
  // Final Season Part 2
  '131681': {
    hianimeId: 'attack-on-titan-the-final-season-part-2-17885',
  },
  // Final Chapters Special 1
  '146903': {
    hianimeId: 'attack-on-titan-the-final-season-part-3-18329',
    slice: [0, 1], // Just the first episode
  },
  // Final Chapters Special 2
  '164244': {
    hianimeId: 'attack-on-titan-the-final-season-part-3-18329',
    slice: [1, 2], // Just the second episode
  }
};

const TITLE_REPLACEMENTS = {
  'season': ['s', 'sz'],
  's': ['season', 'sz'],
  'sz': ['season', 's'],
  'two': ['2', 'ii'],
  'three': ['3', 'iii'],
  'four': ['4', 'iv'],
  'part': ['pt', 'p'],
  'first': ['1', 'i'],
  'second': ['2', 'ii'],
  'third': ['3', 'iii']
};

const wordVariationsCache = new Map();

const normalizeText = (text) => {
  return text.toLowerCase()
    .replace(/(\d+)/g, ' $1 ')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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
  const nSearch = normalizeText(searchTitle);
  const nTitle = normalizeText(hianimeTitle);
  if (nSearch === nTitle) return 1;

  const getNum = (t) => t.match(/\d+$/)?.[0];
  if (getNum(nSearch) !== getNum(nTitle)) return 0.2;

  const sWords = nSearch.split(' ');
  const tWords = nTitle.split(' ');
  let matches = 0;
  for (const sVar of sWords.map(w => getWordVariations(w))) {
    if (tWords.some(tW => sVar.includes(tW))) matches++;
  }

  const wordScore = matches / Math.max(sWords.length, tWords.length);
  const similarity = stringSimilarity.stringSimilarity(nSearch, nTitle);
  return ((wordScore * 0.6) + (similarity * 0.4)) * (Math.min(sWords.length, tWords.length) / Math.max(sWords.length, tWords.length));
};

async function searchAnime(title, animeInfo) {
  // Apply Manual Map
  if (AOT_MANUAL_MAP[animeInfo.id.toString()]) {
    return AOT_MANUAL_MAP[animeInfo.id.toString()].hianimeId;
  }

  try {
    let bestMatch = { score: 0, id: null };
    const titles = [animeInfo.title.english, animeInfo.title.romaji, ...animeInfo.synonyms].filter(Boolean);

    for (const t of titles) {
      const res = await client.get(`${HIANIME_URL}/search?keyword=${encodeURIComponent(t)}`);
      const $ = load(res.data);
      $('.flw-item').each((_, item) => {
        const el = $(item).find('.film-name a');
        const hTitle = el.text().trim();
        const hId = el.attr('href')?.split('/').pop()?.split('?')[0];
        const score = calculateTitleScore(t, hTitle);
        if (score > bestMatch.score) bestMatch = { score, id: hId };
      });
      if (bestMatch.score > 0.95) break;
    }
    return bestMatch.score > 0.5 ? bestMatch.id : null;
  } catch { return null; }
}

async function getEpisodeIds(animeId, anilistId) {
  try {
    const epUrl = `${HIANIME_URL}/ajax/v2/episode/list/${animeId.split('-').pop()}`;
    const [epRes, azRes] = await Promise.all([
      client.get(epUrl, { headers: { 'Referer': `${HIANIME_URL}/watch/${animeId}`, 'X-Requested-With': 'XMLHttpRequest' } }),
      client.get(`${ANIZIP_URL}?anilist_id=${anilistId}`).catch(() => ({ data: null }))
    ]);

    if (!epRes.data.html) return { totalEpisodes: 0, episodes: [] };
    const $ = load(epRes.data.html);
    let episodes = [];

    $('a.ep-item').each((i, el) => {
      episodes.push({
        episodeId: `${animeId}?ep=${$(el).attr('href').split('?ep=')[1]}`,
        number: i + 1,
        title: $(el).attr('title') || `Episode ${i + 1}`
      });
    });

    // --- APPLY AOT SLICING LOGIC ---
    const mapping = AOT_MANUAL_MAP[anilistId.toString()];
    if (mapping && mapping.slice) {
      episodes = episodes.slice(mapping.slice[0], mapping.slice[1]);
      // Reset numbers to 1, 2, 3... for the UI
      episodes = episodes.map((ep, idx) => ({ ...ep, number: idx + 1 }));
    }

    const finalEpisodes = episodes.map(ep => {
      const meta = azRes.data?.episodes?.[ep.number];
      return {
        ...ep,
        title: meta?.title?.en || ep.title,
        image: meta?.image || null,
        overview: meta?.overview || null
      };
    });

    return { totalEpisodes: finalEpisodes.length, episodes: finalEpisodes };
  } catch { return { totalEpisodes: 0, episodes: [] }; }
}

export async function getEpisodesForAnime(anilistId) {
  const animeInfo = await getAnimeInfo(anilistId);
  if (!animeInfo) throw new Error('AniList fetch failed');
  const hId = await searchAnime(animeInfo.title.english || animeInfo.title.romaji, animeInfo);
  if (!hId) throw new Error('HiAnime ID not found');
  const episodes = await getEpisodeIds(hId, anilistId);
  return { anilistId, hianimeId: hId, title: animeInfo.title.english || animeInfo.title.romaji, ...episodes };
}

async function getAnimeInfo(id) {
  try {
    const res = await client.post(ANILIST_URL, { query: ANILIST_QUERY, variables: { id } });
    const d = res.data.data.Media;
    return d ? { id: d.id, title: d.title, episodes: d.episodes, synonyms: d.synonyms || [] } : null;
  } catch { return null; }
}

export default { getEpisodesForAnime };
