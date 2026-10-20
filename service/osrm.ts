export type Coordinates = { latitude: number; longitude: number };

export class OsrmError extends Error {}

// MySQL DECIMAL values may be returned as strings.
export function parseCoordinate(value: unknown, limit: number): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const coordinate = Number(value);
  return Number.isFinite(coordinate) && Math.abs(coordinate) <= limit
    ? coordinate
    : null;
}

let demoQueue: Promise<void> = Promise.resolve();
let nextDemoRequestAt = 0;

async function requestTable(url: URL): Promise<unknown> {
  const request = async () => {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new OsrmError(`OSRM HTTP ${response.status}`);
    return response.json();
  };

  if (url.hostname !== "router.project-osrm.org") return request();

  // Share the demo server's rate limit across simultaneous nearby requests.
  const result = demoQueue.then(async () => {
    const delay = nextDemoRequestAt - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    nextDemoRequestAt = Date.now() + 1_100;
    return request();
  });
  demoQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function getRoadDistances(
  origin: Coordinates,
  destinations: Coordinates[],
): Promise<(number | null)[]> {
  if (!destinations.length) return [];

  try {
    const baseUrl = (process.env.OSRM_BASE_URL || "https://router.project-osrm.org")
      .replace(/\/+$/, "");
    const coordinateKey = (point: Coordinates) => `${point.longitude},${point.latitude}`;
    // Several orders can belong to the same customer; request each location once.
    const uniqueKeys = [...new Set(destinations.map(coordinateKey))];
    const distancesByLocation = new Map<string, number | null>();

    // Keep each request within 100 coordinates, including the origin.
    for (let offset = 0; offset < uniqueKeys.length; offset += 99) {
      const batch = uniqueKeys.slice(offset, offset + 99);
      const coordinates = [coordinateKey(origin), ...batch].join(";");
      const url = new URL(`${baseUrl}/table/v1/driving/${coordinates}`);
      url.searchParams.set("sources", "0");
      url.searchParams.set("destinations", batch.map((_, index) => index + 1).join(";"));
      url.searchParams.set("annotations", "distance");

      // Do not enable fallback_speed: unreachable destinations must not use straight-line distances.
      const payload = await requestTable(url);
      if (!payload || typeof payload !== "object" || !("code" in payload) ||
          payload.code !== "Ok" || !("distances" in payload) ||
          !Array.isArray(payload.distances) || payload.distances.length !== 1) {
        throw new OsrmError("Invalid OSRM table response");
      }
      const distances: unknown = payload.distances[0];
      if (!Array.isArray(distances) || distances.length !== batch.length) {
        throw new OsrmError("Invalid OSRM distance matrix");
      }
      batch.forEach((key, index) => {
        const distance: unknown = distances[index];
        if (distance !== null &&
            (typeof distance !== "number" || !Number.isFinite(distance) || distance < 0)) {
          throw new OsrmError("Invalid OSRM distance");
        }
        distancesByLocation.set(key, distance === null ? null : (distance as number) / 1000);
      });
    }

    return destinations.map((point) => distancesByLocation.get(coordinateKey(point)) ?? null);
  } catch (error) {
    if (error instanceof OsrmError) throw error;
    throw new OsrmError("Unable to request road distances from OSRM", { cause: error });
  }
}
