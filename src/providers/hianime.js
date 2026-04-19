import { load } from 'cheerio';
import * as stringSimilarity from 'string-similarity-js';
import { client } from '../utils/client.js';
import { ANILIST_URL, ANILIST_QUERY, HIANIME_URL, ANIZIP_URL } from '../constants/api-constants.js';

// --- MANUAL MAPPING TABLE ---
const MANUAL_MAP = {
  // Season 3 Part 1 (AniList: 12 episodes)
  '99146': {
    hianimeId: 'attack-on-titan-season-3-85', 
    range: [0, 12] // First 12 episodes
  },
  // Season 3 Part 2 (AniList: 10 episodes)
  '99147': {
    hianimeId: 'attack-on-titan-season-3-85', 
    range: [12, 22] // Skip first 12, take the next 10 (Total 22)
  },
  // Final Chapters Special 1
  '146903': {
    hianimeId: 'attack-on-titan-the-final-season-part-3-18329',
    range: [0, 1] 
  },
  // Final Chapters Special 2
  '164244': {
    hianimeId: 'attack-on-titan-the-final-season-part-3-18329',
    range: [1, 2] 
  }
};

const normalizeText = (text) => {
  return text?.toLowerCase()
    .replace(/(\d+)/g, ' $1 ')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || '';
};

async function getEpisodeIds(hianimeId, anilistId) {
  try {
    // Extract the numeric ID for the AJAX call (e.g., 85)
    const numericId = hianimeId.split('-').pop();
    const epUrl = `${HIANIME_URL}/ajax/v2/episode/list/${numericId}`;

    const [epRes, azRes] = await Promise.all([
      client.get(epUrl, { 
        headers: { 
          'Referer': `${HIANIME_URL}/watch/${hianimeId}`, 
          'X-Requested-With': 'XMLHttpRequest' 
        } 
      }),
      client.get(`${ANIZIP_URL}?anilist_id=${anilistId}`).catch(() => ({ data: null }))
    ]);

    if (!epRes.data.html) return { totalEpisodes: 0, episodes: [] };
    
    const $ = load(epRes.data.html);
    let allEpisodes = [];

    // HiAnime AJAX response uses .ep-item for episodes
    $('.ss-list a.ep-item').each((i, el) => {
      const href = $(el).attr('href');
      if (href && href.includes('?ep=')) {
        const epDataId = href.split('?ep=')[1];
        allEpisodes.push({
          episodeId: `${hianimeId}?ep=${epDataId}`,
          originalIndex: i + 1,
          title: $(el).attr('title') || `Episode ${i + 1}`
        });
      }
    });

    // --- APPLY ATTACK ON TITAN RANGE MAPPING ---
    let finalEpisodes = allEpisodes;
    const mapEntry = MANUAL_MAP[anilistId.toString()];
    
    if (mapEntry && mapEntry.range) {
      // slice(start, end) picks the specific episodes from the 22-episode list
      finalEpisodes = allEpisodes.slice(mapEntry.range[0], mapEntry.range[1]);
    }

    // Map metadata and normalize numbers to start from 1 for the UI
    const episodesWithMeta = finalEpisodes.map((ep, idx) => {
      const displayNum = idx + 1;
      const meta = azRes.data?.episodes?.[displayNum];
      
      return {
        episodeId: ep.episodeId, // Keeps the CORRECT link from the full list
        number: displayNum,      // Shows as Ep 1, 2, 3... in your app
        title: meta?.title?.en || ep.title,
        image: meta?.image || null,
        overview: meta?.overview || null
      };
    });

    return { totalEpisodes: episodesWithMeta.length, episodes: episodesWithMeta };
  } catch (error) {
    console.error("Episode Fetch Error:", error);
    return { totalEpisodes: 0, episodes: [] };
  }
}

// ... Rest of your searchAnime and getAnimeInfo functions remain the same ...

export async function getEpisodesForAnime(anilistId) {
  const animeInfo = await getAnimeInfo(anilistId);
  if (!animeInfo) throw new Error('AniList data failed');

  // Use manual map if exists, else search
  const hId = MANUAL_MAP[anilistId.toString()]?.hianimeId || 
              await searchAnime(animeInfo.title.english || animeInfo.title.romaji, animeInfo);

  if (!hId) throw new Error('HiAnime ID not found');

  const episodeData = await getEpisodeIds(hId, anilistId);
  return {
    anilistId,
    hianimeId: hId,
    title: animeInfo.title.english || animeInfo.title.romaji,
    ...episodeData
  };
}

async function getAnimeInfo(id) {
  try {
    const res = await client.post(ANILIST_URL, { query: ANILIST_QUERY, variables: { id } });
    const d = res.data.data.Media;
    return d ? { id: d.id, title: d.title, episodes: d.episodes, synonyms: d.synonyms || [] } : null;
  } catch { return null; }
}

async function searchAnime(title, animeInfo) {
  try {
    const titles = [animeInfo.title.english, animeInfo.title.romaji, ...animeInfo.synonyms].filter(Boolean);
    let bestMatch = { score: 0, id: null };

    for (const t of titles) {
      const res = await client.get(`${HIANIME_URL}/search?keyword=${encodeURIComponent(t)}`);
      const $ = load(res.data);
      $('.flw-item').each((_, item) => {
        const a = $(item).find('.film-name a');
        const hTitle = a.text().trim();
        const hId = a.attr('href')?.split('/').pop()?.split('?')[0];
        const score = stringSimilarity.stringSimilarity(normalizeText(t), normalizeText(hTitle));
        if (score > bestMatch.score) bestMatch = { score, id: hId };
      });
      if (bestMatch.score > 0.9) break;
    }
    return bestMatch.id;
  } catch { return null; }
}

export default { getEpisodesForAnime };
