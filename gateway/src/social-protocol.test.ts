import { describe, expect, it } from "vitest";
import {
  isSocialRemoteOperation,
  isSocialSyscallName,
  isSpaceGsvCollection,
  SOCIAL_REMOTE_OPERATIONS,
  SOCIAL_SYSCALLS,
  SPACE_GSV_COLLECTIONS,
  SPACE_GSV_AGENT_CARD,
  SPACE_GSV_INSTANCE,
  SPACE_GSV_PACKAGE_LIKE,
  SPACE_GSV_PROFILE,
  SPACE_GSV_STATUS,
  type SpaceGsvAgentCardRecord,
  type SpaceGsvInstanceRecord,
  type SpaceGsvPackageLikeRecord,
  type SpaceGsvProfileRecord,
  type SpaceGsvStatusRecord,
} from "@gsv/protocol/syscalls/social";

describe("social protocol contract", () => {
  it("uses the space.gsv record namespace", () => {
    expect(SPACE_GSV_COLLECTIONS).toEqual([
      "space.gsv.profile",
      "space.gsv.instance",
      "space.gsv.agent.card",
      "space.gsv.package.like",
      "space.gsv.status",
    ]);

    for (const collection of SPACE_GSV_COLLECTIONS) {
      expect(isSpaceGsvCollection(collection)).toBe(true);
    }

    expect(isSpaceGsvCollection("app.gsv.profile")).toBe(false);
    expect(isSpaceGsvCollection("gsv.space.profile")).toBe(false);
    expect(isSpaceGsvCollection("space.gsv.device")).toBe(false);
  });

  it("separates remote social operations from local social syscalls", () => {
    expect(SOCIAL_REMOTE_OPERATIONS).toContain("social.message.send");
    expect(SOCIAL_REMOTE_OPERATIONS).toContain("social.package.like.read");
    expect(SOCIAL_REMOTE_OPERATIONS).not.toContain("social.message.reply" as never);
    expect(SOCIAL_REMOTE_OPERATIONS).not.toContain("social.request.create" as never);

    expect(isSocialRemoteOperation("social.message.send")).toBe(true);
    expect(isSocialRemoteOperation("social.message.reply")).toBe(false);
    expect(isSocialRemoteOperation("social.inbound")).toBe(false);
    expect(isSocialRemoteOperation("social.sync.run")).toBe(false);
    expect(isSocialRemoteOperation("fs.read")).toBe(false);

    expect(SOCIAL_SYSCALLS).toContain("social.inbound");
    expect(SOCIAL_SYSCALLS).toContain("social.sync.run");
    expect(SOCIAL_SYSCALLS).toContain("social.identity.republish");
    expect(isSocialSyscallName("social.inbound")).toBe(true);
    expect(isSocialSyscallName("social.identity.republish")).toBe(true);
    expect(isSocialSyscallName("social.message.send")).toBe(true);
    expect(isSocialSyscallName("social.message.reply")).toBe(false);
    expect(isSocialSyscallName("repo.read")).toBe(false);
  });

  it("types the initial public records without device inventory", () => {
    const profile: SpaceGsvProfileRecord = {
      $type: SPACE_GSV_PROFILE,
      createdAt: "2026-05-12T12:00:00Z",
      displayName: "Hank",
      description: "Building GSV.",
      avatar: {
        $type: "blob",
        ref: { $link: "bafkreibm6jgkwx5ztbnodjrbazecinj63znepv3izjrb6ztscgzaemkhti" },
        mimeType: "image/png",
        size: 67,
      },
      avatarAlt: "Profile image",
      links: [{ label: "GSV", uri: "https://gsv.space" }],
    };

    const instance: SpaceGsvInstanceRecord = {
      $type: SPACE_GSV_INSTANCE,
      createdAt: "2026-05-12T12:00:00Z",
      endpoint: "https://gsv.example",
      protocolVersion: 1,
      serviceKey: {
        id: "did:example:hank#gsv-service",
        type: "Multikey",
        publicKeyMultibase: "z6Mk...",
      },
      acceptedSocialMethods: ["social.message.send"],
    };

    const agentCard: SpaceGsvAgentCardRecord = {
      $type: SPACE_GSV_AGENT_CARD,
      createdAt: "2026-05-12T12:00:00Z",
      acceptsMessages: true,
      topics: ["packages", "planning"],
    };

    const like: SpaceGsvPackageLikeRecord = {
      $type: SPACE_GSV_PACKAGE_LIKE,
      createdAt: "2026-05-12T12:00:00Z",
      subject: {
        kind: "gsv-package",
        name: "meeting-summarizer",
        repo: "alice/meeting-summarizer",
      },
    };

    const status: SpaceGsvStatusRecord = {
      $type: SPACE_GSV_STATUS,
      createdAt: "2026-05-12T12:00:00Z",
      text: "Working on social GSV.",
    };

    expect(profile.$type).toBe("space.gsv.profile");
    expect(instance).not.toHaveProperty("devices");
    expect(instance).not.toHaveProperty("deviceIds");
    expect(agentCard).not.toHaveProperty("syscalls");
    expect(like.subject.kind).toBe("gsv-package");
    expect(status.text).toContain("social");
  });
});
