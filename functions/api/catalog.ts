function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? "private, max-age=3600" : "no-store",
    },
  });
}

function normalizeIdentity(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

async function fetchAppleJson(url: URL): Promise<any> {
  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "User-Agent": "Solara/1.0 (https://github.com/linlvyy/Solara)",
    },
  });
  if (!response.ok) {
    throw new Error(`Apple catalog returned ${response.status}`);
  }
  return response.json();
}

export async function onRequestGet({ request }: { request: Request }): Promise<Response> {
  const requestUrl = new URL(request.url);
  const artistQuery = (requestUrl.searchParams.get("artist") || "").trim();
  if (!artistQuery || artistQuery.length > 80) {
    return jsonResponse({ error: "歌手名称无效" }, 400);
  }

  try {
    const artistUrl = new URL("https://itunes.apple.com/search");
    artistUrl.search = new URLSearchParams({
      term: artistQuery,
      country: "tw",
      media: "music",
      entity: "musicArtist",
      limit: "10",
    }).toString();
    const artistData = await fetchAppleJson(artistUrl);
    const artists = Array.isArray(artistData?.results) ? artistData.results : [];
    if (artists.length === 0) {
      return jsonResponse({ artistName: "", tracks: [] });
    }

    const queryIdentity = normalizeIdentity(artistQuery);
    const artist = artists.find((item: any) => normalizeIdentity(item?.artistName) === queryIdentity)
      || artists[0];
    if (!artist?.artistId || !artist?.artistName) {
      return jsonResponse({ artistName: "", tracks: [] });
    }

    const lookupUrl = new URL("https://itunes.apple.com/lookup");
    lookupUrl.search = new URLSearchParams({
      id: String(artist.artistId),
      country: "tw",
      media: "music",
      entity: "song",
      limit: "200",
    }).toString();
    const lookupData = await fetchAppleJson(lookupUrl);
    const seen = new Set<string>();
    const tracks = (Array.isArray(lookupData?.results) ? lookupData.results : [])
      .filter((item: any) => item?.wrapperType === "track" && item?.trackName)
      .filter((item: any) => {
        const identity = `${normalizeIdentity(item.trackName)}::${normalizeIdentity(item.collectionName)}`;
        if (!identity || seen.has(identity)) return false;
        seen.add(identity);
        return true;
      })
      .map((item: any) => ({
        trackId: String(item.trackId || ""),
        trackName: String(item.trackName || ""),
        artistName: String(item.artistName || artist.artistName),
        collectionName: String(item.collectionName || ""),
      }));

    return jsonResponse({
      artistName: String(artist.artistName),
      tracks,
    });
  } catch (error) {
    console.error("Catalog proxy failed", error);
    return jsonResponse({ error: "深度目录暂时不可用" }, 502);
  }
}
