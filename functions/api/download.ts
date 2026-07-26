const DEFAULT_API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const MAX_EMBED_SIZE = 64 * 1024 * 1024;

type Env = {
  API_BASE_URL?: string;
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function sanitizePart(value: string, fallback: string): string {
  const normalized = String(value || "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, " - ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return (normalized || fallback).slice(0, 120);
}

function getArtist(value: string): string {
  return sanitizePart(value, "未知艺术家");
}

function getExtension(contentType: string, audioUrl: string, quality: string): string {
  const normalizedType = contentType.toLowerCase();
  if (normalizedType.includes("flac")) return "flac";
  if (normalizedType.includes("mpeg")) return "mp3";
  if (normalizedType.includes("mp4") || normalizedType.includes("m4a")) return "m4a";
  if (normalizedType.includes("ogg")) return "ogg";
  if (normalizedType.includes("wav")) return "wav";
  if (normalizedType.includes("ape")) return "ape";

  try {
    const match = new URL(audioUrl).pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match && ["mp3", "flac", "m4a", "aac", "ogg", "wav", "ape"].includes(match[1].toLowerCase())) {
      return match[1].toLowerCase();
    }
  } catch {
    // Use the requested quality fallback below.
  }
  return quality === "999" ? "flac" : "mp3";
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function uint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function utf16Text(value: string): Uint8Array {
  const bytes = new Uint8Array(2 + value.length * 2 + 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    bytes[2 + index * 2] = code & 0xff;
    bytes[3 + index * 2] = code >>> 8;
  }
  return bytes;
}

function id3Frame(id: string, payload: Uint8Array): Uint8Array {
  return concatBytes([
    new TextEncoder().encode(id),
    uint32(payload.byteLength),
    new Uint8Array([0, 0]),
    payload,
  ]);
}

function id3TextFrame(id: string, value: string): Uint8Array {
  return id3Frame(id, concatBytes([new Uint8Array([1]), utf16Text(value)]));
}

function synchsafe(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f,
  ]);
}

function stripId3(audio: Uint8Array): Uint8Array {
  if (audio.byteLength < 10 || audio[0] !== 0x49 || audio[1] !== 0x44 || audio[2] !== 0x33) {
    return audio;
  }
  const tagSize =
    (audio[6] << 21) |
    (audio[7] << 14) |
    (audio[8] << 7) |
    audio[9];
  const footerSize = (audio[5] & 0x10) !== 0 ? 10 : 0;
  const offset = Math.min(audio.byteLength, 10 + tagSize + footerSize);
  return audio.subarray(offset);
}

function embedMp3Metadata(
  audio: Uint8Array,
  cover: Uint8Array,
  coverType: string,
  title: string,
  artist: string,
  album: string,
): Uint8Array {
  const mime = /^image\/(jpeg|png|webp)$/i.test(coverType) ? coverType.split(";")[0] : "image/jpeg";
  const picturePayload = concatBytes([
    new Uint8Array([0]),
    new TextEncoder().encode(mime),
    new Uint8Array([0, 3, 0]),
    cover,
  ]);
  const frames = [
    id3TextFrame("TIT2", title),
    id3TextFrame("TPE1", artist),
    album ? id3TextFrame("TALB", album) : new Uint8Array(),
    id3Frame("APIC", picturePayload),
  ];
  const body = concatBytes(frames);
  const header = concatBytes([
    new TextEncoder().encode("ID3"),
    new Uint8Array([3, 0, 0]),
    synchsafe(body.byteLength),
  ]);
  return concatBytes([header, body, stripId3(audio)]);
}

function flacPictureBlock(cover: Uint8Array, coverType: string): Uint8Array {
  const mime = /^image\/(jpeg|png|webp)$/i.test(coverType) ? coverType.split(";")[0] : "image/jpeg";
  const mimeBytes = new TextEncoder().encode(mime);
  return concatBytes([
    uint32(3),
    uint32(mimeBytes.byteLength),
    mimeBytes,
    uint32(0),
    uint32(0),
    uint32(0),
    uint32(0),
    uint32(0),
    uint32(cover.byteLength),
    cover,
  ]);
}

function embedFlacCover(audio: Uint8Array, cover: Uint8Array, coverType: string): Uint8Array {
  if (
    audio.byteLength < 8 ||
    audio[0] !== 0x66 ||
    audio[1] !== 0x4c ||
    audio[2] !== 0x61 ||
    audio[3] !== 0x43
  ) {
    return audio;
  }

  let offset = 4;
  let lastHeaderOffset = -1;
  while (offset + 4 <= audio.byteLength) {
    const headerOffset = offset;
    const isLast = (audio[offset] & 0x80) !== 0;
    const length = (audio[offset + 1] << 16) | (audio[offset + 2] << 8) | audio[offset + 3];
    offset += 4 + length;
    if (offset > audio.byteLength) return audio;
    if (isLast) {
      lastHeaderOffset = headerOffset;
      break;
    }
  }
  if (lastHeaderOffset < 0) return audio;

  const picture = flacPictureBlock(cover, coverType);
  if (picture.byteLength > 0xffffff) return audio;
  const blockHeader = new Uint8Array([
    0x80 | 6,
    (picture.byteLength >>> 16) & 0xff,
    (picture.byteLength >>> 8) & 0xff,
    picture.byteLength & 0xff,
  ]);
  const result = new Uint8Array(audio.byteLength + blockHeader.byteLength + picture.byteLength);
  result.set(audio.subarray(0, offset), 0);
  result[lastHeaderOffset] &= 0x7f;
  result.set(blockHeader, offset);
  result.set(picture, offset + blockHeader.byteLength);
  result.set(audio.subarray(offset), offset + blockHeader.byteLength + picture.byteLength);
  return result;
}

async function fetchApiJson(apiBaseUrl: string, params: Record<string, string>): Promise<{ url?: string }> {
  const target = new URL(apiBaseUrl);
  Object.entries(params).forEach(([key, value]) => target.searchParams.set(key, value));
  const response = await fetch(target.toString(), {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
  });
  if (!response.ok) throw new Error(`Music API returned ${response.status}`);
  return response.json() as Promise<{ url?: string }>;
}

export async function onRequest({
  request,
  env,
}: {
  request: Request;
  env: Env;
}): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").slice(0, 500);
  const picId = (url.searchParams.get("pic_id") || id).slice(0, 500);
  const source = (url.searchParams.get("source") || "netease").slice(0, 40);
  const quality = (url.searchParams.get("br") || "320").slice(0, 10);
  const title = sanitizePart(url.searchParams.get("title") || "", "未知歌曲");
  const artist = getArtist(url.searchParams.get("artist") || "");
  const album = sanitizePart(url.searchParams.get("album") || "", "");
  if (!id) return json({ error: "缺少歌曲编号" }, 400);

  const apiBaseUrl = env.API_BASE_URL || DEFAULT_API_BASE_URL;
  try {
    const [audioData, pictureData] = await Promise.all([
      fetchApiJson(apiBaseUrl, { types: "url", id, source, br: quality }),
      picId
        ? fetchApiJson(apiBaseUrl, { types: "pic", id: picId, source, size: "500" }).catch(() => ({}))
        : Promise.resolve({}),
    ]);
    if (!audioData.url) return json({ error: "无法获取下载地址" }, 502);

    const audioRequestUrl = new URL(audioData.url);
    const audioHeaders: Record<string, string> = {
      "Accept": "audio/*,*/*;q=0.8",
      "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0",
    };
    if (/(^|\.)kuwo\.(cn|com)$/i.test(audioRequestUrl.hostname)) {
      audioRequestUrl.protocol = "http:";
      audioHeaders.Referer = "https://www.kuwo.cn/";
    }

    const [audioResponse, coverResponse] = await Promise.all([
      fetch(audioRequestUrl.toString(), { headers: audioHeaders }),
      pictureData.url
        ? fetch(pictureData.url, { headers: { "Accept": "image/*", "User-Agent": "Mozilla/5.0" } }).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (!audioResponse.ok) return json({ error: `音频下载失败（${audioResponse.status}）` }, 502);

    const contentType = audioResponse.headers.get("Content-Type") || "application/octet-stream";
    const extension = getExtension(contentType, audioData.url, quality);
    const filename = `${title} - ${artist}.${extension}`;
    const responseHeaders = new Headers({
      "Content-Type": contentType,
      "Content-Disposition": contentDisposition(filename),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });

    const declaredLength = Number(audioResponse.headers.get("Content-Length") || 0);
    const canEmbed = Boolean(
      coverResponse?.ok &&
      (!declaredLength || declaredLength <= MAX_EMBED_SIZE) &&
      (extension === "mp3" || extension === "flac"),
    );
    if (!canEmbed) {
      return new Response(audioResponse.body, { status: 200, headers: responseHeaders });
    }

    const [audioBuffer, coverBuffer] = await Promise.all([
      audioResponse.arrayBuffer(),
      coverResponse!.arrayBuffer(),
    ]);
    if (audioBuffer.byteLength > MAX_EMBED_SIZE) {
      return new Response(audioBuffer, { status: 200, headers: responseHeaders });
    }

    const audioBytes = new Uint8Array(audioBuffer);
    const coverBytes = new Uint8Array(coverBuffer);
    const coverType = coverResponse!.headers.get("Content-Type") || "image/jpeg";
    const taggedAudio = extension === "mp3"
      ? embedMp3Metadata(audioBytes, coverBytes, coverType, title, artist, album)
      : embedFlacCover(audioBytes, coverBytes, coverType);
    responseHeaders.set("Content-Length", String(taggedAudio.byteLength));
    return new Response(taggedAudio, { status: 200, headers: responseHeaders });
  } catch (error) {
    console.error("Download preparation failed", error);
    return json({ error: "下载准备失败，请稍后重试" }, 502);
  }
}
