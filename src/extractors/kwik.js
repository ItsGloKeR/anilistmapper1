import axios from 'axios';

const kwikUserAgent = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36";

export async function extractKwik(kwikUrl) {
    try {
        const urlObj = new URL(kwikUrl);
        const refinedReferer = `${urlObj.protocol}//${urlObj.host}/`;

        const { data: html } = await axios.get(kwikUrl, {
            headers: {
                'User-Agent': kwikUserAgent,
                'Referer': refinedReferer,
            }
        });

        // Updated Regex to handle multiple variations of the packed function
        const packedMatch = html.match(/eval\(function\(p,a,c,k,e,d\).+?\}\((.+?)\)\s*\)/s);
        if (!packedMatch) return null;

        const argsString = packedMatch[1];
        const parts = parsePackedArgs(argsString);

        if (parts.length < 4) return null;

        const p = parts[0].replace(/^'|'$/g, ""); 
        const a = parseInt(parts[1], 10);
        const c = parseInt(parts[2], 10);
        const k = parts[3].replace(/^'|'$/g, "").split('|');

        const decoded = unpackKwik(p, a, c, k);

        // This regex is now broader to catch more URL patterns
        const srcMatch = decoded.match(/source\s*=\s*["'](https?:\/\/[^"']+)["']/i) || 
                         decoded.match(/file\s*:\s*["'](https?:\/\/[^"']+)["']/i) ||
                         decoded.match(/https?:\/\/[^\s"'`]+\.m3u8[^\s"'`]*/i);

        if (!srcMatch) return null;

        const videoURL = srcMatch[0].includes("source=") ? srcMatch[1] : srcMatch[0];
        
        return {
            url: videoURL.replace(/\\/g, ""),
            isM3U8: videoURL.includes(".m3u8"),
        };
    } catch (error) {
        console.error("Kwik Extractor Error:", error.message);
        return null;
    }
}

function unpackKwik(p, a, c, k) {
    while (c--) {
        if (k[c]) {
            p = p.replace(new RegExp('\\b' + c.toString(a) + '\\b', 'g'), k[c]);
        }
    }
    return p;
}

function parsePackedArgs(input) {
    const result = [];
    let current = "";
    let inQuote = false;
    let quoteChar = "";
    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if ((char === "'" || char === '"') && input[i - 1] !== "\\") {
            if (!inQuote) { inQuote = true; quoteChar = char; }
            else if (char === quoteChar) inQuote = false;
        }
        if (char === "," && !inQuote) {
            result.push(current.trim());
            current = "";
        } else { current += char; }
    }
    result.push(current.trim());
    return result;
}
