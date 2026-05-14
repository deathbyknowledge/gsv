import { PackageBackendEntrypoint } from "@gsv/package/backend";
import {
  addFriend,
  loadState,
  removeFriend,
  sendMessage,
  setFriendGrants,
  updateMessageStatus,
} from "./backend/api";

export default class SocialBackend extends PackageBackendEntrypoint {
  async loadState(args: unknown): Promise<unknown> {
    return loadState(args as never, this.kernel);
  }

  async addFriend(args: unknown): Promise<unknown> {
    return addFriend(args as never, this.kernel);
  }

  async setFriendGrants(args: unknown): Promise<unknown> {
    return setFriendGrants(args as never, this.kernel);
  }

  async removeFriend(args: unknown): Promise<unknown> {
    return removeFriend(args as never, this.kernel);
  }

  async sendMessage(args: unknown): Promise<unknown> {
    return sendMessage(args as never, this.kernel);
  }

  async updateMessageStatus(args: unknown): Promise<unknown> {
    return updateMessageStatus(args as never, this.kernel);
  }
}
