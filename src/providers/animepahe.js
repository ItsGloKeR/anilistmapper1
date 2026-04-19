import axios from 'axios';
import * as cheerio from 'cheerio';
import { extractKwik } from '../extractors/kwik.js';

export class AnimePahe {
  constructor() {
    this.baseUrl = "https://animepahe.pw";
    this.sourceName = 'AnimePahe';
    this.isMulti = false;
  }

  async scrapeSearchResults(query) {
    try {
      const response = await axios.get(`${this.baseUrl}/api?m=search&l=8&q=${query}`, {
        headers: { 'Cookie': "__ddg1_=;__ddg2_=;" }
      });

      if (!response.data.data) return [];
      
      return response.data.data.map(item => ({
        id: `${item.id}-${item.title}`,
        title: item.title,
        name: item.title,
        type: item.type || 'TV',
        status: item.status || 'Unknown',
        season: item.season || 'Unknown',
        year: item.year || 0,
        score: item.score || 0,
        poster: item.poster,
        session: item.session,
        episodes: { sub: item.episodes || null, dub: '??' }
      }));
    } catch (error) {
      throw new Error('Failed to search AnimePahe');
    }
  }

  async scrapeEpisodes(url) {
    try {
      const [id, ...titleParts] = url.split('-');
      const title = titleParts.join('-');
      const session = await this._getSession(title, id);
      const epUrl = `${this.baseUrl}/api?m=release&id=${session}&sort=episode_desc&page=1`;
      const response = await axios.get(epUrl);
      return await this._recursiveFetchEpisodes(epUrl, JSON.stringify(response.data), session);
    } catch (error) {
      throw new Error('Failed to fetch episodes');
    }
  }

  async _recursiveFetchEpisodes(url, responseData, session) {
    const jsonResult = JSON.parse(responseData);
    const page = jsonResult.current_page;
    let episodes = jsonResult.data.map(item => ({
      title: `Episode ${item.episode}`,
      episodeId: `${session}/${item.session}`,
      number: item.episode,
      image: item.snapshot,
    }));

    if (page < jsonResult.last_page) {
      const nextUrl = `${url.split("&page=")[0]}&page=${page + 1}`;
      const nextRes = await axios.get(nextUrl);
      const more = await this._recursiveFetchEpisodes(nextUrl, JSON.stringify(nextRes.data), session);
      episodes = [...episodes, ...more.episodes];
      return { ...more, episodes: episodes.sort((a, b) => a.number - b.number) };
    }

    // Final base case: fetch details
    const detailUrl = `${this.baseUrl}/a/${jsonResult.data[0].anime_id}`;
    const detailRes = await axios.get(detailUrl);
    const $ = cheerio.load(detailRes.data);
    return {
      title: $('.title-wrapper span').text().trim(),
      session,
      totalEpisodes: jsonResult.total,
      episodes: episodes.sort((a, b) => a.number - b.number)
    };
  }

  async fetchEpisodeSources(episodeId, options = {}) {
    return this.scrapeEpisodesSrcs(episodeId);
  }

  async scrapeEpisodesSrcs(episodeId) {
    try {
      const response = await axios.get(`${this.baseUrl}/play/${episodeId}`, {
        headers: { 'Cookie': "__ddg1_=;__ddg2_=;" }
      });

      const $ = cheerio.load(response.data);
      const videoLinks = [];

      // Improved Selector: AnimePahe often puts links in buttons or a dropdown
      const buttons = $('#resolutionMenu button, #pickDownload a');

      for (let i = 0; i < buttons.length; i++) {
        const btn = $(buttons[i]);
        const kwikLink = btn.attr('data-src') || btn.attr('href');
        const quality = btn.text().trim();

        if (kwikLink && kwikLink.includes('kwik.cx')) {
          const extraction = await extractKwik(kwikLink);
          if (extraction) {
            videoLinks.push({ quality, ...extraction });
          }
        }
      }

      // Final fallback: check for an iframe directly
      if (videoLinks.length === 0) {
        const iframeSrc = $('iframe').attr('src');
        if (iframeSrc?.includes('kwik.cx')) {
          const extraction = await extractKwik(iframeSrc);
          if (extraction) videoLinks.push({ quality: 'Default', ...extraction });
        }
      }

      return {
        headers: {
          "Referer": "https://kwik.cx/",
          "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36",
          "Origin": "https://kwik.cx"
        },
        sources: videoLinks
      };
    } catch (error) {
      throw new Error('Failed to fetch episode sources');
    }
  }

  async _getSession(title, animeId) {
    const response = await axios.get(`${this.baseUrl}/api?m=search&q=${title}`);
    const results = response.data.data;
    if (animeId) {
      const match = results.find(a => String(a.id) === String(animeId));
      if (match) return match.session;
    }
    return results[0].session;
  }
}

export default AnimePahe;
