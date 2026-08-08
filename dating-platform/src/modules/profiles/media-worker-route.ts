import { timingSafeEqual } from "node:crypto";

export type MediaWorkerCounts = {
  reviewed: number;
  deleted: number;
  uploadArtifactsDeleted: number;
};

const exactSecretMatch = (authorization: string | null, secret: string) => {
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const received = Buffer.from(authorization ?? "", "utf8");
  return received.byteLength === expected.byteLength && timingSafeEqual(received, expected);
};

export function createMediaWorkerRoute(input: {
  secret: string;
  run: () => Promise<MediaWorkerCounts>;
}) {
  return async function POST(request: Request) {
    if (!exactSecretMatch(request.headers.get("authorization"), input.secret)) {
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }
    try {
      return Response.json(await input.run());
    } catch {
      return Response.json({ error: "MEDIA_WORKER_FAILED" }, { status: 500 });
    }
  };
}
