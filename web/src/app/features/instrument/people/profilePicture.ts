import type { GSVClient } from "@humansandmachines/gsv/client";
import type { ProfileAvatar, ProfileAvatarMimeType, ProfileState } from "@humansandmachines/gsv/protocol";
import { PROFILE_AVATAR_MAX_BYTES, bodyFromBytes } from "@humansandmachines/gsv/protocol";
import { frameBodyToBlob } from "../../../services/gateway/frameBody";
import { t } from "../../../i18n/locale";

/** Profile pictures are square, at most this many pixels a side. */
export const PROFILE_PICTURE_SIZE = 512;
export const PROFILE_PICTURE_TYPES = "image/png,image/jpeg,image/webp";

/** A picture ready for the profile: square, within the size limit, in a format every Ship shows. */
export type ProfilePicture = { bytes: Uint8Array; mimeType: ProfileAvatarMimeType };
/** The centred square of an image, and the side it is drawn at. */
export type PictureCrop = { x: number; y: number; side: number; size: number };
type Encode = (mimeType: ProfileAvatarMimeType, quality: number | undefined) => Promise<Blob | null>;
type PictureClient = Pick<GSVClient, "request">;

/** WebP and PNG keep transparency; JPEG always fits. */
const FORMATS: Array<[ProfileAvatarMimeType, number | undefined]> = [["image/webp", 0.9], ["image/png", undefined], ["image/jpeg", 0.9], ["image/jpeg", 0.7]];

/** A picture smaller than the profile's size keeps its own; none is enlarged. */
export function pictureCrop(width: number, height: number): PictureCrop {
  const side = Math.min(width, height);
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side, size: Math.min(side, PROFILE_PICTURE_SIZE) };
}

/** The first format the browser writes that fits the profile's limit. */
export async function encodePicture(encode: Encode): Promise<ProfilePicture> {
  for (const [mimeType, quality] of FORMATS) {
    const blob = await encode(mimeType, quality);
    // A browser that can't write a format writes PNG instead.
    if (blob?.type === mimeType && blob.size <= PROFILE_AVATAR_MAX_BYTES) return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType };
  }
  throw new Error(t("people.profile.pictureTooLarge"));
}

/** Crops the chosen file to its centred square and resizes it for the profile. */
export async function profilePicture(file: Blob): Promise<ProfilePicture> {
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file);
  } catch {
    throw new Error(t("people.profile.pictureUnreadable"));
  }
  try {
    const crop = pictureCrop(image.width, image.height);
    const canvas = document.createElement("canvas");
    canvas.width = crop.size;
    canvas.height = crop.size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("people.profile.pictureUnreadable"));
    context.imageSmoothingQuality = "high";
    context.drawImage(image, crop.x, crop.y, crop.side, crop.side, 0, 0, crop.size, crop.size);
    return await encodePicture((mimeType, quality) => new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality)));
  } finally {
    image.close();
  }
}

/** Replaces the draft's picture, or removes it when `picture` is null. */
export async function saveProfilePicture(client: PictureClient, expectedRevision: number, picture: ProfilePicture | null): Promise<ProfileState> {
  if (!picture) return (await client.request("profile.avatar.remove", { expectedRevision })).data.profile;
  const response = await client.request("profile.avatar.set", { expectedRevision, mimeType: picture.mimeType }, { body: bodyFromBytes(picture.bytes) });
  await response.body?.stream.cancel("profile.avatar.set does not return a body").catch(() => {});
  return response.data.profile;
}

/** The draft's or the published picture, from the Ship. */
export async function readProfilePicture(client: PictureClient, avatar: ProfileAvatar): Promise<Blob> {
  const { data, body } = await client.request("profile.avatar.read", { cid: avatar.cid });
  if (!body) throw new Error(t("people.profile.pictureUnreadable"));
  return await frameBodyToBlob(body, { mimeType: data.mimeType, expectedLength: data.size, label: "Profile picture" });
}
