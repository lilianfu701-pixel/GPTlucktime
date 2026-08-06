import { auth } from "@/modules/auth/auth";
import {
  profileMediaRuntime,
  profileMediaStorage,
  profileMediaStore,
} from "@/modules/profiles/media-runtime";
import { createPhotoCompleteHandler } from "@/modules/profiles/media-service";

const unavailable = async (request: Request) => {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return Response.json({ code: "UNAUTHORIZED", message: "UNAUTHORIZED" }, { status: 401 });
  } catch {
    return Response.json({ code: "INTERNAL_ERROR", message: "INTERNAL_ERROR" }, { status: 500 });
  }
  return Response.json({ code: "MEDIA_STORAGE_UNAVAILABLE", message: "MEDIA_STORAGE_UNAVAILABLE" }, { status: 503 });
};

export const POST = profileMediaStorage && profileMediaRuntime.tokenSecret
  ? createPhotoCompleteHandler({
      getSession: (headers) => auth.api.getSession({ headers }),
      storage: profileMediaStorage,
      store: profileMediaStore,
      tokenSecret: profileMediaRuntime.tokenSecret,
    })
  : unavailable;
