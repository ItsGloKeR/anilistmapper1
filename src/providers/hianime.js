import { load } from 'cheerio';
import * as stringSimilarity from 'string-similarity-js';
import { client } from '../utils/client.js';
import { ANILIST_URL, ANILIST_QUERY, HIANIME_URL, ANIZIP_URL } from '../constants/api-constants.js';

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
  return text.toLowerCase()
    .replace(/(\d+)/g, ' $1 ') // Force space around numbers: "Rotten2" -> "rotten 2"
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
    if (normalized === key) {
      values.forEach(v => variations.add(v));
    } else if (values.includes(normalized)) {
      variations.add(key);
      values.forEach(v => variations.add(v));
    }
  }

  const result = [...variations];
  wordVariationsCache.set(cacheKey, result);
  return result;
};

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
    ].filter(Boolean)
     .filter(t => !(/[\u4E00-\u9FFF]/.test(t))));

    return {
      id: animeData.id,
      title: animeData.title,
      episodes: animeData.episodes,
      synonyms: [...allTitles]
    };
  } catch (error) {
    console.error('Error fetching anime info:', error);
    return null;
  }
}

const calculateTitleScore = (searchTitle, hianimeTitle) => {
  const normalizedSearch = normalizeText(searchTitle);
  const normalizedTitle = normalizeText(hianimeTitle);

  if (normalizedSearch === normalizedTitle) return 1;

  // --- Strict Number Check ---
  // Extract trailing numbers or specific season markers
  const getTrailingNum = (t) => t.match(/\d+$/)?.[0];
  const searchNum = getTrailingNum(normalizedSearch);
  const titleNum = getTrailingNum(normalizedTitle);

  // If one has a trailing number and the other doesn't (Season 1 vs Season 2), penalize heavily
  if (searchNum !== titleNum) return 0.2;

  const searchWords = normalizedSearch.split(' ');
  const titleWords = normalizedTitle.split(' ');

  const searchVariations = searchWords.map(w => getWordVariations(w));
  const titleVariations = titleWords.map(w => getWordVariations(w));

  let matches = 0;
  for (const sVars of searchVariations) {
    if (titleVariations.some(tVars => tVars.some(v => sVars.includes(v)))) {
      matches++;
    }
  }

  const wordMatchScore = matches / Math.max(searchWords.length, titleWords.length);
  const similarity = stringSimilarity.stringSimilarity(normalizedSearch, normalizedTitle);

  // Penalty for significant length mismatch (prevents "Angel" matching "Angel Next Door")
  const lengthRatio = Math.min(searchWords.length, titleWords.length) / Math.max(searchWords.length, titleWords.length);

  return ((wordMatchScore * 0.6) + (similarity * 0.4)) * lengthRatio;
};

async function searchAnime(title, animeInfo) {
  try {
    let bestMatch = { score: 0, id: null };
    let seriesMatches = [];

    const titlesToTry = [
      animeInfo.title.english,
      animeInfo.title.romaji,
      ...animeInfo.synonyms
    ].filter(Boolean).filter((t, i, arr) => arr.indexOf(t) === i);

    for (const searchTitle of titlesToTry) {
      const searchUrl = `${HIANIME_URL}/search?keyword=${encodeURIComponent(searchTitle)}`;
      const response = await client.get(searchUrl);
      const $ = load(response.data);

      $('.film_list-wrap > .flw-item').each((_, item) => {
        const el = $(item).find('.film-detail .film-name a');
        const hianimeTitle = el.text().trim();
        const hianimeId = el.attr('href')?.split('/').pop()?.split('?')[0];
        const isTV = $(item).find('.fd-infor .fdi-item').first().text().trim() === 'TV';
        const episodesText = $(item).find('.tick-item.tick-eps').text().trim();
        const episodesCount = episodesText ? parseInt(episodesText, 10) : 0;
        
        if (hianimeId) {
          let score = calculateTitleScore(searchTitle, hianimeTitle);
          
          if (isTV && animeInfo.episodes > 12) score += 0.05;
          if (animeInfo.episodes && episodesCount === animeInfo.episodes) score += 0.1;

          if (score > 0.4) {
            seriesMatches.push({ title: hianimeTitle, id: hianimeId, score, isTV, episodes: episodesCount });
          }
          
          if (score > bestMatch.score) {
            bestMatch = { score, id: hianimeId };
          }
        }
      });

      // Threshold raised to 0.95 to ensure we don't grab "Season 2" by mistake
      if (bestMatch.score > 0.95) return bestMatch.id;
    }

    if (seriesMatches.length > 0) {
      seriesMatches.sort((a, b) => b.score - a.score);
      return seriesMatches[0].id;
    }

    return bestMatch.score > 0.5 ? bestMatch.id : null;
  } catch (error) {
    console.error('Error searching Hianime:', error);
    return null;
  }
}

async function getEpisodeIds(animeId, anilistId) {
  try {
    const episodeUrl = `${HIANIME_URL}/ajax/v2/episode/list/${animeId.split('-').pop()}`;
    const anizipUrl = `${ANIZIP_URL}?anilist_id=${anilistId}`;

    // Use separate catch for Anizip so it doesn't break everything if it's down
    const [episodeResponse, anizipResponse] = await Promise.all([
      client.get(episodeUrl, {
        headers: { 'Referer': `${HIANIME_URL}/watch/${animeId}`, 'X-Requested-With': 'XMLHttpRequest' }
      }),
      client.get(anizipUrl).catch(() => ({ data: null }))
    ]);

    if (!episodeResponse.data.html) return { totalEpisodes: 0, episodes: [] };

    const $ = load(episodeResponse.data.html);
    const episodes = [];
    const anizipData = anizipResponse.data;
    
    $('#detail-ss-list div.ss-list a').each((i, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      if (!href) return;

      const fullPath = href.split('/').pop();
      const episodeNumber = i + 1;
      const anizipEpisode = anizipData?.episodes?.[episodeNumber];
      
      if (fullPath) {
        episodes.push({
          episodeId: `${animeId}?ep=${fullPath.split('?ep=')[1]}`,
          title: anizipEpisode?.title?.en || $el.attr('title') || '',
          number: episodeNumber,
          image: anizipEpisode?.image || null,
          overview: anizipEpisode?.overview || null,
          airDate: anizipEpisode?.airDate || null,
          runtime: anizipEpisode?.runtime || null
        });
      }
    });

    return { 
      totalEpisodes: episodes.length, 
      episodes,
      titles: anizipData?.titles || null,
      images: anizipData?.images || null
    };
  } catch (error) {
    console.error('Error fetching episodes:', error);
    return { totalEpisodes: 0, episodes: [] };
  }
}

export async function getEpisodesForAnime(anilistId) {
  try {
    const animeInfo = await getAnimeInfo(anilistId);
    if (!animeInfo) throw new Error('Could not fetch anime info from Anilist');

    const title = animeInfo.title.english || animeInfo.title.romaji;
    if (!title) throw new Error('No title found');

    const hianimeId = await searchAnime(title, animeInfo);
    if (!hianimeId) throw new Error('Could not find anime on Hianime');

    const episodes = await getEpisodeIds(hianimeId, anilistId);
    return { anilistId, hianimeId, title, ...episodes };
  } catch (error) {
    console.error('Error in getEpisodesForAnime:', error);
    throw error;
  }
}

export default { getEpisodesForAnime };
