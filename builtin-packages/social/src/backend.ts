import { PackageBackendEntrypoint } from "@gsv/package/backend";
import {
  establishContact,
  loadState,
  republishPublicRecords,
  removeContact,
  sendMessage,
  updateMessageWorkflow,
} from "./backend/api";

export default class SocialBackend extends PackageBackendEntrypoint {
  async loadState(args: unknown): Promise<unknown> {
    return loadState(args as never, this.kernel);
  }

  async establishContact(args: unknown): Promise<unknown> {
    return establishContact(args as never, this.kernel);
  }

  async removeContact(args: unknown): Promise<unknown> {
    return removeContact(args as never, this.kernel);
  }

  async sendMessage(args: unknown): Promise<unknown> {
    return sendMessage(args as never, this.kernel);
  }

  async updateMessageWorkflow(args: unknown): Promise<unknown> {
    return updateMessageWorkflow(args as never, this.kernel);
  }

  async republishPublicRecords(): Promise<unknown> {
    return republishPublicRecords(this.kernel);
  }

  async updateMessageStatus(args: unknown): Promise<unknown> {
    return updateMessageWorkflow(args as never, this.kernel);
  }

  async republishIdentity(): Promise<unknown> {
    return republishPublicRecords(this.kernel);
  }
}
