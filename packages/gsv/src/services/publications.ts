/** Only the deployment-authorized Kernel binding may register publication hosts. */
export interface PublicationDirectoryService {
  registerPublication(input: { installationId: string; siteId: string; slug: string }): Promise<{ origin: string }>;
}
