import { describe, expect, it } from "vitest";
import {
  isSocialRemoteOperation,
  isSocialSyscallName,
  isSpaceGsvCollection,
  SOCIAL_REMOTE_OPERATIONS,
  SOCIAL_SYSCALLS,
  SPACE_GSV_COLLECTIONS,
  SPACE_GSV_CONTACT,
  SPACE_GSV_INSTANCE,
  SPACE_GSV_NEWS,
  SPACE_GSV_PACKAGE,
  SPACE_GSV_PACKAGE_RELEASE,
  SPACE_GSV_PROFILE,
  SPACE_GSV_USER,
  SPACE_GSV_VOUCH,
  type SpaceGsvContactRecord,
  type SpaceGsvInstanceRecord,
  type SpaceGsvNewsRecord,
  type SpaceGsvPackageRecord,
  type SpaceGsvPackageReleaseRecord,
  type SpaceGsvProfileRecord,
  type SpaceGsvUserRecord,
  type SpaceGsvVouchRecord,
} from "@gsv/protocol/syscalls/social";

describe("social protocol contract", () => {
  it("uses the space.gsv record namespace", () => {
    expect(SPACE_GSV_COLLECTIONS).toEqual([
      "space.gsv.profile",
      "space.gsv.instance",
      "space.gsv.user",
      "space.gsv.contact",
      "space.gsv.package",
      "space.gsv.package.release",
      "space.gsv.vouch",
      "space.gsv.news",
    ]);

    for (const collection of SPACE_GSV_COLLECTIONS) {
      expect(isSpaceGsvCollection(collection)).toBe(true);
    }

    expect(isSpaceGsvCollection("app.gsv.profile")).toBe(false);
    expect(isSpaceGsvCollection("gsv.space.profile")).toBe(false);
    expect(isSpaceGsvCollection("space.gsv.device")).toBe(false);
    expect(isSpaceGsvCollection("space.gsv.agent.card")).toBe(false);
    expect(isSpaceGsvCollection("space.gsv.package.like")).toBe(false);
    expect(isSpaceGsvCollection("space.gsv.status")).toBe(false);
  });

  it("separates remote social operations from local social syscalls", () => {
    expect(SOCIAL_REMOTE_OPERATIONS).toContain("social.message.send");
    expect(SOCIAL_REMOTE_OPERATIONS).toContain("social.user.read");
    expect(SOCIAL_REMOTE_OPERATIONS).toContain("social.contact.read");
    expect(SOCIAL_REMOTE_OPERATIONS).toContain("social.package.read");
    expect(SOCIAL_REMOTE_OPERATIONS).toContain("social.package.release.read");
    expect(SOCIAL_REMOTE_OPERATIONS).toContain("social.vouch.read");
    expect(SOCIAL_REMOTE_OPERATIONS).toContain("social.news.read");
    expect(SOCIAL_REMOTE_OPERATIONS).toContain("social.message.status.update");
    expect(SOCIAL_REMOTE_OPERATIONS).not.toContain("social.agent.card.read" as never);
    expect(SOCIAL_REMOTE_OPERATIONS).not.toContain("social.package.like.read" as never);
    expect(SOCIAL_REMOTE_OPERATIONS).not.toContain("social.status.read" as never);
    expect(SOCIAL_REMOTE_OPERATIONS).not.toContain("social.thread.create" as never);
    expect(SOCIAL_REMOTE_OPERATIONS).not.toContain("social.message.reply" as never);
    expect(SOCIAL_REMOTE_OPERATIONS).not.toContain("social.request.create" as never);

    expect(isSocialRemoteOperation("social.message.send")).toBe(true);
    expect(isSocialRemoteOperation("social.news.read")).toBe(true);
    expect(isSocialRemoteOperation("social.thread.create")).toBe(false);
    expect(isSocialRemoteOperation("social.message.reply")).toBe(false);
    expect(isSocialRemoteOperation("social.agent.card.read")).toBe(false);
    expect(isSocialRemoteOperation("social.package.like.read")).toBe(false);
    expect(isSocialRemoteOperation("social.inbound")).toBe(false);
    expect(isSocialRemoteOperation("social.sync.run")).toBe(false);
    expect(isSocialRemoteOperation("fs.read")).toBe(false);

    expect(SOCIAL_SYSCALLS).toContain("social.inbound");
    expect(SOCIAL_SYSCALLS).not.toContain("social.sync.run" as never);
    expect(SOCIAL_SYSCALLS).toContain("social.user.list");
    expect(SOCIAL_SYSCALLS).toContain("social.identity.republish");
    expect(SOCIAL_SYSCALLS).toContain("social.message.status.update");
    expect(SOCIAL_SYSCALLS).not.toContain("social.package.like.list" as never);
    expect(SOCIAL_SYSCALLS).not.toContain("social.agent.card.get" as never);
    expect(isSocialSyscallName("social.inbound")).toBe(true);
    expect(isSocialSyscallName("social.identity.republish")).toBe(true);
    expect(isSocialSyscallName("social.message.send")).toBe(true);
    expect(isSocialSyscallName("social.message.status.update")).toBe(true);
    expect(isSocialSyscallName("social.message.reply")).toBe(false);
    expect(isSocialSyscallName("repo.read")).toBe(false);
  });

  it("types the v1 public records without private routing state", () => {
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

    const user: SpaceGsvUserRecord = {
      $type: SPACE_GSV_USER,
      createdAt: "2026-05-12T12:00:00Z",
      username: "hank",
      displayName: "Hank",
      publicHandle: "hank.example.com",
      acceptsContact: true,
    };

    const contact: SpaceGsvContactRecord = {
      $type: SPACE_GSV_CONTACT,
      createdAt: "2026-05-12T12:00:00Z",
      subject: {
        did: "did:web:alice.example",
        handle: "alice.example",
        uri: "at://did:web:alice.example/space.gsv.profile/self",
      },
      label: "Alice",
      tags: ["collaborator"],
    };

    const pkg: SpaceGsvPackageRecord = {
      $type: SPACE_GSV_PACKAGE,
      createdAt: "2026-05-12T12:00:00Z",
      name: "meeting-summarizer",
      displayName: "Meeting Summarizer",
      source: {
        repo: "alice/meeting-summarizer",
        ref: "main",
      },
      tags: ["meetings"],
    };

    const release: SpaceGsvPackageReleaseRecord = {
      $type: SPACE_GSV_PACKAGE_RELEASE,
      createdAt: "2026-05-12T12:00:00Z",
      package: {
        uri: "at://did:web:hank.example/space.gsv.package/meeting-summarizer",
      },
      version: "1.0.0",
      title: "Initial release",
    };

    const vouch: SpaceGsvVouchRecord = {
      $type: SPACE_GSV_VOUCH,
      createdAt: "2026-05-12T12:00:00Z",
      subject: {
        uri: "at://did:web:hank.example/space.gsv.package/meeting-summarizer",
        cid: "bafkreibm6jgkwx5ztbnodjrbazecinj63znepv3izjrb6ztscgzaemkhti",
      },
      note: "Useful package.",
      tags: ["trusted"],
    };

    const news: SpaceGsvNewsRecord = {
      $type: SPACE_GSV_NEWS,
      createdAt: "2026-05-12T12:00:00Z",
      title: "Package update",
      text: "Meeting Summarizer 1.0.0 is available.",
      tags: ["release"],
      startsAt: "2026-05-12T12:00:00Z",
      subjects: [
        {
          uri: "at://did:web:hank.example/space.gsv.package.release/3kqonw7e3fs2a",
        },
      ],
    };

    expect(profile.$type).toBe("space.gsv.profile");
    expect(instance).not.toHaveProperty("devices");
    expect(instance).not.toHaveProperty("deviceIds");
    expect(profile).not.toHaveProperty("topics");
    expect(profile).not.toHaveProperty("humanEscalation");
    expect(profile).not.toHaveProperty("acceptsMessages");
    expect(user).not.toHaveProperty("devices");
    expect(user).not.toHaveProperty("acceptsMessages");
    expect(contact).not.toHaveProperty("grants");
    expect(contact).not.toHaveProperty("note");
    expect(pkg.name).toBe("meeting-summarizer");
    expect(release.package.uri).toContain("space.gsv.package");
    expect(vouch.subject.uri).toContain("space.gsv.package");
    expect(news).not.toHaveProperty("kind");
    expect(news.text).toContain("available");
  });
});
