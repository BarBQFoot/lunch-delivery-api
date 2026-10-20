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

export type RoadMatrix = (number | null)[][];
export type RouteLine = { type: "LineString"; coordinates: [number, number][] };

const matrixCache = new Map<string, { expires: number; matrix: RoadMatrix }>();

/** All pairs in km; preserve input indexes even when customers share coordinates. */
export async function getDistanceMatrix(points: Coordinates[]): Promise<RoadMatrix> {
  if (!points.length || points.length > 100) throw new OsrmError("Expected 1–100 locations");
  const baseUrl = (process.env.OSRM_BASE_URL || "https://router.project-osrm.org").replace(/\/+$/, "");
  const keys = points.map(point => `${point.longitude},${point.latitude}`);
  const unique = [...new Set(keys)];
  const cacheKey = `${baseUrl}|${keys.join(";")}`;
  const cached = matrixCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.matrix;
  try {
    const url = new URL(`${baseUrl}/table/v1/driving/${unique.join(";")}`);
    url.searchParams.set("annotations", "distance");
    const payload = await requestTable(url) as { code?: string; distances?: unknown };
    if (payload?.code !== "Ok" || !Array.isArray(payload.distances) || payload.distances.length !== unique.length) {
      throw new OsrmError("Invalid OSRM matrix");
    }
    const matrix: RoadMatrix = payload.distances.map((row: unknown) => {
      if (!Array.isArray(row) || row.length !== unique.length ||
          row.some(cell => cell !== null && (typeof cell !== "number" || !Number.isFinite(cell) || cell < 0))) {
        throw new OsrmError("Invalid OSRM matrix row");
      }
      return row.map((cell: number | null) => cell === null ? null : cell / 1000);
    });
    const indexes = keys.map(key => unique.indexOf(key));
    const expanded = indexes.map(from => indexes.map(to => matrix[from]![to]!));
    if (matrixCache.size >= 30) matrixCache.delete(matrixCache.keys().next().value!);
    matrixCache.set(cacheKey, { matrix: expanded, expires: Date.now() + 5 * 60_000 });
    return expanded;
  } catch (error) {
    if (error instanceof OsrmError) throw error;
    throw new OsrmError("Unable to get OSRM matrix", { cause: error });
  }
}

export async function getRoute(points: Coordinates[]): Promise<RouteLine> {
  if (points.length < 2 || points.length > 5) throw new OsrmError("Expected 2–5 route locations");
  try {
    const baseUrl = (process.env.OSRM_BASE_URL || "https://router.project-osrm.org").replace(/\/+$/, "");
    const coordinates = points.map(point => `${point.longitude},${point.latitude}`).join(";");
    const url = new URL(`${baseUrl}/route/v1/driving/${coordinates}`);
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("overview", "full");
    url.searchParams.set("continue_straight", "false");
    const data = await requestTable(url) as { code?: string; routes?: { geometry?: RouteLine }[] };
    const geometry = data?.routes?.[0]?.geometry;
    if (data?.code !== "Ok" || geometry?.type !== "LineString" || !Array.isArray(geometry.coordinates) ||
        geometry.coordinates.length < 2 || geometry.coordinates.some(point =>
          !Array.isArray(point) || point.length !== 2 || parseCoordinate(point[0], 180) === null ||
          parseCoordinate(point[1], 90) === null)) throw new OsrmError("Invalid OSRM route geometry");
    return geometry;
  } catch (error) {
    if (error instanceof OsrmError) throw error;
    throw new OsrmError("Unable to get OSRM route", { cause: error });
  }
}
