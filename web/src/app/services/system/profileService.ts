import type { GSVClient } from "@humansandmachines/gsv/client";
import type { ProfileFields, ProfileState } from "@humansandmachines/gsv/protocol";

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
