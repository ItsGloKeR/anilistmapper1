import { load } from 'cheerio';
import { client } from '../utils/client.js';

const DEFAULT_BASE = 'https://anikai.to';
// Ensure this worker is active and functional
const KAISVA_URL = 'https://ancient-wind-00be.itsgloker.workers.dev';

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest', // CRITICAL for Anikai AJAX
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

function fixUrl(url, base = DEFAULT_BASE) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${base.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class AnimeKai {
  constructor(baseUrl = DEFAULT_BASE) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Universal Request Wrapper with built-in retry and browser headers
   */
  async _request(url, config = {}, retries = 2) {
    for (let i = 0; i <= retries; i++) {
      try {
        const response = await client.get(url, {
          ...config,
          headers: { ...BASE_HEADERS, ...config.headers, Referer: this.baseUrl },
          timeout: 20000
        });
        return response.data;
      } catch (e) {
        if (i === retries) throw e;
        console.warn(`[Retry ${i + 1}] failed: ${e.message}`);
        await sleep(1000 * (i + 1));
      }
    }
  }

  async decodeParam(value, mode = 'e') {
    const url = new URL(KAISVA_URL);
    const paramName = mode === 'e' ? 'ilovefeet' : 'ilovearmpits';
    url.searchParams.set(paramName, value);
    // Use simple fetch/client for the worker to avoid header conflicts
    const { data } = await client.get(url.toString(), { responseType: 'text' });
    return data;
  }

  async search(query) {
    const url = `${this.baseUrl}/browser?keyword=${encodeURIComponent(query)}`;
    const html = await this._request(url, { responseType: 'text' });
    const $ = load(html);
    
    const results = $("div.aitem-wrapper div.aitem").map((_, el) => {
      const item = $(el);
      const href = item.find('a.poster').attr('href');
      return {
        id: fixUrl(href, this.baseUrl),
        url: fixUrl(href, this.baseUrl),
        title: item.find('a.title').text().trim(),
        image: fixUrl(item.find('img').attr('data-src') || item.find('img').attr('src'), this.baseUrl),
        subCount: parseInt(item.find('span.sub').text()) || 0,
        dubCount: parseInt(item.find('span.dub').text()) || 0,
        type: item.find('.fdi-item').first().text().trim().toLowerCase()
      };
    }).get();

    return { results };
  }

  async fetchAnimeInfo(idOrUrl) {
    const url = fixUrl(idOrUrl, this.baseUrl);
    const html = await this._request(url, { responseType: 'text' });
    const $ = load(html);

    const animeId = $('div.rate-box').attr('data-id');
    if (!animeId) throw new Error("Could not find Anime ID on page.");

    const underscore = await this.decodeParam(animeId, 'e');
    const listJson = await this._request(`${this.baseUrl}/ajax/episodes/list`, {
      params: { ani_id: animeId, _: underscore }
    });

    const $$ = load(listJson.result || '');
    const episodes = [];
    $$("div.eplist a").each((index, el) => {
      const a = $$(el);
      episodes.push({
        id: a.attr('token'),
        number: parseInt(a.attr('num')) || (index + 1),
        title: a.find('span').text().trim()
      });
    });

    return {
      id: url,
      title: $('h1.title').text().trim(),
      image: fixUrl($('.watch-section-bg').attr('style')?.match(/url\((.*?)\)/)?.[1].replace(/['"]/g, ''), this.baseUrl),
      episodes
    };
  }

  async fetchEpisodeSources(episodeToken, dub = false) {
    const underscoreToken = await this.decodeParam(episodeToken, 'e');
    const listJson = await this._request(`${this.baseUrl}/ajax/links/list`, {
      params: { token: episodeToken, _: underscoreToken }
    });

    const $ = load(listJson.result || '');
    const type = dub ? 'dub' : 'sub';
    const serverEl = $(`div.server-items[data-id=${type}] span.server`).first();
    
    if (!serverEl.length) throw new Error(`No ${type} servers found.`);

    const lid = serverEl.attr('data-lid');
    const underscoreLid = await this.decodeParam(lid, 'e');
    
    const viewJson = await this._request(`${this.baseUrl}/ajax/links/view`, {
      params: { id: lid, _: underscoreLid }
    });

    const decoded = await this.decodeParam(viewJson.result, 'd');
    let finalData;
    try {
      finalData = JSON.parse(decoded);
    } catch {
      // Fallback if worker returns raw string instead of JSON object
      const match = decoded.match(/"url"\s*:\s*"(.*?)"/);
      finalData = { url: match ? match[1].replace(/\\\//g, '/') : '' };
    }

    return {
      headers: { ...BASE_HEADERS, Referer: this.baseUrl },
      sources: [{ url: finalData.url, isM3U8: finalData.url.includes('.m3u8') }],
      subtitles: []
    };
  }
}

export default AnimeKai;
