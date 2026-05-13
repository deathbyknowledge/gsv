import { PackageBackendEntrypoint } from "@gsv/package/backend";
import {
  addFriend,
  createRequest,
  loadState,
  removeFriend,
  respondRequest,
  sendMessage,
  setFriendGrants,
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

  async createRequest(args: unknown): Promise<unknown> {
    return createRequest(args as never, this.kernel);
  }

  async respondRequest(args: unknown): Promise<unknown> {
    return respondRequest(args as never, this.kernel);
  }
}
