type Env = {
  JAMENDO_CLIENT_ID?: string;
  API_BASE_URL?: string;
};

type OpenTrack = {
  id: string;
  name: string;
  artist: string;
  album: string;
  source: "audius" | "jamendo" | "archive" | "gd";
  pic_id?: string;
  url_id?: string;
  lyric_id?: string;
  playable: boolean;
  download_allowed: boolean;
  download_url?: string;
  license_url?: string;
  external_url?: string;
};

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, s-maxage=180, max-age=60",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "Accept,Content-Type",
};

const SAFE_MEDIA_HOSTS = [
  "api.audius.co",
  "archive.org",
  "usercontent.jamendo.com",
  "prod-1.storage.jamendo.com",
  "prod-2.storage.jamendo.com",
  "prod-3.storage.jamendo.com",
  "prod-4.storage.jamendo.com",
];

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function safePositiveInt(raw: string | null, fallback: number, max: number): number {
  const value = Number.parseInt(raw || "", 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 1), max) : fallback;
}

function isSafeMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && SAFE_MEDIA_HOSTS.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

async function searchAudius(query: string, count: number, page: number): Promise<OpenTrack[]> {
  const url = new URL("https://api.audius.co/v1/tracks/search");
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(count));
  url.searchParams.set("offset", String((page - 1) * count));
  url.searchParams.set("sort_method", "relevant");

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Audius ${response.status}`);
  const payload = await response.json() as any;
  const tracks = Array.isArray(payload?.data) ? payload.data : [];

  return tracks.filter((track: any) => track?.id && track?.title).map((track: any) => {
    const artwork = track.artwork || {};
    const streamUrl = `https://api.audius.co/v1/tracks/${encodeURIComponent(track.id)}/stream`;
    return {
      id: String(track.id),
      name: String(track.title),
      artist: String(track.user?.name || track.user?.handle || "Audius Artist"),
      album: String(track.album_name || track.genre || ""),
      source: "audius",
      pic_id: String(artwork["_1000x1000"] || artwork["_480x480"] || artwork["_150x150"] || ""),
      url_id: streamUrl,
      playable: true,
      download_allowed: false,
      license_url: "https://audius.co/legal/terms-of-use",
      external_url: track.permalink ? `https://audius.co${track.permalink}` : "https://audius.co",
    };
  });
}

async function searchJamendo(query: string, count: number, page: number, env: Env): Promise<OpenTrack[]> {
  const clientId = env.JAMENDO_CLIENT_ID?.trim();
  if (!clientId) return [];

  const url = new URL("https://api.jamendo.com/v3.0/tracks/");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(count));
  url.searchParams.set("offset", String((page - 1) * count));
  url.searchParams.set("search", query);
  url.searchParams.set("type", "single albumtrack");
  url.searchParams.set("audioformat", "mp32");
  url.searchParams.set("audiodlformat", "mp32");
  url.searchParams.set("imagesize", "500");
  url.searchParams.set("include", "licenses");

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Jamendo ${response.status}`);
  const payload = await response.json() as any;
  const tracks = Array.isArray(payload?.results) ? payload.results : [];

  return tracks.filter((track: any) => track?.id && track?.audio).map((track: any) => ({
    id: String(track.id),
    name: String(track.name || "Untitled"),
    artist: String(track.artist_name || "Jamendo Artist"),
    album: String(track.album_name || ""),
    source: "jamendo",
    pic_id: String(track.image || track.album_image || ""),
    url_id: String(track.audio),
    playable: true,
    download_allowed: Boolean(track.audiodownload_allowed && track.audiodownload),
    download_url: track.audiodownload_allowed ? String(track.audiodownload || "") : "",
    license_url: String(track.license_ccurl || ""),
    external_url: String(track.shareurl || track.shorturl || "https://www.jamendo.com"),
  }));
}

function pickArchiveAudio(files: any[]): any | null {
  const candidates = files.filter((file: any) => {
    const name = String(file?.name || "");
    const format = String(file?.format || "").toLowerCase();
    return name && !name.endsWith(".zip") && (
      format.includes("vbr mp3") ||
      format.includes("ogg vorbis") ||
      format === "flac" ||
      /\.(mp3|ogg|flac)$/i.test(name)
    );
  });
  return candidates.find((file: any) => String(file.format || "").toLowerCase().includes("vbr mp3"))
    || candidates[0]
    || null;
}

async function searchArchive(query: string, count: number, page: number): Promise<OpenTrack[]> {
  const url = new URL("https://archive.org/advancedsearch.php");
  const escaped = query.replace(/["\\]/g, " ").trim();
  url.searchParams.set("q", `mediatype:audio AND collection:netlabels AND (title:"${escaped}" OR creator:"${escaped}")`);
  url.searchParams.set("fl[]", "identifier,title,creator");
  url.searchParams.set("rows", String(Math.min(count, 12)));
  url.searchParams.set("page", String(page));
  url.searchParams.set("output", "json");

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Internet Archive ${response.status}`);
  const payload = await response.json() as any;
  const docs = Array.isArray(payload?.response?.docs) ? payload.response.docs : [];

  const resolved = await Promise.all(docs.map(async (doc: any): Promise<OpenTrack | null> => {
    const identifier = String(doc?.identifier || "");
    if (!identifier) return null;
    const metadataResponse = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
    if (!metadataResponse.ok) return null;
    const metadata = await metadataResponse.json() as any;
    const license = String(metadata?.metadata?.licenseurl || metadata?.metadata?.rights || "");
    if (!/(creativecommons\.org|publicdomain|public domain)/i.test(license)) return null;
    const audioFile = pickArchiveAudio(Array.isArray(metadata?.files) ? metadata.files : []);
    if (!audioFile) return null;
    const mediaUrl = `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(String(audioFile.name))}`;
    const title = String(audioFile.title || doc.title || metadata?.metadata?.title || identifier);
    const creatorValue = doc.creator || metadata?.metadata?.creator || "Internet Archive";
    const creator = Array.isArray(creatorValue) ? creatorValue.join(", ") : String(creatorValue);
    return {
      id: `${identifier}:${String(audioFile.name)}`,
      name: title,
      artist: creator,
      album: String(metadata?.metadata?.album || metadata?.metadata?.collection?.[0] || "Netlabels"),
      source: "archive",
      pic_id: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
      url_id: mediaUrl,
      playable: true,
      download_allowed: true,
      download_url: mediaUrl,
      license_url: license,
      external_url: `https://archive.org/details/${encodeURIComponent(identifier)}`,
    };
  }));

  return resolved.filter((track): track is OpenTrack => Boolean(track));
}

async function searchGdExperimental(query: string, count: number, page: number, env: Env): Promise<OpenTrack[]> {
  const upstream = env.API_BASE_URL || "https://music-api.gdstudio.xyz/api.php";
  const url = new URL(upstream);
  url.searchParams.set("types", "search");
  url.searchParams.set("source", "netease");
  url.searchParams.set("name", query);
  url.searchParams.set("count", String(count));
  url.searchParams.set("pages", String(page));
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`GD ${response.status}`);
  const payload = await response.json() as any;
  const tracks = Array.isArray(payload) ? payload : [];
  return tracks.map((track: any) => ({
    id: String(track.id || ""),
    name: String(track.name || "未知歌曲"),
    artist: Array.isArray(track.artist) ? track.artist.join(", ") : String(track.artist || "未知艺术家"),
    album: String(track.album || ""),
    source: "gd",
    playable: false,
    download_allowed: false,
    external_url: "https://music.gdstudio.xyz/",
  }));
}

async function handleSearch(url: URL, env: Env): Promise<Response> {
  const query = (url.searchParams.get("name") || "").trim().slice(0, 100);
  const source = url.searchParams.get("source") || "audius";
  const count = safePositiveInt(url.searchParams.get("count"), 20, 50);
  const page = safePositiveInt(url.searchParams.get("pages"), 1, 100);
  if (!query) return json({ error: "Missing query" }, 400);

  try {
    let tracks: OpenTrack[];
    if (source === "jamendo") tracks = await searchJamendo(query, count, page, env);
    else if (source === "archive") tracks = await searchArchive(query, count, page);
    else if (source === "gd") tracks = await searchGdExperimental(query, count, page, env);
    else tracks = await searchAudius(query, count, page);
    return json(tracks, 200, { "X-Source": source });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Source unavailable" }, 502, {
      "Cache-Control": "no-store",
    });
  }
}

function handleMediaMetadata(url: URL): Response {
  const source = url.searchParams.get("source") || "";
  if (source === "gd") return json({ error: "Experimental GD results are metadata-only" }, 403);

  const type = url.searchParams.get("types");
  const candidate = url.searchParams.get("id");
  if (!candidate) return json({ error: "Invalid media URL" }, 400);
  if (type === "pic") {
    try {
      if (new URL(candidate).protocol !== "https:") return json({ error: "Invalid artwork URL" }, 400);
    } catch {
      return json({ error: "Invalid artwork URL" }, 400);
    }
  } else if (!isSafeMediaUrl(candidate)) {
    return json({ error: "Invalid media URL" }, 400);
  }
  return json({ url: candidate });
}

export async function onRequest({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);

  const url = new URL(request.url);
  const type = url.searchParams.get("types");
  if (type === "search") return handleSearch(url, env);
  if (type === "url" || type === "pic") return handleMediaMetadata(url);
  if (type === "lyric") return json({ lyric: "" });
  return json({ error: "Unsupported request" }, 400);
}
