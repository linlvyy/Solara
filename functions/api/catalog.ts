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

async function fetchMusicBrainzJson(url: URL): Promise<any> {
  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "User-Agent": "Solara/1.0 (https://github.com/linlvyy/Solara)",
    },
  });
  if (!response.ok) {
    throw new Error(`MusicBrainz catalog returned ${response.status}`);
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
    const recordingsUrl = new URL("https://musicbrainz.org/ws/2/recording/");
    recordingsUrl.search = new URLSearchParams({
      query: `artist:"${artistQuery.replace(/["\\]/g, " ")}"`,
      fmt: "json",
      limit: "100",
      offset: "0",
    }).toString();
    const catalogData = await fetchMusicBrainzJson(recordingsUrl);
    const recordings = Array.isArray(catalogData?.recordings) ? catalogData.recordings : [];
    if (recordings.length === 0) {
      return jsonResponse({ artistName: "", tracks: [] });
    }

    const artistAliases = Array.from(new Set(
      recordings.flatMap((item: any) =>
        (Array.isArray(item?.["artist-credit"]) ? item["artist-credit"] : [])
          .map((credit: any) => String(credit?.name || credit?.artist?.name || "").trim())
          .filter(Boolean)
      )
    ));
    const seen = new Set<string>();
    const tracks = recordings
      .filter((item: any) => item?.id && item?.title)
      .filter((item: any) => {
        const identity = normalizeIdentity(item.title);
        if (!identity || seen.has(identity)) return false;
        seen.add(identity);
        return true;
      })
      .map((item: any) => ({
        trackId: String(item.id || ""),
        trackName: String(item.title || ""),
        artistName: String(item?.["artist-credit"]?.[0]?.name || artistQuery),
        collectionName: String(item?.releases?.[0]?.title || ""),
      }));

    return jsonResponse({
      artistName: String(artistAliases[0] || artistQuery),
      artistAliases,
      total: Number(catalogData?.count || tracks.length),
      tracks,
    });
  } catch (error) {
    console.error("Catalog proxy failed", error);
    return jsonResponse({ error: "深度目录暂时不可用" }, 502);
  }
}
