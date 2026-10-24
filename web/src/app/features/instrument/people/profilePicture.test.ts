import { describe, expect, it } from "vitest";
import type { GSVClient, GsvBody } from "@humansandmachines/gsv/client";
import type {
  ProfileAvatarMimeType,
  ProfileAvatarReadArgs,
  ProfileAvatarReadResult,
  ProfileAvatarRemoveArgs,
  ProfileAvatarSetArgs,
  ProfileGetResult,
  ProfileState,
} from "@humansandmachines/gsv/protocol";
import { PROFILE_AVATAR_MAX_BYTES, bodyFromBytes, bodyToBytes } from "@humansandmachines/gsv/protocol";
import { encodePicture, pictureCrop, readProfilePicture, saveProfilePicture } from "./profilePicture";

type PictureClient = Pick<GSVClient, "request">;
type PictureArgs = ProfileAvatarSetArgs | ProfileAvatarRemoveArgs | ProfileAvatarReadArgs;
type Answer = { data: ProfileGetResult | ProfileAvatarReadResult; body?: GsvBody };
type Call = { call: string; args: PictureArgs; body?: Uint8Array };

const PROFILE: ProfileState = { revision: 4, url: "https://person.ship.test/profile", draft: { displayName: "Person", about: "", contactPolicy: "requests" } };
const BYTES = new Uint8Array([137, 80, 78, 71]);

/** A client that records each request, with the bytes of its body, and answers it with `answer`. */
function client(answer: Answer) {
  const calls: Call[] = [];
  const request = async (call: string, args: PictureArgs, options?: { body?: GsvBody }) => {
    const entry: Call = { call, args };
    if (options?.body) entry.body = await bodyToBytes(options.body, Infinity);
    calls.push(entry);
    return answer;
  };
  // SAFETY: the stub answers only the profile picture calls these tests make, with the shapes the helpers read.
  return { calls, client: { request } as PictureClient };
}

describe("pictureCrop", () => {
  it("takes the centred square and shrinks it to the profile's size", () => {
    expect(pictureCrop(1600, 900)).toEqual({ x: 350, y: 0, side: 900, size: 512 });
    expect(pictureCrop(600, 1001)).toEqual({ x: 0, y: 200, side: 600, size: 512 });
  });

  it("never enlarges a small picture", () => {
    expect(pictureCrop(300, 200)).toEqual({ x: 50, y: 0, side: 200, size: 200 });
  });
});

describe("encodePicture", () => {
  it("keeps the first format the browser writes within the limit", async () => {
    await expect(encodePicture(async (mimeType) => new Blob([BYTES], { type: mimeType }))).resolves.toEqual({ bytes: BYTES, mimeType: "image/webp" });
  });

  it("moves on when the browser writes another format or the picture is too large", async () => {
    const tried: Array<[ProfileAvatarMimeType, number | undefined]> = [];
    const picture = await encodePicture(async (mimeType, quality) => {
      tried.push([mimeType, quality]);
      // This browser can't write WebP, so it writes PNG, and its PNG is over the limit.
      if (mimeType === "image/webp") return new Blob([BYTES], { type: "image/png" });
      if (mimeType === "image/png") return new Blob([new Uint8Array(PROFILE_AVATAR_MAX_BYTES + 1)], { type: mimeType });
      return new Blob([BYTES], { type: mimeType });
    });
    expect(picture.mimeType).toBe("image/jpeg");
    expect(tried).toEqual([["image/webp", 0.9], ["image/png", undefined], ["image/jpeg", 0.9]]);
  });

  it("refuses a picture no format fits", async () => {
    await expect(encodePicture(async (mimeType) => mimeType === "image/png" ? null : new Blob([new Uint8Array(PROFILE_AVATAR_MAX_BYTES + 1)], { type: mimeType })))
      .rejects.toThrow("can't be made small enough");
  });
});

describe("saveProfilePicture", () => {
  it("sends the picture as the request body against the draft revision", async () => {
    const { calls, client: ship } = client({ data: { profile: PROFILE } });
    await expect(saveProfilePicture(ship, 3, { bytes: BYTES, mimeType: "image/png" })).resolves.toBe(PROFILE);
    expect(calls).toEqual([{ call: "profile.avatar.set", args: { expectedRevision: 3, mimeType: "image/png" }, body: BYTES }]);
  });

  it("removes the picture when none is chosen", async () => {
    const { calls, client: ship } = client({ data: { profile: PROFILE } });
    await expect(saveProfilePicture(ship, 3, null)).resolves.toBe(PROFILE);
    expect(calls).toEqual([{ call: "profile.avatar.remove", args: { expectedRevision: 3 } }]);
  });
});

describe("readProfilePicture", () => {
  const avatar = { cid: "bafkreiavatar", mimeType: "image/png" as const, size: BYTES.length };

  it("reads the picture's bytes as an image of its type", async () => {
    const { calls, client: ship } = client({ data: avatar, body: bodyFromBytes(BYTES) });
    const blob = await readProfilePicture(ship, avatar);
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(BYTES);
    expect(calls).toEqual([{ call: "profile.avatar.read", args: { cid: "bafkreiavatar" } }]);
  });

  it("refuses an answer without the picture's bytes, or with too few of them", async () => {
    await expect(readProfilePicture(client({ data: avatar }).client, avatar)).rejects.toThrow("couldn't open this picture");
    await expect(readProfilePicture(client({ data: avatar, body: bodyFromBytes(BYTES.slice(1)) }).client, avatar)).rejects.toThrow("length mismatch");
  });
});
