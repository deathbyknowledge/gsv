import type {
  CreateNodeTokenArgs,
  CreateNodeTokenResult,
  DevicesState,
  LoadDevicesStateArgs,
  RevokeDeviceTokenArgs,
  UpdateDeviceDescriptionArgs,
} from "./features/devices/types";
import type {
  AdapterMutationResult,
  AdaptersState,
  AddMcpServerArgs,
  ConnectAdapterArgs,
  DisconnectAdapterArgs,
  McpServerMutationResult,
  McpState,
  RefreshMcpServerArgs,
  RemoveMcpServerArgs,
} from "./features/integrations/types";
import type {
  KillRuntimeProcessArgs,
  KillRuntimeProcessResult,
  RuntimeState,
} from "./features/runtime/types";
import type {
  AddCatalogRemoteArgs,
  CreatePackageArgs,
  CreatePackageResult,
  ImportPackageArgs,
  ImportPackageResult,
  LoadPackagesStateArgs,
  PackageIdArgs,
  PullPackageSourceArgs,
  PackagesState,
  RemoveCatalogRemoteArgs,
  SetPackagePublicArgs,
  StartPackageReviewResult,
} from "./features/packages/types";
import type {
  CreateSourceRepoArgs,
  CreateSourceRepoResult,
  DiffSourceRepoArgs,
  LoadSourceCommitsArgs,
  LoadSourcesStateArgs,
  PullSourceRepoArgs,
  SearchSourceRepoArgs,
  SetSourceRepoPublicArgs,
  SourceCommitsPage,
  SourceDiffResult,
  SourcesState,
  SourceSearchResult,
} from "./features/sources/types";
import type {
  AdministrationState,
  ApplyConfigArgs,
  ConsumeLinkCodeArgs,
  CreateAccessTokenArgs,
  CreateAccessTokenResult,
  CreateIdentityLinkArgs,
  RemoveIdentityLinkArgs,
  RevokeAccessTokenArgs,
} from "./features/settings/types";
import type {
  AgentContextResult,
  AgentMutationResult,
  AgentsState,
  CreateAgentArgs,
  CreateHumanArgs,
  LoadAgentContextArgs,
  SaveAgentContextArgs,
  SetAgentBehaviorArgs,
} from "./features/agents/types";

export interface GsvBackend {
  loadAdministrationState(args?: Record<string, never>): Promise<AdministrationState>;
  applyConfigEntries(args: ApplyConfigArgs): Promise<AdministrationState>;
  createAccessToken(args: CreateAccessTokenArgs): Promise<CreateAccessTokenResult>;
  revokeAccessToken(args: RevokeAccessTokenArgs): Promise<AdministrationState>;
  consumeIdentityLinkCode(args: ConsumeLinkCodeArgs): Promise<AdministrationState>;
  createIdentityLink(args: CreateIdentityLinkArgs): Promise<AdministrationState>;
  removeIdentityLink(args: RemoveIdentityLinkArgs): Promise<AdministrationState>;
  loadRuntimeState(): Promise<RuntimeState>;
  killRuntimeProcess(args: KillRuntimeProcessArgs): Promise<KillRuntimeProcessResult>;
  loadDevicesState(args: LoadDevicesStateArgs): Promise<DevicesState>;
  createDeviceNodeToken(args: CreateNodeTokenArgs): Promise<CreateNodeTokenResult>;
  revokeDeviceToken(args: RevokeDeviceTokenArgs): Promise<DevicesState>;
  updateDeviceDescription(args: UpdateDeviceDescriptionArgs): Promise<DevicesState>;
  loadAdaptersState(): Promise<AdaptersState>;
  connectAdapter(args: ConnectAdapterArgs): Promise<AdapterMutationResult>;
  disconnectAdapter(args: DisconnectAdapterArgs): Promise<AdapterMutationResult>;
  loadMcpState(): Promise<McpState>;
  addMcpServer(args: AddMcpServerArgs): Promise<McpServerMutationResult>;
  refreshMcpServer(args: RefreshMcpServerArgs): Promise<McpServerMutationResult>;
  removeMcpServer(args: RemoveMcpServerArgs): Promise<McpState>;
  loadPackagesState(args: LoadPackagesStateArgs): Promise<PackagesState>;
  syncPackages(): Promise<{ ok: boolean }>;
  importPackage(args: ImportPackageArgs): Promise<ImportPackageResult>;
  createPackage(args: CreatePackageArgs): Promise<CreatePackageResult>;
  addCatalogRemote(args: AddCatalogRemoteArgs): Promise<unknown>;
  removeCatalogRemote(args: RemoveCatalogRemoteArgs): Promise<unknown>;
  enablePackage(args: PackageIdArgs): Promise<unknown>;
  disablePackage(args: PackageIdArgs): Promise<unknown>;
  approvePackageReview(args: PackageIdArgs): Promise<unknown>;
  refreshPackage(args: PackageIdArgs): Promise<unknown>;
  pullPackage(args: PackageIdArgs): Promise<unknown>;
  pullPackageSource(args: PullPackageSourceArgs): Promise<{ ok: boolean }>;
  setPackagePublic(args: SetPackagePublicArgs): Promise<unknown>;
  startPackageReview(args: PackageIdArgs): Promise<StartPackageReviewResult>;
  loadSourcesState(args: LoadSourcesStateArgs): Promise<SourcesState>;
  loadSourceCommits(args: LoadSourceCommitsArgs): Promise<SourceCommitsPage>;
  searchSourceRepo(args: SearchSourceRepoArgs): Promise<SourceSearchResult>;
  diffSourceRepo(args: DiffSourceRepoArgs): Promise<SourceDiffResult>;
  pullSourceRepo(args: PullSourceRepoArgs): Promise<unknown>;
  setSourceRepoPublic(args: SetSourceRepoPublicArgs): Promise<unknown>;
  createSourceRepo(args: CreateSourceRepoArgs): Promise<CreateSourceRepoResult>;
  loadAgentsState(args?: Record<string, never>): Promise<AgentsState>;
  loadAgentContext(args: LoadAgentContextArgs): Promise<AgentContextResult>;
  saveAgentContext(args: SaveAgentContextArgs): Promise<AgentMutationResult>;
  setAgentBehavior(args: SetAgentBehaviorArgs): Promise<AgentMutationResult>;
  createAgent(args: CreateAgentArgs): Promise<AgentMutationResult>;
  createHuman(args: CreateHumanArgs): Promise<AgentMutationResult>;
}
