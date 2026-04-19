import axios from 'axios';

const kwikUserAgent = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36";

export async function extractKwik(kwikUrl) {
    if (!kwikUrl) throw new Error("Missing Kwik URL");

    try {
        const urlObj = new URL(kwikUrl);
        const refinedReferer = `${urlObj.protocol}//${urlObj.host}/`;

        const { data: html } = await axios.get(kwikUrl, {
            headers: {
                'User-Agent': kwikUserAgent,
                'Referer': refinedReferer,
            }
        });

        // Regex to find the packed function and its arguments
        const packedMatch = html.match(/eval\(function\(p,a,c,k,e,d\).+?\}\((.+?)\)\s*\)/s);
        if (!packedMatch) {
            throw new Error("Could not find packed eval JS in Kwik page");
        }

        const argsString = packedMatch[1];
        const parts = parsePackedArgs(argsString);

        if (parts.length < 4) throw new Error("Invalid packed data format");

        const p = parts[0].replace(/^'|'$/g, ""); 
        const a = parseInt(parts[1], 10);
        const c = parseInt(parts[2], 10);
        const k = parts[3].replace(/^'|'$/g, "").split('|');

        const decoded = unpackKwik(p, a, c, k);

        // Find the source URL inside the decoded JS
        const srcMatch = decoded.match(/source\s*=\s*["'](https?:\/\/[^"']+)["']/i) || 
                         decoded.match(/file\s*:\s*["'](https?:\/\/[^"']+)["']/i);

        if (!srcMatch) throw new Error("Could not find video URL in unpacked code");

        const videoURL = srcMatch[1].replace(/\\/g, "");
        
        return {
            url: videoURL,
            isM3U8: videoURL.includes(".m3u8"),
        };
    } catch (error) {
        throw error;
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
            if (!inQuote) {
                inQuote = true;
                quoteChar = char;
            } else if (char === quoteChar) {
                inQuote = false;
            }
        }
        if (char === "," && !inQuote) {
            result.push(current.trim());
            current = "";
        } else {
            current += char;
        }
    }
    result.push(current.trim());
    return result;
}
