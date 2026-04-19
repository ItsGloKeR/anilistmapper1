import axios from 'axios';
import * as cheerio from 'cheerio';
import { extractKwik } from '../extractors/kwik.js';

export class AnimePahe {
  constructor() {
    this.baseUrl = "https://animepahe.pw";
    this.sourceName = 'AnimePahe';
  }

  // ... (keep your searchResults and recursiveFetchEpisodes as they were)

  async scrapeEpisodesSrcs(episodeId) {
    try {
      const response = await axios.get(`${this.baseUrl}/play/${episodeId}`, {
        headers: { 'Cookie': "__ddg1_=;__ddg2_=;" }
      });

      const $ = cheerio.load(response.data);
      const buttons = $('#resolutionMenu > button');
      const videoLinks = [];

      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        const kwikLink = $(btn).attr('data-src');
        const quality = $(btn).text().trim();

        try {
          const extraction = await extractKwik(kwikLink);
          if (extraction?.url) {
            videoLinks.push({
              quality,
              url: extraction.url,
              isM3U8: extraction.isM3U8,
            });
          }
        } catch (e) {
          console.error(`Error extracting Kwik (${quality}):`, e.message);
        }
      }

      return {
        // These headers MUST be sent by the video player
        headers: {
          "Referer": "https://kwik.cx/",
          "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36",
          "Origin": "https://kwik.cx"
        },
        sources: videoLinks
      };
    } catch (error) {
      console.error('Error fetching episode sources:', error.message);
      throw new Error('Failed to fetch episode sources');
    }
  }

  // ... (rest of the class)
}

export default AnimePahe;
