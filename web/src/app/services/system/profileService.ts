import type { GSVClient } from "@humansandmachines/gsv/client";
import type { ProfileFields, ProfileState } from "@humansandmachines/gsv/protocol";
import { bodyFromBytes, bodyToBytes, profileAvatarSchema, type ProfileAvatar } from "@humansandmachines/gsv/protocol";

export async function uploadProfileAvatar(client: GSVClient, blob: Blob, signal: AbortSignal): Promise<ProfileAvatar> {
  if (blob.size > 262_144) throw new Error("Image must fit in 256 KiB. Try a smaller crop.");
  const response = await client.request("profile.avatar.upload", {}, { body: bodyFromBytes(new Uint8Array(await blob.arrayBuffer())), signal });
  return profileAvatarSchema.parse(response.data.avatar);
}

export async function readProfileAvatar(client: GSVClient, sha256: string, signal: AbortSignal, profileUrl?: string): Promise<Blob> {
  const args = profileUrl === undefined ? { sha256 } : { sha256, profileUrl };
  const response = await client.request("profile.avatar.read", args, { signal });
  if (!response.body) throw new Error("Profile image has no content");
  const bytes = await bodyToBytes(response.body, 262_144, signal);
  return new Blob([new Uint8Array(bytes)], { type: "image/png" });
}

export async function loadProfile(client: GSVClient): Promise<ProfileState> {
  return (await client.call("profile.get", {})).profile;
}

export async function saveProfile(client: GSVClient, expectedRevision: number, draft: ProfileFields): Promise<ProfileState> {
  return (await client.call("profile.update", { expectedRevision, draft })).profile;
}

export async function publishProfile(client: GSVClient, expectedRevision: number): Promise<ProfileState> {
  return (await client.call("profile.publish", { expectedRevision })).profile;
}

export async function unpublishProfile(client: GSVClient, expectedRevision: number): Promise<ProfileState> {
  return (await client.call("profile.unpublish", { expectedRevision })).profile;
}
