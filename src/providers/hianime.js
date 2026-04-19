import { load } from 'cheerio';
import * as stringSimilarity from 'string-similarity-js';
import { client } from '../utils/client.js';
import { ANILIST_URL, ANILIST_QUERY, HIANIME_URL, ANIZIP_URL } from '../constants/api-constants.js';

// --- THE FIX: MANUAL MAPPING TABLE ---
const MANUAL_MAP = {
  // Attack on Titan Season 3 Part 2 (AniList: 10 episodes)
  '99147': {
    hianimeId: 'attack-on-titan-season-3-85', 
    range: [12, 22] // Index 12 is Ep 13, up to Ep 22
  },
  // Attack on Titan Final Season THE FINAL CHAPTERS Special 1
  '146903': {
    hianimeId: 'attack-on-titan-the-final-season-part-3-18329',
    range: [0, 1] // First episode only
  },
  // Attack on Titan Final Season THE FINAL CHAPTERS Special 2
  '164244': {
    hianimeId: 'attack-on-titan-the-final-season-part-3-18329',
    range: [1, 2] // Second episode only
  }
};

const normalizeText = (text) => {
  return text.toLowerCase()
    .replace(/(\d+)/g, ' $1 ')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

async function getAnimeInfo(id) {
  try {
    const res = await client.post(ANILIST_URL, { query: ANILIST_QUERY, variables: { id } });
    const d = res.data.data.Media;
    return d ? { id: d.id, title: d.title, episodes: d.episodes, synonyms: d.synonyms || [] } : null;
  } catch { return null; }
}

async function searchAnime(title, animeInfo) {
  // Check manual map first
  if (MANUAL_MAP[animeInfo.id.toString()]) {
    return MANUAL_MAP[animeInfo.id.toString()].hianimeId;
  }

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
        
        // Basic similarity check for all other anime (like Angel Next Door)
        const score = stringSimilarity.stringSimilarity(normalizeText(t), normalizeText(hTitle));
        if (score > bestMatch.score) bestMatch = { score, id: hId };
      });
      if (bestMatch.score > 0.9) break;
    }
    return bestMatch.id;
  } catch { return null; }
}

async function getEpisodeIds(hianimeId, anilistId) {
  try {
    // The ID needed for the AJAX call is just the numeric part at the end of the slug
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

    // HiAnime uses .ss-list .ep-item for the links
    $('.ss-list a.ep-item').each((i, el) => {
      const href = $(el).attr('href');
      const id = href.split('?ep=')[1];
      allEpisodes.push({
        episodeId: `${hianimeId}?ep=${id}`,
        number: i + 1,
        title: $(el).attr('title') || `Episode ${i + 1}`
      });
    });

    // --- APPLY ATTACK ON TITAN RANGE MAPPING ---
    let finalEpisodes = allEpisodes;
    const mapEntry = MANUAL_MAP[anilistId.toString()];
    
    if (mapEntry && mapEntry.range) {
      finalEpisodes = allEpisodes.slice(mapEntry.range[0], mapEntry.range[1]);
      // Normalize episode numbers for the frontend (1, 2, 3...)
      finalEpisodes = finalEpisodes.map((ep, idx) => ({
        ...ep,
        number: idx + 1 
      }));
    }

    // Attach metadata from AniZip if available
    const episodesWithMeta = finalEpisodes.map(ep => {
      const meta = azRes.data?.episodes?.[ep.number];
      return {
        ...ep,
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

export async function getEpisodesForAnime(anilistId) {
  const animeInfo = await getAnimeInfo(anilistId);
  if (!animeInfo) throw new Error('AniList data failed');

  const hId = await searchAnime(animeInfo.title.english || animeInfo.title.romaji, animeInfo);
  if (!hId) throw new Error('HiAnime ID not found');

  const episodeData = await getEpisodeIds(hId, anilistId);
  return {
    anilistId,
    hianimeId: hId,
    title: animeInfo.title.english || animeInfo.title.romaji,
    ...episodeData
  };
}

export default { getEpisodesForAnime };
